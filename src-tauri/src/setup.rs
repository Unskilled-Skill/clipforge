//! First-run bootstrap and capture configuration: clips folder, ffmpeg, and
//! turning ClipForge's settings into the embedded engine's output config.

use serde::Serialize;
use tauri::AppHandle;

use crate::clips::hidden_cmd;
use crate::engine::{OutputConfig, ENGINE};

/// Restart the capture engine, or retry a failed start/download right away
/// (the old "Start OBS" button). The supervisor brings it back up on its
/// next tick with fresh settings.
#[tauri::command]
pub async fn launch_obs() -> Result<(), String> {
    crate::supervisor::RETRY_ENGINE_NOW.store(true, std::sync::atomic::Ordering::Relaxed);
    crate::obs::blocking(|| {
        ENGINE.shutdown();
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct RunningApp {
    pub exe: String,
    pub title: String,
}

/// Running apps with a visible window, for the "add a game from what's
/// running" picker (friendlier than browsing Program Files for an exe).
#[tauri::command]
pub fn list_running_apps() -> Vec<RunningApp> {
    crate::fullscreen::running_windowed_apps()
        .into_iter()
        .map(|a| RunningApp {
            exe: a.exe,
            title: a.title,
        })
        .collect()
}


#[derive(Serialize, Clone)]
pub struct SetupStatus {
    /// The embedded capture engine is up (field name kept for the frontend).
    pub obs_installed: bool,
    pub ffmpeg_installed: bool,
}

#[tauri::command]
pub fn setup_status() -> SetupStatus {
    SetupStatus {
        obs_installed: ENGINE.is_running(),
        ffmpeg_installed: crate::clips::ffmpeg_available(),
    }
}

/// Install a tool via winget; blocks until done. `id` is allow-listed.
#[tauri::command]
pub async fn winget_install(id: String) -> Result<(), String> {
    crate::clips::blocking(move || winget_install_blocking(id)).await
}

fn winget_install_blocking(id: String) -> Result<(), String> {
    let allowed = ["Gyan.FFmpeg"];
    if !allowed.contains(&id.as_str()) {
        return Err("unknown package".into());
    }
    let result = hidden_cmd("winget")
        .args([
            "install",
            "--id",
            &id,
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
        ])
        .output()
        .map_err(|e| format!("winget not available: {e}"))?;
    // 0 = installed, 0x8A15002B / "already installed" also fine
    if result.status.success() {
        return Ok(());
    }
    let out = String::from_utf8_lossy(&result.stdout).to_string();
    if out.to_lowercase().contains("already installed") {
        return Ok(());
    }
    Err(format!(
        "install failed: {}",
        if out.trim().is_empty() {
            String::from_utf8_lossy(&result.stderr).to_string()
        } else {
            out
        }
    ))
}


/// The encoders to try for a codec preference, best first, ending with CPU
/// x264 (always works). Vendor order matters on laptops/desktops with an
/// Intel iGPU next to a discrete card: the dGPU's encoder (NVENC, then AMF)
/// beats QuickSync, which OBS also logs as "app not on intel GPU, fall back
/// to old qsv encoder".
fn encoder_chain(pref: &str, available: &[String]) -> Vec<String> {
    // QuickSync's H.264 id ("obs_qsv11_v2") has no codec in its name.
    let is_codec = |id: &str, codec: &[&str]| {
        codec.iter().any(|c| id.contains(c))
            || (codec.contains(&"264") && id.contains("qsv") && !id.contains("hevc") && !id.contains("av1"))
    };
    let find = |codec: &[&str]| {
        ["nvenc", "amf", "qsv"].iter().find_map(|vendor| {
            available
                .iter()
                .find(|id| id.contains(vendor) && is_codec(id, codec))
                .cloned()
        })
    };
    let (av1, hevc, h264) = (find(&["av1"]), find(&["hevc", "265"]), find(&["264", "avc"]));
    let order = match pref {
        "av1" => vec![av1, hevc, h264],
        "hevc" => vec![hevc, h264],
        "h264" => vec![h264],
        // auto: AV1, then H.264. HEVC only before falling to the CPU: the
        // WebView preview often can't decode it (black frame, audio-only
        // bar), but a hardware encoder beats x264 eating game frames.
        _ => vec![av1, h264, hevc],
    };
    let mut chain: Vec<String> = order.into_iter().flatten().collect();
    chain.push(X264.into());
    chain
}

const X264: &str = "obs_x264";

/// First encoder in the preference's chain that hasn't failed.
fn pick_encoder_avoiding(pref: &str, available: &[String], failed: &[String]) -> String {
    encoder_chain(pref, available)
        .into_iter()
        .find(|e| !failed.contains(e))
        .unwrap_or_else(|| X264.into())
}

/// The encoder this machine should use, ignoring this session's failures.
fn pick_encoder(pref: &str, available: &[String]) -> Option<String> {
    Some(pick_encoder_avoiding(pref, available, &[]))
}

/// Encoders that failed to start this session (driver trouble, a codec the
/// GPU can't do at this resolution). Skipped until ClipForge restarts, in
/// case a driver update fixes them.
static FAILED_ENCODERS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
/// Set when recording fell back to another encoder; the supervisor tells
/// the user once.
pub static FALLBACK_NOTICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Settings of the last `apply_all`, to rebuild the output after a failure.
static LAST_SETTINGS: std::sync::Mutex<Option<crate::clips::Settings>> = std::sync::Mutex::new(None);

/// Record that `encoder` failed with `error`. False when there's nothing
/// left to fall back to (x264 failing is a real error).
fn give_up_on(encoder: &str, error: &str) -> bool {
    if encoder == X264 {
        return false;
    }
    let mut failed = FAILED_ENCODERS.lock().unwrap();
    if failed.iter().any(|e| e == encoder) {
        return false;
    }
    failed.push(encoder.to_string());
    crate::logs::line(&format!("encoder {encoder} failed ({error}); trying the next one"));
    true
}

fn friendly_encoder(id: &str) -> String {
    let codec = if id.contains("av1") {
        "AV1"
    } else if id.contains("hevc") || id.contains("265") {
        "HEVC"
    } else {
        "H.264"
    };
    let vendor = if id.contains("nvenc") {
        "NVIDIA "
    } else if id.contains("amf") {
        "AMD "
    } else if id.contains("qsv") {
        "Intel "
    } else {
        ""
    };
    if id == X264 { "CPU (x264)".into() } else { format!("{vendor}{codec}") }
}

/// Start the replay buffer, falling back down the encoder chain (AV1 ->
/// HEVC -> H.264 -> CPU x264) when the configured encoder won't start, so a
/// driver problem costs quality instead of every clip. Blocking.
pub fn start_buffer() -> Result<(), String> {
    let mut first_failed: Option<String> = None;
    loop {
        let error = match ENGINE.start_buffer() {
            Ok(()) => {
                if let Some(failed) = first_failed {
                    let now = ENGINE.info().output.map(|o| o.encoder).unwrap_or_default();
                    let msg = format!(
                        "{} encoding wouldn't start, so ClipForge is recording with {} instead.",
                        friendly_encoder(&failed),
                        friendly_encoder(&now)
                    );
                    crate::logs::line(&format!("encoder fallback: {failed} -> {now}"));
                    *FALLBACK_NOTICE.lock().unwrap() = Some(msg);
                }
                return Ok(());
            }
            Err(e) => e,
        };
        let encoder = ENGINE.info().output.map(|o| o.encoder).unwrap_or_default();
        let settings = LAST_SETTINGS.lock().unwrap().clone();
        // Only a start that libobs itself refused is the encoder's fault;
        // "engine not running" and the like aren't.
        let encoder_failed = error.starts_with("Couldn't start the replay buffer");
        let Some(settings) = settings.filter(|_| encoder_failed && give_up_on(&encoder, &error)) else {
            return Err(error);
        };
        first_failed.get_or_insert(encoder);
        apply_all(&settings)?;
    }
}

/// Bitrate to record at. `bitrate_mbps` 0 = auto: sized from the output
/// resolution, frame rate and codec so fast motion stays sharp without
/// wasting RAM. Baseline is 1080p60 in AV1/HEVC at 20 Mbps; H.264 needs
/// ~50% more for the same quality, and CPU x264 is capped so it can't
/// starve the game.
pub fn target_bitrate_mbps(settings: &crate::clips::Settings, height: u32, fps: u32, encoder: &str) -> f64 {
    if settings.bitrate_mbps > 0.0 {
        return settings.bitrate_mbps;
    }
    let base: f64 = match height {
        0..=720 => 12.0,
        721..=1080 => 20.0,
        1081..=1440 => 30.0,
        _ => 45.0,
    };
    let fps_factor = (fps.max(30) as f64 / 60.0).powf(0.7);
    let efficient = ["av1", "hevc", "265"].iter().any(|c| encoder.contains(c));
    let codec_factor = if efficient { 1.0 } else { 1.5 };
    let mbps = (base * fps_factor * codec_factor).round();
    if encoder == "obs_x264" { mbps.min(25.0) } else { mbps }
}

/// Encoder settings tuned for clips, merged into the profile's
/// recordEncoder.json (keys an encoder doesn't know are ignored by OBS):
/// - CBR: predictable size, so the RAM-backed replay buffer never truncates
/// - 1s keyframes: lossless trims cut on keyframes, so trims land within a
///   second and the editor seeks instantly (OBS's default is 4-10s)
/// - each vendor's quality preset instead of its speed-leaning default
fn encoder_tuning(encoder: &str, bitrate_mbps: f64) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::json;
    let mut s = serde_json::Map::new();
    s.insert("rate_control".into(), json!("CBR"));
    s.insert("bitrate".into(), json!((bitrate_mbps * 1000.0) as u64));
    s.insert("keyint_sec".into(), json!(1));
    if encoder.contains("nvenc") {
        s.insert("preset2".into(), json!("p5"));
        s.insert("tune".into(), json!("hq"));
        s.insert("multipass".into(), json!("qres"));
    } else if encoder.contains("amf") {
        s.insert("preset".into(), json!("quality"));
    } else if encoder.contains("qsv") {
        s.insert("target_usage".into(), json!("TU2"));
    } else if encoder == "obs_x264" {
        // Game and encoder share the CPU: fast preset, keep the game smooth.
        s.insert("preset".into(), json!("veryfast"));
        s.insert("profile".into(), json!("high"));
    }
    s
}

/// Encoder settings for the embedded engine's video encoder.
pub fn encoder_settings(encoder: &str, bitrate_kbps: u64) -> serde_json::Value {
    serde_json::Value::Object(encoder_tuning(encoder, bitrate_kbps as f64 / 1000.0))
}


/// Replay-buffer RAM cap sized from the actual bitrate so the oldest part is
/// never dropped: +25% covers CBR overshoot and keyframes; five AAC tracks
/// add ~0.12 MB/s.
fn replay_ram_mb(seconds: f64, bitrate_mbps: f64) -> i64 {
    let mb_per_sec = bitrate_mbps / 8.0 * 1.25 + 0.12;
    ((seconds * mb_per_sec).ceil() as i64).max(512)
}

/// The engine config ClipForge's settings ask for on this machine.
pub fn desired_config(settings: &crate::clips::Settings, encoders: &[String]) -> (OutputConfig, crate::engine::VideoConfig) {
    let video = crate::engine::video_config(settings.video_fps, settings.video_height);
    let failed = FAILED_ENCODERS.lock().unwrap().clone();
    let encoder = pick_encoder_avoiding(&settings.encoder_pref, encoders, &failed);
    let bitrate_mbps = target_bitrate_mbps(settings, video.out.1, video.fps, &encoder);
    let seconds = settings.replay_seconds.clamp(15.0, 900.0);
    let output = OutputConfig {
        encoder,
        bitrate_kbps: (bitrate_mbps * 1000.0) as u64,
        seconds: seconds as i64,
        ram_mb: replay_ram_mb(seconds, bitrate_mbps),
        dir: settings.clips_dir.clone(),
    };
    (output, video)
}

/// Output settings that couldn't be applied yet (the buffer was recording);
/// the supervisor retries once it's down.
pub static RELOAD_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Apply every ClipForge-managed capture setting to the running engine.
/// Blocking — call through `obs::blocking`.
pub fn apply_all(settings: &crate::clips::Settings) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if !ENGINE.is_running() {
        return Ok(());
    }
    let _ = std::fs::create_dir_all(&settings.clips_dir);
    *LAST_SETTINGS.lock().unwrap() = Some(settings.clone());
    let encoders = ENGINE.video_encoders();
    // An encoder libobs can't even create falls back right here; one that
    // fails only when recording starts is handled by `start_buffer`.
    let applied = loop {
        let (output, video) = desired_config(settings, &encoders);
        let encoder = output.encoder.clone();
        match ENGINE.configure(output, video) {
            Ok(applied) => break applied,
            Err(e) if e.starts_with("Encoder ") && give_up_on(&encoder, &e) => continue,
            Err(e) => return Err(e),
        }
    };
    RELOAD_PENDING.store(!applied, Ordering::Relaxed);
    ENGINE.set_audio(&crate::engine::AudioConfig::from_settings(settings))?;
    ENGINE.set_mic_noise_suppression(settings.mic_noise_suppression)?;
    Ok(())
}

/// Everything the Settings "Health" panel shows, gathered in one call: what
/// the engine is actually using (not what we asked for), plus frame health.
#[derive(Serialize)]
pub struct Diagnostics {
    pub obs_connected: bool,
    pub obs_version: Option<String>,
    pub obs_outdated: bool,
    pub output_mode: Option<String>,
    pub encoder: Option<String>,
    /// The encoder ClipForge would pick for this machine.
    pub best_encoder: Option<String>,
    pub rate_control: Option<String>,
    pub bitrate_kbps: Option<u64>,
    pub keyint_sec: Option<f64>,
    pub buffer_seconds: Option<u64>,
    pub buffer_ram_mb: Option<u64>,
    pub fps: Option<u32>,
    pub resolution: Option<String>,
    /// Settings saved but not yet applied (applies after the game).
    pub settings_pending: bool,
    pub health: crate::health::Health,
    pub disk_free_bytes: Option<u64>,
    pub ffmpeg_found: bool,
    /// Sync client the clips folder lives in (e.g. "Google Drive"), if any.
    pub clips_dir_cloud: Option<String>,
    /// Running with admin rights (GPU priority for capture).
    pub elevated: bool,
    pub mic_noise_suppression: bool,
}

#[tauri::command]
pub async fn obs_diagnostics(app: AppHandle) -> Result<Diagnostics, String> {
    let settings = crate::clips::load_settings_inner(&app);
    let (info, encoders) = crate::obs::blocking(|| Ok((ENGINE.info(), ENGINE.video_encoders()))).await?;
    let output = info.output.as_ref();
    Ok(Diagnostics {
        obs_connected: ENGINE.is_running(),
        obs_version: info.version.clone(),
        obs_outdated: false,
        output_mode: ENGINE.is_running().then(|| "Built-in".into()),
        encoder: output.map(|o| o.encoder.clone()),
        best_encoder: pick_encoder(&settings.encoder_pref, &encoders),
        rate_control: output.map(|_| "CBR".into()),
        bitrate_kbps: output.map(|o| o.bitrate_kbps),
        keyint_sec: output.map(|_| 1.0),
        buffer_seconds: output.map(|o| o.seconds as u64),
        buffer_ram_mb: output.map(|o| o.ram_mb as u64),
        fps: info.video.map(|v| v.fps),
        resolution: info.video.map(|v| format!("{}x{}", v.out.0, v.out.1)),
        settings_pending: RELOAD_PENDING.load(std::sync::atomic::Ordering::Relaxed),
        health: crate::health::latest(),
        disk_free_bytes: crate::clips::disk_free(settings.clips_dir.clone()).ok(),
        ffmpeg_found: crate::clips::ffmpeg_available(),
        clips_dir_cloud: crate::backup::cloud_synced_provider(&settings.clips_dir).map(String::from),
        elevated: crate::elevation::is_elevated(),
        mic_noise_suppression: settings.mic_noise_suppression,
    })
}

/// Fill in machine-specific defaults on first run: the user's Videos folder
/// for clips.
pub fn localize_settings(app: &AppHandle, settings: &mut crate::clips::Settings) -> bool {
    let mut changed = false;
    if !std::path::Path::new(&settings.clips_dir).exists() {
        let videos = std::env::var("USERPROFILE")
            .map(|p| format!("{}/Videos/Clips", p.replace('\\', "/")))
            .unwrap_or_else(|_| settings.clips_dir.clone());
        if std::fs::create_dir_all(&videos).is_ok() {
            settings.clips_dir = videos;
            changed = true;
        }
    }
    if changed {
        let _ = crate::clips::save_settings(app.clone(), settings.clone());
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    // Video encoders the OBS runtime registers on an AMD + Intel iGPU machine.
    fn amd_intel() -> Vec<String> {
        [
            "ffmpeg_svt_av1", "ffmpeg_aom_av1", "h264_texture_amf", "h265_texture_amf",
            "av1_texture_amf", "obs_qsv11_v2", "obs_qsv11_hevc", "obs_x264",
        ]
        .map(String::from)
        .into()
    }

    #[test]
    fn prefers_discrete_gpu_encoder() {
        let ids = amd_intel();
        assert_eq!(pick_encoder("auto", &ids).as_deref(), Some("av1_texture_amf"));
        assert_eq!(pick_encoder("hevc", &ids).as_deref(), Some("h265_texture_amf"));
        assert_eq!(pick_encoder("h264", &ids).as_deref(), Some("h264_texture_amf"));
        let intel_only: Vec<String> = ["obs_qsv11_v2", "obs_qsv11_hevc", "obs_x264"].map(String::from).into();
        assert_eq!(pick_encoder("h264", &intel_only).as_deref(), Some("obs_qsv11_v2"));
        assert_eq!(pick_encoder("auto", &intel_only).as_deref(), Some("obs_qsv11_v2"));
    }

    #[test]
    fn falls_back_down_the_encoder_chain() {
        let ids = amd_intel();
        assert_eq!(
            encoder_chain("av1", &ids),
            ["av1_texture_amf", "h265_texture_amf", "h264_texture_amf", "obs_x264"]
        );
        assert_eq!(
            encoder_chain("auto", &ids),
            ["av1_texture_amf", "h264_texture_amf", "h265_texture_amf", "obs_x264"]
        );
        let failed = ["av1_texture_amf".to_string()];
        assert_eq!(pick_encoder_avoiding("av1", &ids, &failed), "h265_texture_amf");
        let all_hw: Vec<String> = encoder_chain("av1", &ids).into_iter().filter(|e| e != X264).collect();
        assert_eq!(pick_encoder_avoiding("av1", &ids, &all_hw), X264);
        assert!(!give_up_on(X264, "boom"), "nothing below the CPU encoder");
    }

    #[test]
    fn replay_ram_covers_the_whole_buffer() {
        assert_eq!(replay_ram_mb(60.0, 8.0), 512);
        // 3 min at 50 Mbps must not be capped at a 25 Mbps-sized limit.
        assert!(replay_ram_mb(180.0, 50.0) >= 180 * 50 / 8);
    }

    #[test]
    fn auto_bitrate_scales() {
        let auto = crate::clips::Settings { bitrate_mbps: 0.0, ..Default::default() };
        assert_eq!(target_bitrate_mbps(&auto, 1080, 60, "av1_texture_amf"), 20.0);
        assert_eq!(target_bitrate_mbps(&auto, 1080, 60, "h264_texture_amf"), 30.0);
        assert!(target_bitrate_mbps(&auto, 1440, 144, "av1_texture_amf") > 30.0);
        assert!(target_bitrate_mbps(&auto, 2160, 60, "obs_x264") <= 25.0);
        let fixed = crate::clips::Settings { bitrate_mbps: 50.0, ..Default::default() };
        assert_eq!(target_bitrate_mbps(&fixed, 1080, 60, "av1_texture_amf"), 50.0);
    }
}
