//! Embedded capture engine: libobs running inside ClipForge.
//!
//! Replaces the external OBS Studio + obs-websocket setup. One scene holds
//! the game hook, and audio sources are routed to the six recording tracks
//! the export dropdown promises:
//!   1 = mix, 2 = game, 3 = voice chat, 4 = desktop, 5 = mic, 6 = other apps.
//! The mix is either everything (desktop + mic) or game + voice + mic only.
//! The replay buffer output encodes with this GPU's best hardware encoder.
//!
//! Every call here blocks (libobs runs on its own actor thread), so async
//! callers go through `tauri::async_runtime::spawn_blocking`.

use std::path::PathBuf;
use std::sync::Mutex;

use libobs_wrapper::{
    context::ObsContext,
    data::{
        output::{ObsOutputRef, ObsOutputTrait, ObsReplayBufferOutputRef},
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
const OTHER: u32 = 1 << 5;
const TRACKS: usize = 6;

/// What goes on the audio tracks (Settings › Split audio).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct AudioConfig {
    /// Mix = game + voice + mic, without the rest of the PC's sound.
    pub game_only_mix: bool,
    /// WASAPI endpoint ids; "default" follows Windows.
    pub mic_device: String,
    pub output_device: String,
    pub voice_apps: Vec<String>,
    pub other_apps: Vec<String>,
}

impl AudioConfig {
    pub fn from_settings(s: &crate::clips::Settings) -> Self {
        Self {
            game_only_mix: s.audio_mix == "game_voice_mic",
            mic_device: s.mic_device.clone(),
            output_device: s.output_device.clone(),
            voice_apps: s.voice_apps(),
            other_apps: s.other_apps.iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect(),
        }
    }
}

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
    /// Recorded track ids (0 = mix ... 5 = other apps), ascending.
    pub tracks: Vec<usize>,
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
    game_capture: ObsSceneItemRef<ObsSourceRef>,
    /// `window_capture` fallback for games the hook can't capture.
    window_capture: Option<(String, ObsSourceRef)>,
    /// Window id the capture currently targets (None = idle).
    target: Option<String>,
    game_audio: ObsSceneItemRef<ObsSourceRef>,
    /// One application-audio source per voice app / other app.
    vc_audio: Vec<ObsSourceRef>,
    other_audio: Vec<ObsSourceRef>,
    desktop: ObsSourceRef,
    mic: ObsSourceRef,
    audio: AudioConfig,
    /// Bumped per rebuild of the app sources, so new ones get fresh names.
    audio_generation: u32,
    /// RNNoise on the mic: strips keyboard clatter and fan hum. Toggled, not removed.
    mic_denoise: ObsFilterRef,
    replay: Option<ObsReplayBufferOutputRef>,
    /// Full-session recording: a file writer sharing the replay buffer's
    /// encoders (no extra encoding). Created once, reused per session.
    session: Option<ObsOutputRef>,
    /// File the running session writes to.
    session_path: Option<PathBuf>,
    output: Option<OutputConfig>,
    video: VideoConfig,
    game: Option<String>,
    active: bool,
}

pub struct Engine {
    inner: Mutex<Option<Inner>>,
    /// Mirrors `inner.is_some()` without the lock: startup, saves and
    /// buffer stops hold the lock for seconds, and UI status checks must
    /// never wait on them (a wait on the window thread froze the app).
    running: std::sync::atomic::AtomicBool,
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
pub static ENGINE: Engine = Engine { inner: Mutex::new(None), running: std::sync::atomic::AtomicBool::new(false), error: Mutex::new(None) };

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

fn fit_capture(item: &dyn SceneItemTrait, video: VideoConfig) -> Result<(), String> {
    use libobs_wrapper::{scenes::ObsTransformInfoBuilder, graphics::Vec2, enums::{ObsBoundsType, ObsAlignment}};
    let info = ObsTransformInfoBuilder::new()
        .set_pos(Vec2::new(0.0, 0.0))
        .set_alignment(ObsAlignment::LEFT | ObsAlignment::TOP)
        .set_bounds(Vec2::new(video.base.0 as f32, video.base.1 as f32))
        .set_bounds_type(ObsBoundsType::ScaleInner)
        .set_bounds_alignment(ObsAlignment::CENTER)
        .build(video.base.0, video.base.1);
    item.set_transform_info(&info).map_err(err)
}

fn output_active(replay: &ObsReplayBufferOutputRef) -> bool {
    replay.is_active().unwrap_or(false)
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
            // A game can own several windows. A console (BepInEx-modded
            // Valheim opens one before the game window) is never the one to
            // capture: skip it, so the target stays unresolved and is retried
            // until the real window exists.
            let mut ours: Vec<_> = windows
                .into_iter()
                .filter(|w| matches(&w.full_exe) && !is_console(w.class.as_deref()))
                .collect();
            // Then the one libobs flags as a game, then the largest.
            ours.sort_by_key(|w| (!w.is_game, std::cmp::Reverse(window_area(w.handle))));
            ours.into_iter().next().map(|w| w.obs_id)
        })
        // The helper skips windows whose process it can't open with VM_READ,
        // which anti-cheat (Vanguard) denies.
        .or_else(|| crate::fullscreen::obs_window_id(exe))
        .unwrap_or_else(|| format!("::{exe}"))
}

pub fn is_console(class: Option<&str>) -> bool {
    matches!(class, Some("ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS"))
}

fn window_area(hwnd: windows::Win32::Foundation::HWND) -> i64 {
    let mut r = windows::Win32::Foundation::RECT::default();
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut r);
    }
    (r.right - r.left) as i64 * (r.bottom - r.top) as i64
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

fn device_settings(device: &str) -> serde_json::Value {
    let id = if device.trim().is_empty() { "default" } else { device };
    serde_json::json!({ "device_id": id })
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
/// OBS plugins ClipForge never uses. libobs loads every DLL in the plugin
/// folder at startup; these only fail (no AJA card, CoreAudio absent) or
/// probe hardware nobody records from (webcams, VLC).
const UNUSED_PLUGINS: &[&str] = &["aja.dll", "vlc-video.dll", "win-dshow.dll", "coreaudio-encoder.dll"];
/// NVIDIA-only plugins, parked only while no NVIDIA card is present.
const NVIDIA_PLUGINS: &[&str] = &["obs-nvenc.dll", "nv-filters.dll"];

/// Move unneeded plugin DLLs out of libobs' plugin folder (the installer
/// puts them back on every update, so this runs at each start). NVIDIA
/// plugins come back if an NVIDIA card appears.
fn park_unused_plugins() {
    let plugins = runtime_dir().join("obs-plugins").join("64bit");
    let parked = runtime_dir().join("obs-plugins").join("unused");
    let nvidia = crate::gpu::has_nvidia();
    let _ = std::fs::create_dir_all(&parked);
    for name in UNUSED_PLUGINS.iter().chain(if nvidia { &[][..] } else { NVIDIA_PLUGINS }) {
        let src = plugins.join(name);
        if src.exists() {
            let dst = parked.join(name);
            let _ = std::fs::remove_file(&dst);
            let _ = std::fs::rename(&src, &dst);
        }
    }
    if nvidia {
        for name in NVIDIA_PLUGINS {
            let (src, dst) = (parked.join(name), plugins.join(name));
            if src.exists() && !dst.exists() {
                let _ = std::fs::rename(&src, &dst);
            }
        }
    }
}

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
        self.running.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Start libobs and build the capture scene (idempotent).
    pub fn ensure_started(&self, video: VideoConfig, audio: &AudioConfig) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        if guard.is_some() {
            return Ok(());
        }
        let config_dir = std::env::var("APPDATA")
            .map(|a| PathBuf::from(a).join("com.roche.clipforge").join("obs"))
            .unwrap_or_else(|_| runtime_dir().join("obs-config"));
        let _ = std::fs::create_dir_all(&config_dir);
        park_unused_plugins();
        crate::logs::line("capture engine: loading libobs");
        let mut ctx = StartupInfo::new()
            .set_video_info(video_info(video))
            .set_module_config_path(ObsPath::new(&config_dir.to_string_lossy()))
            .set_logger(Box::new(crate::logs::EngineLogger))
            .start()
            .map_err(|e| format!("Capture engine failed to start: {e}"))?;
        crate::logs::line("capture engine: libobs up, adding sources");
        let mut scene = ctx.scene("ClipForge", Some(0)).map_err(err)?;

        let game_capture = add_item(&mut scene, "game_capture", "AutoGame", game_capture_settings(None))?;
        fit_capture(&game_capture, video)?;
        // Hidden until it has a game to hook: an active hook aimed at nothing
        // logs "could not open process" every 2s.
        game_capture.set_visible(false).map_err(err)?;
        // Devices and mixer routing are set by `set_audio` below.
        let desktop = source(&mut scene, "wasapi_output_capture", "Desktop", device_settings(&audio.output_device))?;
        let mic = source(&mut scene, "wasapi_input_capture", "Mic", device_settings(&audio.mic_device))?;
        let denoise_settings = data(&scene, serde_json::json!({ "method": "rnnoise" }))?;
        let mic_denoise = ctx
            .obs_filter(FilterInfo::new("noise_suppress_filter", "Noise Suppression", Some(denoise_settings), None))
            .map_err(err)?;
        mic.apply_filter(&mic_denoise).map_err(err)?;
        set_enabled(&mic_denoise, false)?;
        // The game on its own track. Hidden while no game runs: application
        // capture of an exe that isn't running retries (and logs)
        // continuously; hiding deactivates it.
        let game_audio = add_item(&mut scene, "wasapi_process_output_capture", "GameAudio", process_audio_settings(NO_GAME))?;
        game_audio.set_visible(false).map_err(err)?;
        // Frozen/black picture watch (see picture.rs).
        let fps = video.fps;
        scene
            .runtime()
            .run_with_obs_result(move || unsafe { crate::picture::install(fps) })
            .map_err(err)?;

        *guard = Some(Inner {
            ctx,
            scene,
            game_capture,
            window_capture: None,
            target: None,
            game_audio,
            vc_audio: Vec::new(),
            other_audio: Vec::new(),
            desktop,
            mic,
            audio: AudioConfig::default(),
            audio_generation: 0,
            mic_denoise,
            replay: None,
            session: None,
            session_path: None,
            output: None,
            video,
            game: None,
            active: false,
        });
        self.running.store(true, std::sync::atomic::Ordering::Release);
        *self.error.lock().map_err(err)? = None;
        drop(guard);
        self.set_audio(audio)
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
            .inner_source()
            .update_settings(data(&inner.scene, game_capture_settings(hook_target))?)
            .map_err(err)?;
        inner.game_capture.set_visible(hook_target.is_some()).map_err(err)?;
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
            let item = add_item(&mut inner.scene, "window_capture", "WindowCapture", serde_json::json!({
                "window": window,
                "priority": PRIORITY_EXE,
                "cursor": true,
                // 2 = Windows Graphics Capture; BitBlt black-screens on most games.
                "method": 2,
            }))?;
            fit_capture(&item, inner.video)?;
            inner.window_capture = Some((exe.clone(), item.inner_source().clone()));
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

    /// Apply the audio setup: devices, what the mix holds, and one
    /// application source per voice / other app. Cheap when nothing changed.
    pub fn set_audio(&self, audio: &AudioConfig) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        if inner.audio == *audio && inner.audio_generation > 0 {
            return Ok(());
        }
        let first = inner.audio_generation == 0;
        let old = std::mem::replace(&mut inner.audio, audio.clone());
        if first || old.output_device != audio.output_device {
            inner.desktop.update_settings(data(&inner.scene, device_settings(&audio.output_device))?).map_err(err)?;
        }
        if first || old.mic_device != audio.mic_device {
            inner.mic.update_settings(data(&inner.scene, device_settings(&audio.mic_device))?).map_err(err)?;
        }
        // Everything: desktop sound already holds game, voice and other
        // apps, so only it (and the mic) feed the mix. Game-only: the
        // desktop track stays, but the mix is built from the game, voice
        // and mic sources, leaving music and notifications out.
        let to_mix = |on: bool| if on { MIX } else { 0 };
        set_mixers(&inner.desktop, DESKTOP | to_mix(!audio.game_only_mix))?;
        set_mixers(&inner.mic, MIC | MIX)?;
        set_mixers(inner.game_audio.inner_source(), GAME | to_mix(audio.game_only_mix))?;

        if first || old.voice_apps != audio.voice_apps || old.other_apps != audio.other_apps {
            for src in inner.vc_audio.drain(..).chain(inner.other_audio.drain(..)) {
                if let Ok(items) = inner.scene.items_for_source(&src) {
                    for item in items {
                        let _ = inner.scene.remove_item(item.as_ref());
                    }
                }
            }
            inner.audio_generation += 1;
            let generation = inner.audio_generation;
            for (i, exe) in audio.voice_apps.iter().enumerate() {
                let src = source(&mut inner.scene, "wasapi_process_output_capture", &format!("Voice {generation}-{i}"), process_audio_settings(exe))?;
                inner.vc_audio.push(src);
            }
            for (i, exe) in audio.other_apps.iter().enumerate() {
                let src = source(&mut inner.scene, "wasapi_process_output_capture", &format!("Other {generation}-{i}"), process_audio_settings(exe))?;
                inner.other_audio.push(src);
            }
        } else if inner.audio_generation == 0 {
            inner.audio_generation = 1;
        }
        for src in &inner.vc_audio {
            set_mixers(src, VC | to_mix(audio.game_only_mix))?;
        }
        for src in &inner.other_audio {
            set_mixers(src, OTHER)?;
        }
        crate::logs::line(&format!(
            "audio: mix={} voice={:?} other={:?} mic={} out={}",
            if audio.game_only_mix { "game+voice+mic" } else { "everything" },
            audio.voice_apps, audio.other_apps, audio.mic_device, audio.output_device
        ));
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
        if inner.replay.as_ref().is_some_and(output_active) {
            return Ok(false);
        }
        inner.replay = None;
        if inner.video != video {
            inner.ctx.reset_video(video_info(video)).map_err(err)?;
            inner.video = video;
            fit_capture(&inner.game_capture, video)?;
            if let Some((_, source)) = &inner.window_capture {
                for item in inner.scene.items_for_source(source).map_err(err)? {
                    fit_capture(item.as_ref(), video)?;
                }
            }
            crate::picture::set_fps(video.fps);
        }
        crate::logs::line(&format!("replay buffer: building ({} @ {} kbps, tracks {:?})", output.encoder, output.bitrate_kbps, output.tracks));
        inner.replay = Some(build_replay(&mut inner.ctx, &inner.scene, &output)?);
        crate::logs::line("replay buffer: built");
        inner.output = Some(output);
        Ok(true)
    }

    pub fn start_buffer(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        let replay = inner.replay.as_ref().ok_or("replay buffer not configured")?;
        if !output_active(replay) {
            replay.start().map_err(|e| {
                crate::logs::line(&format!("replay buffer failed to start: {e}"));
                format!("Couldn't start the replay buffer: {e}")
            })?;
            crate::logs::line(&format!("replay buffer started (game: {:?})", inner.game));
        }
        inner.active = true;
        Ok(())
    }

    /// Stop the buffer. Never hangs: if libobs doesn't confirm within 10s
    /// (a save still flushing, a stuck encoder), the output is force-stopped.
    pub fn stop_buffer(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let Some(inner) = guard.as_mut() else { return Ok(()) };
        // A session shares the buffer's encoders: it ends with the buffer.
        stop_session_inner(inner);
        inner.active = false;
        let Some(replay) = inner.replay.as_ref() else { return Ok(()) };
        if !output_active(replay) {
            return Ok(());
        }
        let ptr = replay.__native_handle();
        let runtime = replay.runtime().clone();
        let p = ptr.clone();
        runtime
            .run_with_obs_result(move || unsafe { libobs_wrapper::sys::obs_output_stop(p.raw_ptr_unchecked()) })
            .map_err(err)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while output_active(replay) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if output_active(replay) {
            crate::logs::line("replay buffer didn't stop in 10s; forcing it");
            runtime
                .run_with_obs_result(move || unsafe { libobs_wrapper::sys::obs_output_force_stop(ptr.raw_ptr_unchecked()) })
                .map_err(err)?;
        }
        crate::logs::line("replay buffer stopped");
        Ok(())
    }

    /// Start recording the whole session to `path` (fragmented MP4, so a
    /// crash still leaves a playable file), using the replay buffer's own
    /// encoders. The buffer must be recording.
    pub fn start_session(&self, path: &std::path::Path) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(err)?;
        let inner = guard.as_mut().ok_or("capture engine not running")?;
        if inner.session_path.is_some() {
            return Ok(());
        }
        let replay = inner
            .replay
            .as_ref()
            .filter(|r| output_active(r))
            .ok_or("the replay buffer isn't recording")?;
        let venc = replay.attached_video_encoder().map_err(err)?.ok_or("no video encoder")?;
        let aencs = replay.attached_audio_encoders().map_err(err)?;
        let settings = data(&inner.scene, serde_json::json!({
            "path": path.to_string_lossy().replace('/', "\\"),
            "muxer_settings": "movflags=frag_keyframe+empty_moov+default_base_moof",
        }))?;
        let out = match inner.session.as_ref() {
            Some(out) => {
                out.update_settings(settings).map_err(err)?;
                out.clone()
            }
            None => {
                let out = inner
                    .ctx
                    .output(OutputInfo::new("ffmpeg_muxer", "ClipForge Session", Some(settings), None))
                    .map_err(err)?;
                inner.session = Some(out.clone());
                out
            }
        };
        // The buffer's encoders change when its output is rebuilt: re-attach.
        out.set_video_encoder(venc).map_err(err)?;
        for (idx, enc) in aencs {
            out.set_audio_encoder(enc, idx).map_err(err)?;
        }
        out.start().map_err(|e| format!("Couldn't start the session recording: {e}"))?;
        inner.session_path = Some(path.to_path_buf());
        crate::logs::line(&format!("session recording started: {}", path.display()));
        Ok(())
    }

    /// End the running session (if any); its file joins `finished_sessions`.
    pub fn stop_session(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(inner) = guard.as_mut() {
                stop_session_inner(inner);
            }
        }
    }

    pub fn session_active(&self) -> bool {
        self.inner.lock().map(|g| g.as_ref().is_some_and(|i| i.session_path.is_some())).unwrap_or(false)
    }

    /// Session files that finished recording since the last call.
    pub fn finished_sessions(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *FINISHED_SESSIONS.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// Whether the buffer is really recording, asked of libobs rather than
    /// remembered: an output can stop on its own (encoder error), and a
    /// stale flag showed REC while nothing was recording.
    pub fn buffer_active(&self) -> bool {
        let Ok(mut guard) = self.inner.lock() else { return false };
        let Some(inner) = guard.as_mut() else { return false };
        let live = inner.replay.as_ref().is_some_and(output_active);
        if inner.active && !live {
            crate::logs::line("replay buffer stopped on its own");
        }
        inner.active = live;
        live
    }

    /// Flush the buffer to disk; blocks until the file is written.
    pub fn save(&self) -> Result<PathBuf, String> {
        // Clone the handle and release the lock: a save takes seconds and the
        // supervisor must keep ticking meanwhile.
        let replay = {
            let guard = self.inner.lock().map_err(err)?;
            let inner = guard.as_ref().ok_or("capture engine not running")?;
            if !inner.replay.as_ref().is_some_and(output_active) {
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
            .unwrap_or_else(|| inner.game_capture.inner_source().clone());
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
            active: inner.replay.as_ref().is_some_and(output_active),
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

    /// Drop the capture target so the next `set_game` re-applies it from
    /// scratch: the hook re-attaches (or the window capture is rebuilt).
    pub fn reset_target(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(inner) = guard.as_mut() {
                inner.target = None;
                inner.game = None;
                if let Some((_, old)) = inner.window_capture.take() {
                    if let Ok(items) = inner.scene.items_for_source(&old) {
                        for item in items {
                            let _ = inner.scene.remove_item(item.as_ref());
                        }
                    }
                }
                if let Ok(idle) = data(&inner.scene, game_capture_settings(None)) {
                    let _ = inner.game_capture.inner_source().update_settings(idle);
                }
                let _ = inner.game_capture.set_visible(false);
            }
        }
        crate::picture::reset();
    }

    /// Tear libobs down (app exit). Stops the buffer first.
    pub fn shutdown(&self) {
        let _ = self.stop_buffer();
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(inner) = guard.as_ref() {
                let _ = inner.scene.runtime().run_with_obs_result(|| unsafe { crate::picture::uninstall() });
            }
            guard.take();
            self.running.store(false, std::sync::atomic::Ordering::Release);
        }
    }
}

static FINISHED_SESSIONS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn stop_session_inner(inner: &mut Inner) {
    let Some(path) = inner.session_path.take() else { return };
    if let Some(out) = inner.session.as_ref() {
        if out.is_active().unwrap_or(false) {
            let _ = out.stop();
        }
    }
    crate::logs::line(&format!("session recording stopped: {}", path.display()));
    FINISHED_SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).push(path);
}

fn build_replay(ctx: &mut ObsContext, scene: &ObsSceneRef, cfg: &OutputConfig) -> Result<ObsReplayBufferOutputRef, String> {
    let settings = data(scene, serde_json::json!({
        "max_time_sec": cfg.seconds,
        "max_size_mb": cfg.ram_mb,
        "directory": cfg.dir.replace('/', "\\"),
        "format": "Replay %CCYY-%MM-%DD %hh-%mm-%ss",
        // mp4 plays in the in-app <video> preview (mkv doesn't) and holds
        // all six audio tracks. Written in one go at save time.
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

    // Only the wanted tracks get an encoder, packed into the file's first
    // streams; each is named after what it holds, so players and the editor
    // know a skipped track from a moved one.
    for (slot, &track) in cfg.tracks.iter().filter(|t| **t < TRACKS).enumerate() {
        let aenc = data(scene, serde_json::json!({ "rate_control": "CBR", "bitrate": 160 }))?;
        let name = crate::clips::TRACK_ROLES[track];
        let enc = libobs_wrapper::encoders::audio::ObsAudioEncoder::new_from_info(
            AudioEncoderInfo::new(ObsAudioEncoderType::FFMPEG_AAC, name, Some(aenc), None),
            track,
            replay.runtime().clone(),
        )
        .map_err(err)?;
        replay.set_audio_encoder(enc, slot).map_err(err)?;
    }
    Ok(replay)
}
