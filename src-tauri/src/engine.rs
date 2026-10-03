//! Embedded capture engine: libobs running inside ClipForge.
//!
//! Replaces the external OBS Studio + obs-websocket setup. One scene holds
//! the game hook, and audio sources are routed to the five recording tracks
//! the export dropdown promises:
//!   1 = full mix, 2 = game, 3 = voice chat, 4 = desktop, 5 = mic.
//! The replay buffer output encodes with this GPU's best hardware encoder.
//!
//! Every call here blocks (libobs runs on its own actor thread), so async
//! callers go through `tauri::async_runtime::spawn_blocking`.

use std::path::PathBuf;
use std::sync::Mutex;

use libobs_wrapper::{
    context::ObsContext,
    data::{
        output::{ObsOutputTrait, ObsReplayBufferOutputRef},
        video::ObsVideoInfoBuilder,
        object::ObsObjectTrait,
        ObsData,
    },
    encoders::{ObsAudioEncoderType, ObsVideoEncoderType},
    scenes::{ObsSceneItemRef, ObsSceneRef, SceneItemTrait},
    sources::{ObsFilterRef, ObsSourceRef, ObsSourceTrait},
    utils::{AudioEncoderInfo, FilterInfo, ObsPath, OutputInfo, SourceInfo, StartupInfo, VideoEncoderInfo},
};

/// Tracks as an OBS mixer bitmask (bit 0 = track 1).
const MIX: u32 = 1 << 0;
const GAME: u32 = 1 << 1;
const VC: u32 = 1 << 2;
const DESKTOP: u32 = 1 << 3;
const MIC: u32 = 1 << 4;
const TRACKS: usize = 5;

/// Placeholder target so the game hook idles until a game is detected.
const NO_GAME: &str = "clipforge-no-game.invalid";
/// OBS `enum window_priority`: 2 = match by executable.
const PRIORITY_EXE: i64 = 2;

/// What the replay buffer is built from. A change rebuilds the output, which
/// is only done while the buffer is down (it holds the moment the user may
/// be about to clip).
#[derive(Clone, PartialEq, Debug)]
pub struct OutputConfig {
    pub encoder: String,
    pub bitrate_kbps: u64,
    pub seconds: i64,
    pub ram_mb: i64,
    pub dir: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct VideoConfig {
    pub fps: u32,
    pub base: (u32, u32),
    pub out: (u32, u32),
}

struct Inner {
    ctx: ObsContext,
    scene: ObsSceneRef,
    game_capture: ObsSourceRef,
    /// `window_capture` fallback for games the hook can't capture.
    window_capture: Option<(String, ObsSourceRef)>,
    /// Window id the capture currently targets (None = idle).
    target: Option<String>,
    game_audio: ObsSceneItemRef<ObsSourceRef>,
    vc_audio: ObsSourceRef,
    _desktop: ObsSourceRef,
    _mic: ObsSourceRef,
    /// RNNoise on the mic: strips keyboard clatter and fan hum. Toggled, not removed.
    mic_denoise: ObsFilterRef,
    replay: Option<ObsReplayBufferOutputRef>,
    output: Option<OutputConfig>,
    video: VideoConfig,
    game: Option<String>,
    vc_exe: String,
    active: bool,
}

pub struct Engine {
    inner: Mutex<Option<Inner>>,
    /// Startup failure, shown to the user instead of a silent dead buffer.
    pub error: Mutex<Option<String>>,
}

/// Snapshot for the Health panel.
#[derive(Clone, Debug, Default)]
pub struct EngineInfo {
    pub version: Option<String>,
    pub output: Option<OutputConfig>,
    pub video: Option<VideoConfig>,
    pub active: bool,
    pub game_hooked: bool,
}

/// The one engine per process (libobs is process-global).
pub static ENGINE: Engine = Engine { inner: Mutex::new(None), error: Mutex::new(None) };

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn data(scene: &ObsSceneRef, json: serde_json::Value) -> Result<ObsData, String> {
    ObsData::from_json(&json.to_string(), scene.runtime().clone()).map_err(err)
}

fn add_item(scene: &mut ObsSceneRef, id: &str, name: &str, json: serde_json::Value) -> Result<ObsSceneItemRef<ObsSourceRef>, String> {
    let settings = data(scene, json)?;
    scene
        .add_new_source(SourceInfo::new(id, name, Some(settings), None))
        .map_err(err)
}

fn source(scene: &mut ObsSceneRef, id: &str, name: &str, json: serde_json::Value) -> Result<ObsSourceRef, String> {
    Ok(add_item(scene, id, name, json)?.inner_source().clone())
}

/// Enable/disable a filter (raw libobs: the wrapper has no setter).
fn set_enabled(filter: &ObsFilterRef, enabled: bool) -> Result<(), String> {
    let ptr = filter.__native_handle();
    filter
        .runtime()
        .run_with_obs_result(move || unsafe {
            libobs_wrapper::sys::obs_source_set_enabled(ptr.raw_ptr_unchecked(), enabled);
        })
        .map_err(err)
}

/// Route a source to the given tracks (raw libobs: the wrapper has no setter).
fn set_mixers(src: &ObsSourceRef, mask: u32) -> Result<(), String> {
    let ptr = src.__native_handle();
    src.runtime()
        .run_with_obs_result(move || unsafe {
            libobs_wrapper::sys::obs_source_set_audio_mixers(ptr.raw_ptr_unchecked(), mask);
        })
        .map_err(err)
}

/// OBS window id (`title:class:exe`, OBS-encoded) of `exe`'s main window.
/// Game capture won't hook from the exe alone (`::game.exe`): it needs the
/// real class and title. Falls back to the exe-only form, which the caller
/// retries until the window exists.
fn window_id(exe: &str) -> String {
    use libobs_window_helper::{get_all_windows, WindowSearchMode};
    let matches = |full: &str| {
        std::path::Path::new(full)
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(exe))
    };
    get_all_windows(WindowSearchMode::IncludeMinimized)
        .ok()
        .and_then(|windows| {
            let mut ours: Vec<_> = windows.into_iter().filter(|w| matches(&w.full_exe)).collect();
            // A game can own several windows (launcher splash, console);
            // the one libobs flags as a game is the one to hook.
            ours.sort_by_key(|w| !w.is_game);
            ours.into_iter().next().map(|w| w.obs_id)
        })
        .unwrap_or_else(|| format!("::{exe}"))
}

fn resolved(window: &str) -> bool {
    !window.starts_with("::")
}

fn game_capture_settings(window: Option<&str>) -> serde_json::Value {
    let idle = format!("::{NO_GAME}");
    serde_json::json!({
        "capture_mode": "window",
        "window": window.unwrap_or(&idle),
        "priority": PRIORITY_EXE,
        "capture_cursor": true,
        "anti_cheat_hook": true,
    })
}

fn process_audio_settings(exe: &str) -> serde_json::Value {
    serde_json::json!({ "window": format!("::{exe}"), "priority": PRIORITY_EXE })
}

/// Canvas = primary monitor; output = `height` scaled to the canvas aspect
/// (0 = native), rounded to even sizes the encoders accept.
pub fn video_config(fps: u32, height: u32) -> VideoConfig {
    let base = ObsVideoInfoBuilder::new().build();
    let (bw, bh) = (base.get_base_width(), base.get_base_height());
    let h = if height == 0 { bh } else { height.min(bh) };
    let w = ((h as f64 * bw as f64 / bh as f64 / 2.0).round() as u32) * 2;
    VideoConfig { fps: fps.clamp(30, 240), base: (bw, bh), out: (w, h) }
}

fn video_info(v: VideoConfig) -> libobs_wrapper::data::video::ObsVideoInfo {
    ObsVideoInfoBuilder::new()
        .fps_num(v.fps)
        .fps_den(1)
        .base_width(v.base.0)
        .base_height(v.base.1)
        .output_width(v.out.0)
        .output_height(v.out.1)
        .build()
}

/// Folder the OBS runtime lives in: next to our exe (the per-user install
/// dir is writable, so first-run download and updates need no elevation).
pub fn runtime_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Download/verify the OBS runtime. Must finish before the first libobs call
/// (obs.dll is delay-loaded). No-op when it's already in place.
/// `progress` gets (stage, 0..=100) as it goes: "download", then "extract".
pub async fn bootstrap(progress: impl Fn(&'static str, u32) + Send + Sync + 'static) -> Result<(), String> {
    use libobs_bootstrapper::{status_handler::ObsBootstrapStatusHandler, ObsBootstrapper, ObsBootstrapperOptions};
    if runtime_dir().join("obs.dll").exists() {
        return Ok(());
    }

    struct Progress<F> {
        report: F,
        last: Option<(&'static str, u32)>,
    }
    impl<F> std::fmt::Debug for Progress<F> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("Progress")
        }
    }
    impl<F: Fn(&'static str, u32) + Send + Sync> Progress<F> {
        // Whole percents only: the bootstrapper reports far more often.
        fn step(&mut self, stage: &'static str, fraction: f32) {
            let pct = (fraction.clamp(0.0, 1.0) * 100.0) as u32;
            if self.last != Some((stage, pct)) {
                self.last = Some((stage, pct));
                (self.report)(stage, pct);
            }
        }
    }
    impl<F: Fn(&'static str, u32) + Send + Sync> ObsBootstrapStatusHandler for Progress<F> {
        type Error = std::convert::Infallible;
        fn handle_downloading(&mut self, progress: f32, _message: String) -> Result<(), Self::Error> {
            self.step("download", progress);
            Ok(())
        }
        fn handle_extraction(&mut self, progress: f32, _message: String) -> Result<(), Self::Error> {
            self.step("extract", progress);
            Ok(())
        }
    }

    let options = ObsBootstrapperOptions::default().set_install_dir(runtime_dir());
    ObsBootstrapper::bootstrap_with_handler(&options, Box::new(Progress { report: progress, last: None }))
        .await
        .map(|_| ())
        .map_err(err)
}

impl Engine {
    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Start libobs and build the capture scene (idempotent).
    pub fn ensure_started(&self, video: VideoConfig, vc_exe: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        if guard.is_some() {
            return Ok(());
        }
        let config_dir = std::env::var("APPDATA")
            .map(|a| PathBuf::from(a).join("com.roche.clipforge").join("obs"))
            .unwrap_or_else(|_| runtime_dir().join("obs-config"));
        let _ = std::fs::create_dir_all(&config_dir);
        let mut ctx = StartupInfo::new()
            .set_video_info(video_info(video))
            .set_module_config_path(ObsPath::new(&config_dir.to_string_lossy()))
            .set_logger(Box::new(crate::logs::EngineLogger))
            .start()
            .map_err(|e| format!("Capture engine failed to start: {e}"))?;
        let mut scene = ctx.scene("ClipForge", Some(0)).map_err(err)?;

        let game_capture = source(&mut scene, "game_capture", "AutoGame", game_capture_settings(None))?;
        // Desktop audio: mix + desktop track. Mic: mix + mic track.
        let desktop = source(&mut scene, "wasapi_output_capture", "Desktop", serde_json::json!({ "device_id": "default" }))?;
        set_mixers(&desktop, MIX | DESKTOP)?;
        let mic = source(&mut scene, "wasapi_input_capture", "Mic", serde_json::json!({ "device_id": "default" }))?;
        set_mixers(&mic, MIX | MIC)?;
        let denoise_settings = data(&scene, serde_json::json!({ "method": "rnnoise" }))?;
        let mic_denoise = ctx
            .obs_filter(FilterInfo::new("noise_suppress_filter", "Noise Suppression", Some(denoise_settings), None))
            .map_err(err)?;
        mic.apply_filter(&mic_denoise).map_err(err)?;
        set_enabled(&mic_denoise, false)?;
        // Game and voice chat isolated on their own tracks. They already come
        // through desktop audio, so they stay out of the mix (no doubling).
        // Hidden while no game runs: application capture of an exe that isn't
        // running retries (and logs) continuously; hiding deactivates it.
        let game_audio = add_item(&mut scene, "wasapi_process_output_capture", "GameAudio", process_audio_settings(NO_GAME))?;
        set_mixers(game_audio.inner_source(), GAME)?;
        game_audio.set_visible(false).map_err(err)?;
        let vc_audio = source(&mut scene, "wasapi_process_output_capture", "VCAudio", process_audio_settings(vc_exe))?;
        set_mixers(&vc_audio, VC)?;

        *guard = Some(Inner {
            ctx,
            scene,
            game_capture,
            window_capture: None,
            target: None,
            game_audio,
            vc_audio,
            _desktop: desktop,
            _mic: mic,
            mic_denoise,
            replay: None,
            output: None,
            video,
            game: None,
            vc_exe: vc_exe.to_string(),
            active: false,
        });
        *self.error.lock().map_err(err)? = None;
        Ok(())
    }

    /// Point the hook and the game-audio track at `game` (None = idle).
    /// `window_capture` switches that game to WGC window capture instead of
    /// the hook (some games black-screen with one method or the other).
    /// Cheap to call every tick: it only touches libobs when the target
    /// changes, or until the game's window can be resolved.
    pub fn set_game(&self, game: Option<&str>, window_capture: bool) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        let want_window = game.filter(|_| window_capture).map(str::to_string);
        let same_game = inner.game.as_deref() == game
            && inner.window_capture.as_ref().map(|(g, _)| g) == want_window.as_ref();
        if same_game && inner.target.as_deref().is_none_or(resolved) {
            return Ok(());
        }
        let target = game.map(window_id);
        if same_game && target == inner.target {
            return Ok(()); // still unresolved; try again next tick
        }

        crate::logs::line(&format!("capture target: {game:?} -> {target:?} (window capture: {window_capture})"));
        let hook_target = if want_window.is_some() { None } else { target.as_deref() };
        inner
            .game_capture
            .update_settings(data(&inner.scene, game_capture_settings(hook_target))?)
            .map_err(err)?;
        if !same_game {
            if let Some(g) = game {
                inner
                    .game_audio
                    .inner_source()
                    .update_settings(data(&inner.scene, process_audio_settings(g))?)
                    .map_err(err)?;
            }
            inner.game_audio.set_visible(game.is_some()).map_err(err)?;
        }
        if let Some((_, old)) = inner.window_capture.take() {
            if let Ok(items) = inner.scene.items_for_source(&old) {
                for item in items {
                    let _ = inner.scene.remove_item(item.as_ref());
                }
            }
        }
        if let (Some(exe), Some(window)) = (&want_window, &target) {
            let src = source(&mut inner.scene, "window_capture", "WindowCapture", serde_json::json!({
                "window": window,
                "priority": PRIORITY_EXE,
                "cursor": true,
                // 2 = Windows Graphics Capture; BitBlt black-screens on most games.
                "method": 2,
            }))?;
            inner.window_capture = Some((exe.clone(), src));
        }
        inner.game = game.map(str::to_string);
        inner.target = target;
        Ok(())
    }

    pub fn set_mic_noise_suppression(&self, on: bool) -> Result<(), String> {
        let guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_ref().ok_or("capture engine not running")?;
        set_enabled(&inner.mic_denoise, on)
    }

    pub fn set_vc_exe(&self, vc_exe: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        if inner.vc_exe != vc_exe {
            inner
                .vc_audio
                .update_settings(data(&inner.scene, process_audio_settings(vc_exe))?)
                .map_err(err)?;
            inner.vc_exe = vc_exe.to_string();
        }
        Ok(())
    }

    /// Apply output/video settings. Returns false when they must wait for
    /// the buffer to stop (they'd interrupt a live buffer).
    pub fn configure(&self, output: OutputConfig, video: VideoConfig) -> Result<bool, String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        let same = inner.output.as_ref() == Some(&output) && inner.video == video && inner.replay.is_some();
        if same {
            return Ok(true);
        }
        if inner.active {
            return Ok(false);
        }
        inner.replay = None;
        if inner.video != video {
            inner.ctx.reset_video(video_info(video)).map_err(err)?;
            inner.video = video;
        }
        inner.replay = Some(build_replay(&mut inner.ctx, &inner.scene, &output)?);
        inner.output = Some(output);
        Ok(true)
    }

    pub fn start_buffer(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        let replay = inner.replay.as_ref().ok_or("replay buffer not configured")?;
        if !inner.active {
            replay.start().map_err(|e| format!("Couldn't start the replay buffer: {e}"))?;
            inner.active = true;
        }
        Ok(())
    }

    pub fn stop_buffer(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let Some(inner) = guard.as_mut() else { return Ok(()) };
        if let (true, Some(replay)) = (inner.active, inner.replay.as_ref()) {
            replay.stop().map_err(err)?;
        }
        inner.active = false;
        Ok(())
    }

    pub fn buffer_active(&self) -> bool {
        self.inner.lock().ok().and_then(|g| g.as_ref().map(|i| i.active)).unwrap_or(false)
    }

    /// Flush the buffer to disk; blocks until the file is written.
    pub fn save(&self) -> Result<PathBuf, String> {
        // Clone the handle and release the lock: a save takes seconds and the
        // supervisor must keep ticking meanwhile.
        let replay = {
            let guard = self.inner.lock().map_err(err)?;
            let inner = guard.as_ref().ok_or("capture engine not running")?;
            if !inner.active {
                return Err("Replay buffer isn't recording — make sure a game is detected.".into());
            }
            inner.replay.clone().ok_or("replay buffer not configured")?
        };
        replay.save_buffer().map(|p| p.to_path_buf()).map_err(|e| format!("Saving the clip failed: {e}"))
    }

    /// Cumulative frame counters: (render skipped, render total, encoder skipped, encoder total).
    pub fn frame_counters(&self) -> Option<(u32, u32, u32, u32)> {
        let guard = self.inner.lock().ok()?;
        let inner = guard.as_ref()?;
        inner
            .scene
            .runtime()
            .run_with_obs_result(|| unsafe {
                use libobs_wrapper::sys::*;
                let video = obs_get_video();
                (
                    obs_get_lagged_frames(),
                    obs_get_total_frames(),
                    video_output_get_skipped_frames(video),
                    video_output_get_total_frames(video),
                )
            })
            .ok()
    }

    pub fn info(&self) -> EngineInfo {
        let Ok(guard) = self.inner.lock() else { return EngineInfo::default() };
        let Some(inner) = guard.as_ref() else { return EngineInfo::default() };
        let hook = inner
            .window_capture
            .as_ref()
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| inner.game_capture.clone());
        let ptr = hook.__native_handle();
        let game_hooked = inner.game.is_some()
            && hook
                .runtime()
                .run_with_obs_result(move || unsafe { libobs_wrapper::sys::obs_source_get_width(ptr.raw_ptr_unchecked()) > 0 })
                .unwrap_or(false);
        EngineInfo {
            version: inner.ctx.get_version().ok(),
            output: inner.output.clone(),
            video: Some(inner.video),
            active: inner.active,
            game_hooked,
        }
    }

    /// Video encoder ids this machine's OBS runtime registered.
    pub fn video_encoders(&self) -> Vec<String> {
        let Ok(guard) = self.inner.lock() else { return Vec::new() };
        let Some(inner) = guard.as_ref() else { return Vec::new() };
        inner
            .scene
            .runtime()
            .run_with_obs_result(|| unsafe {
                use libobs_wrapper::sys::*;
                let mut ids = Vec::new();
                let mut idx = 0usize;
                let mut id: *const std::os::raw::c_char = std::ptr::null();
                while obs_enum_encoder_types(idx, &mut id) {
                    idx += 1;
                    if id.is_null() || obs_get_encoder_type(id) != obs_encoder_type_OBS_ENCODER_VIDEO {
                        continue;
                    }
                    ids.push(std::ffi::CStr::from_ptr(id).to_string_lossy().into_owned());
                }
                ids
            })
            .unwrap_or_default()
    }

    /// Tear libobs down (app exit). Stops the buffer first.
    pub fn shutdown(&self) {
        let _ = self.stop_buffer();
        if let Ok(mut guard) = self.inner.lock() {
            guard.take();
        }
    }
}

fn build_replay(ctx: &mut ObsContext, scene: &ObsSceneRef, cfg: &OutputConfig) -> Result<ObsReplayBufferOutputRef, String> {
    let settings = data(scene, serde_json::json!({
        "max_time_sec": cfg.seconds,
        "max_size_mb": cfg.ram_mb,
        "directory": cfg.dir.replace('/', "\\"),
        "format": "Replay %CCYY-%MM-%DD %hh-%mm-%ss",
        // mp4 plays in the in-app <video> preview (mkv doesn't) and holds
        // all five audio tracks. Written in one go at save time.
        "extension": "mp4",
        "allow_spaces": true,
    }))?;
    let replay = ctx
        .replay_buffer(OutputInfo::new("replay_buffer", "ClipForge Replay", Some(settings), None))
        .map_err(err)?;

    let venc = data(scene, crate::setup::encoder_settings(&cfg.encoder, cfg.bitrate_kbps))?;
    replay
        .create_and_set_video_encoder(VideoEncoderInfo::new(
            ObsVideoEncoderType::from(cfg.encoder.as_str()),
            "ClipForge Video",
            Some(venc),
            None,
        ))
        .map_err(|e| format!("Encoder {} unavailable: {e}", cfg.encoder))?;

    for track in 0..TRACKS {
        let aenc = data(scene, serde_json::json!({ "rate_control": "CBR", "bitrate": 160 }))?;
        replay
            .create_and_set_audio_encoder(
                AudioEncoderInfo::new(ObsAudioEncoderType::FFMPEG_AAC, format!("ClipForge Audio {}", track + 1), Some(aenc), None),
                track,
            )
            .map_err(err)?;
    }
    Ok(replay)
}
