use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Spawn console tools without flashing a console window (GUI apps on
/// Windows give children a fresh console unless CREATE_NO_WINDOW is set).
pub fn hidden_cmd(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_CLIPS_DIR: &str = "D:/RECORDINGS/Clips";

fn default_game_exes() -> Vec<String> {
    [
        "rainbowsix.exe",
        "rainbowsix_dx11.exe",
        "rainbowsix_be.exe",
        "cs2.exe",
        "valorant-win64-shipping.exe",
        "fortniteclient-win64-shipping.exe",
        "league of legends.exe",
        "r5apex.exe",
        "r5apex_dx12.exe",
        "overwatch.exe",
        "marathon.exe",
        "uagame.exe",
        "cod.exe",
        "helldivers2.exe",
        "gta5.exe",
        "rocketleague.exe",
        "deadlock.exe",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn default_true() -> bool {
    true
}
fn default_obs_path() -> String {
    "C:/Program Files/obs-studio/bin/64bit/obs64.exe".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub clips_dir: String,
    pub auto_connect: bool,
    #[serde(default = "default_game_exes")]
    pub game_exes: Vec<String>,
    /// Exes the fullscreen auto-learn must never re-add to `game_exes`
    /// (removed games, and non-games that were wrongly auto-detected).
    #[serde(default)]
    pub game_blacklist: Vec<String>,
    #[serde(default = "default_true")]
    pub auto_launch_obs: bool,
    #[serde(default = "default_true")]
    pub auto_manage_buffer: bool,
    #[serde(default = "default_obs_path")]
    pub obs_path: String,
    #[serde(default = "default_hotkey_save")]
    pub hotkey_save: String,
    #[serde(default = "default_hotkey_short")]
    pub hotkey_short: String,
    #[serde(default = "default_short_secs")]
    pub short_clip_seconds: f64,
    /// 0 disables the cap.
    #[serde(default = "default_max_storage_gb")]
    pub max_storage_gb: f64,
    /// Off by default — only useful for CS2/Dota/LoL or log-trigger setups.
    #[serde(default)]
    pub auto_clip: bool,
    /// Seconds to wait after the last kill before saving (multikill window).
    #[serde(default = "default_auto_clip_delay")]
    pub auto_clip_delay_s: f64,
    /// Replay buffer length — how far back a clip reaches.
    #[serde(default = "default_replay_seconds")]
    pub replay_seconds: f64,
    /// Recording FPS (30/60/120).
    #[serde(default = "default_fps")]
    pub video_fps: u32,
    /// Output height; 0 = native canvas resolution.
    #[serde(default)]
    pub video_height: u32,
    /// Recording bitrate in Mbps.
    #[serde(default = "default_bitrate")]
    pub bitrate_mbps: f64,
    /// "auto" | "av1" | "hevc" | "h264" — mapped to this GPU's encoder.
    #[serde(default = "default_encoder")]
    pub encoder_pref: String,
}

fn default_replay_seconds() -> f64 {
    180.0
}
fn default_fps() -> u32 {
    60
}
fn default_bitrate() -> f64 {
    20.0
}
fn default_encoder() -> String {
    "auto".into()
}

fn default_auto_clip_delay() -> f64 {
    8.0
}

fn default_max_storage_gb() -> f64 {
    100.0
}

fn default_hotkey_save() -> String {
    "alt+f10".into()
}
fn default_hotkey_short() -> String {
    "shift+alt+f10".into()
}
fn default_short_secs() -> f64 {
    30.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            host: "localhost".into(),
            port: 4455,
            password: None,
            clips_dir: DEFAULT_CLIPS_DIR.into(),
            auto_connect: false,
            game_exes: default_game_exes(),
            game_blacklist: Vec::new(),
            auto_launch_obs: true,
            auto_manage_buffer: true,
            obs_path: default_obs_path(),
            hotkey_save: default_hotkey_save(),
            hotkey_short: default_hotkey_short(),
            short_clip_seconds: default_short_secs(),
            max_storage_gb: default_max_storage_gb(),
            auto_clip: false,
            auto_clip_delay_s: default_auto_clip_delay(),
            replay_seconds: default_replay_seconds(),
            video_fps: default_fps(),
            video_height: 0,
            bitrate_mbps: default_bitrate(),
            encoder_pref: default_encoder(),
        }
    }
}

fn favorites_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("favorites.json"))
}

#[tauri::command]
pub fn load_favorites(app: AppHandle) -> Result<Vec<String>, String> {
    let path = favorites_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_favorite(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut favs = load_favorites(app.clone())?;
    match favs.iter().position(|p| *p == path) {
        Some(i) => {
            favs.remove(i);
        }
        None => favs.push(path),
    }
    let raw = serde_json::to_string_pretty(&favs).map_err(|e| e.to_string())?;
    std::fs::write(favorites_path(&app)?, raw).map_err(|e| e.to_string())?;
    Ok(favs)
}

/// Recycle oldest non-favorite clips until the folder fits the cap.
/// Returns how many clips were removed.
pub fn enforce_storage_cap(app: &AppHandle) -> Result<u32, String> {
    let settings = load_settings_inner(app);
    if settings.max_storage_gb <= 0.0 {
        return Ok(0);
    }
    let cap_bytes = (settings.max_storage_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    let favorites = load_favorites(app.clone()).unwrap_or_default();

    let clips = list_clips(settings.clips_dir)?;
    let mut total: u64 = clips.iter().map(|c| c.size_bytes).sum();
    if total <= cap_bytes {
        return Ok(0);
    }

    let mut removed = 0;
    // list_clips is newest-first; walk from the oldest end.
    for clip in clips.iter().rev() {
        if total <= cap_bytes {
            break;
        }
        if favorites.contains(&clip.path) {
            continue;
        }
        if trash::delete(&clip.path).is_ok() {
            total -= clip.size_bytes;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn run_storage_cleanup(app: AppHandle) -> Result<u32, String> {
    enforce_storage_cap(&app)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Settings cache keyed by file mtime — three background loops read
/// settings every few seconds; the file changes only on user edits.
static SETTINGS_CACHE: std::sync::Mutex<Option<(u64, Settings)>> = std::sync::Mutex::new(None);

pub fn load_settings_inner(app: &AppHandle) -> Settings {
    let mtime = settings_path(app)
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    {
        let cache = SETTINGS_CACHE.lock().unwrap();
        if let Some((cached_mtime, settings)) = cache.as_ref() {
            if *cached_mtime == mtime {
                return settings.clone();
            }
        }
    }
    let settings = load_settings(app.clone()).unwrap_or_default();
    *SETTINGS_CACHE.lock().unwrap() = Some((mtime, settings.clone()));
    settings
}

/// Loads settings, creating and localizing them on the spot for a brand new
/// user (no settings.json yet): detected OBS path, a real clips folder that
/// actually exists on this machine, and the websocket password if OBS has
/// already minted one. Without this, a new user's first frontend boot would
/// race the backend's own async localization and briefly see bogus defaults
/// (e.g. a dev machine's leftover clips folder).
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let mut settings = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    } else {
        Settings::default()
    };
    crate::setup::localize_settings(&app, &mut settings);
    Ok(settings)
}

/// Reset to defaults, then immediately re-run the same machine-specific
/// detection first launch does (OBS path, clips folder, websocket password)
/// so the reset app is still fully set up, not just blanked.
#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Result<Settings, String> {
    let mut settings = Settings::default();
    crate::setup::localize_settings(&app, &mut settings);
    save_settings(app, settings.clone())?;
    Ok(settings)
}

/// Stop watching a game: drop it from `game_exes` and add it to the blacklist
/// so the fullscreen auto-learn won't silently re-add it next time it runs.
#[tauri::command]
pub fn remove_watched_game(app: AppHandle, exe: String) -> Result<Settings, String> {
    let mut settings = load_settings_inner(&app);
    let key = exe.to_lowercase();
    settings.game_exes.retain(|g| g.to_lowercase() != key);
    if !settings.game_blacklist.iter().any(|g| g.to_lowercase() == key) {
        settings.game_blacklist.push(exe);
    }
    save_settings(app, settings.clone())?;
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    // Custom clip folders must also be readable through the asset protocol
    // (thumbnails, waveforms, video playback).
    let _ = app
        .asset_protocol_scope()
        .allow_directory(&settings.clips_dir, true);
    let path = settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct ClipInfo {
    pub path: String,
    pub name: String,
    pub modified_ms: u64,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn list_clips(dir: String) -> Result<Vec<ClipInfo>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{dir}: {e}"))?;
    let mut clips: Vec<ClipInfo> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let ext = path.extension()?.to_str()?.to_lowercase();
            if ext != "mp4" && ext != "mkv" {
                return None;
            }
            let meta = e.metadata().ok()?;
            let modified_ms = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some(ClipInfo {
                name: path.file_name()?.to_string_lossy().to_string(),
                path: path.to_string_lossy().replace('\\', "/"),
                modified_ms,
                size_bytes: meta.len(),
            })
        })
        .collect();
    clips.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(clips)
}

pub fn ffmpeg_available() -> bool {
    find_ffmpeg().is_some()
}

/// Best available H264 encoder for this machine, probed once with a real
/// test encode: NVIDIA -> AMD -> Intel -> CPU fallback.
fn best_h264_encoder(ffmpeg: &PathBuf) -> String {
    static H264_ENCODER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H264_ENCODER
        .get_or_init(|| {
            for enc in ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"] {
                let ok = hidden_cmd(ffmpeg)
                    .args([
                        "-hide_banner",
                        "-f",
                        "lavfi",
                        "-i",
                        "nullsrc=s=256x256:d=0.2,format=nv12",
                        "-c:v",
                        enc,
                        "-frames:v",
                        "3",
                        "-f",
                        "null",
                    ])
                    .arg(if cfg!(windows) { "NUL" } else { "/dev/null" })
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if ok {
                    return enc.to_string();
                }
            }
            "libx264".into()
        })
        .clone()
}

fn find_ffmpeg() -> Option<PathBuf> {
    // PATH first, then winget's install location (PATH update needs re-login).
    if hidden_cmd("ffmpeg").arg("-version").output().is_ok() {
        return Some(PathBuf::from("ffmpeg"));
    }
    let packages = dirs_next(std::env::var("LOCALAPPDATA").ok()?)?;
    for entry in std::fs::read_dir(packages).ok()?.filter_map(|e| e.ok()) {
        if entry.file_name().to_string_lossy().starts_with("Gyan.FFmpeg") {
            for sub in walk_for_ffmpeg(&entry.path()) {
                return Some(sub);
            }
        }
    }
    None
}

fn dirs_next(local_appdata: String) -> Option<PathBuf> {
    let p = PathBuf::from(local_appdata).join("Microsoft\\WinGet\\Packages");
    p.exists().then_some(p)
}

fn walk_for_ffmpeg(root: &PathBuf) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.file_name().is_some_and(|n| n == "ffmpeg.exe") {
                    found.push(path);
                }
            }
        }
    }
    found
}

/// Move a clip to the Windows Recycle Bin (recoverable).
#[tauri::command]
pub fn delete_clip(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct BlackAnalysis {
    pub path: String,
    pub avg_luma: f64,
    pub is_black: bool,
}

/// Duration cache keyed by (path, mtime) — probing spawns a process, and
/// the library refreshes often while files rarely change.
static DURATION_CACHE: std::sync::Mutex<Option<std::collections::HashMap<String, (u64, f64)>>> =
    std::sync::Mutex::new(None);

fn clip_duration(ffmpeg: &PathBuf, path: &str) -> Result<f64, String> {
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    {
        let cache = DURATION_CACHE.lock().unwrap();
        if let Some(map) = cache.as_ref() {
            if let Some((cached_mtime, duration)) = map.get(path) {
                if *cached_mtime == mtime {
                    return Ok(*duration);
                }
            }
        }
    }
    let duration = probe_duration(ffmpeg, path)?;
    DURATION_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(Default::default)
        .insert(path.to_string(), (mtime, duration));
    Ok(duration)
}

fn probe_duration(ffmpeg: &PathBuf, path: &str) -> Result<f64, String> {
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    let result = hidden_cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            path,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&result.stdout)
        .trim()
        .parse()
        .map_err(|_| "could not read duration".to_string())
}

/// Seek to 10 evenly spaced points, decode exactly one frame at each,
/// average the luma. Below 20/255 everywhere = black clip (no game hooked).
/// Input-side seeking means we never decode more than 10 frames total.
#[tauri::command]
pub async fn analyze_black(path: String) -> Result<BlackAnalysis, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let duration = clip_duration(&ffmpeg, &path)?;

    let mut lumas: Vec<f64> = Vec::with_capacity(10);
    for i in 0..10 {
        let t = duration * (i as f64 + 0.5) / 10.0;
        let result = hidden_cmd(&ffmpeg)
            .args([
                "-hide_banner",
                "-ss",
                &format!("{t:.2}"),
                "-i",
                &path,
                "-frames:v",
                "1",
                "-vf",
                "signalstats,metadata=mode=print",
                "-an",
                "-f",
                "null",
            ])
            .arg(if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output()
            .map_err(|e| e.to_string())?;
        let log = String::from_utf8_lossy(&result.stderr);
        if let Some(luma) = log
            .lines()
            .filter_map(|l| l.split("signalstats.YAVG=").nth(1))
            .filter_map(|v| v.trim().parse::<f64>().ok())
            .next()
        {
            lumas.push(luma);
        }
    }

    if lumas.is_empty() {
        return Err("no frames analyzed".into());
    }
    let avg = lumas.iter().sum::<f64>() / lumas.len() as f64;
    Ok(BlackAnalysis {
        path,
        avg_luma: avg,
        // every sampled frame dark, not just the average
        is_black: lumas.iter().all(|l| *l < 20.0),
    })
}

#[derive(Serialize, Clone)]
pub struct ThumbInfo {
    pub thumb: String,
    pub duration: f64,
}

/// Generate missing thumbnails for every clip in `dir`, into `dir/.thumbs`.
/// Returns clip path -> { thumbnail path, duration seconds }.
#[tauri::command]
pub async fn gen_thumbnails(
    dir: String,
) -> Result<std::collections::HashMap<String, ThumbInfo>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let thumbs_dir = PathBuf::from(&dir).join(".thumbs");
    std::fs::create_dir_all(&thumbs_dir).map_err(|e| e.to_string())?;

    let mut map = std::collections::HashMap::new();
    for clip in list_clips(dir.clone())? {
        let duration = clip_duration(&ffmpeg, &clip.path).unwrap_or(0.0);
        let thumb = thumbs_dir.join(format!(
            "{}.jpg",
            PathBuf::from(&clip.name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
        ));
        if !thumb.exists() {
            let result = hidden_cmd(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-y",
                    "-ss",
                    &format!("{:.2}", duration / 2.0),
                    "-i",
                    &clip.path,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=320:-1",
                ])
                .arg(&thumb)
                .output()
                .map_err(|e| e.to_string())?;
            if !result.status.success() {
                continue;
            }
        }
        map.insert(
            clip.path,
            ThumbInfo {
                thumb: thumb.to_string_lossy().replace('\\', "/"),
                duration,
            },
        );
    }
    Ok(map)
}

/// Re-encode a clip to fit a size budget (Discord: 10MB free tier).
/// H264 for compatibility, hardware AMF encoder, size-targeted bitrate.
/// Number of audio streams in a media file.
fn audio_stream_count(ffmpeg: &PathBuf, path: &str) -> u32 {
    let ffprobe = ffmpeg.with_file_name("ffprobe.exe");
    hidden_cmd(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            path,
        ])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(1)
}

#[tauri::command]
pub fn list_audio_tracks(input: String) -> Result<u32, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    Ok(audio_stream_count(&ffmpeg, &input))
}

#[tauri::command]
pub async fn export_discord(
    input: String,
    target_mb: f64,
    start: f64,
    end: f64,
    audio_track: Option<u32>,
) -> Result<String, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let full = clip_duration(&ffmpeg, &input)?;
    let (start, end) = if end > start {
        (start.max(0.0), end.min(full))
    } else {
        (0.0, full)
    };
    let duration = end - start;
    if duration <= 0.0 {
        return Err("could not read duration".into());
    }

    const AUDIO_KBPS: f64 = 96.0;
    // 6% container overhead margin
    let total_kbits = target_mb * 8192.0 * 0.94;
    let video_kbps = (total_kbits / duration - AUDIO_KBPS).max(200.0);

    let input_path = PathBuf::from(&input);
    let stem = input_path
        .file_stem()
        .ok_or("bad input path")?
        .to_string_lossy();
    let output = input_path.with_file_name(format!("{stem}_discord.mp4"));

    // Cap height at 720p when the bitrate is starved, else keep 1080p.
    let scale = if video_kbps < 2500.0 {
        "scale=-2:720"
    } else {
        "scale=-2:1080"
    };

    // Pick one audio stream: 0 = mix, 1 = game, 2 = mic (OBS track layout).
    // Clamp to what the file actually has — old clips may be single-track.
    let tracks = audio_stream_count(&ffmpeg, &input);
    let track = audio_track.unwrap_or(0).min(tracks.saturating_sub(1));
    let audio_map = format!("0:a:{track}");

    let result = hidden_cmd(&ffmpeg)
        .args([
            "-hide_banner",
            "-y",
            "-ss",
            &format!("{start:.2}"),
            "-to",
            &format!("{end:.2}"),
            "-i",
            &input,
            "-map",
            "0:v:0",
            "-map",
            &audio_map,
            "-c:v",
            &best_h264_encoder(&ffmpeg),
            "-b:v",
            &format!("{video_kbps:.0}k"),
            "-maxrate",
            &format!("{:.0}k", video_kbps * 1.2),
            "-vf",
            scale,
            "-c:a",
            "aac",
            "-b:a",
            &format!("{AUDIO_KBPS:.0}k"),
            "-ac",
            "2",
            "-movflags",
            "+faststart",
        ])
        .arg(&output)
        .output()
        .map_err(|e| e.to_string())?;

    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    let out = output.to_string_lossy().replace('\\', "/");
    // Straight to Ctrl+V in Discord.
    let _ = copy_file_to_clipboard(&out);
    Ok(out)
}

/// Render an audio waveform strip for the timeline, cached next to thumbs.
#[tauri::command]
pub async fn gen_waveform(input: String) -> Result<String, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let input_path = PathBuf::from(&input);
    let dir = input_path.parent().ok_or("bad path")?.join(".thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!(
        "{}.wave.png",
        input_path.file_stem().ok_or("bad path")?.to_string_lossy()
    ));
    if !out.exists() {
        let result = hidden_cmd(&ffmpeg)
            .args([
                "-hide_banner",
                "-y",
                "-i",
                &input,
                "-filter_complex",
                "aformat=channel_layouts=mono,compand,showwavespic=s=1200x64:colors=#6b8bff",
                "-frames:v",
                "1",
            ])
            .arg(&out)
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).to_string());
        }
    }
    Ok(out.to_string_lossy().replace('\\', "/"))
}

/// Concatenate clips into one montage video (normalized 1080p60, AV1 archive
/// quality is overkill here — H264 for shareability).
#[tauri::command]
pub async fn export_montage(app: AppHandle, inputs: Vec<String>) -> Result<String, String> {
    if inputs.len() < 2 {
        return Err("select at least 2 clips".into());
    }
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let settings = load_settings_inner(&app);

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let output = PathBuf::from(&settings.clips_dir).join(format!("Montage_{stamp}.mp4"));

    let mut cmd = hidden_cmd(&ffmpeg);
    cmd.args(["-hide_banner", "-y"]);
    for input in &inputs {
        cmd.args(["-i", input]);
    }
    let mut filter = String::new();
    for i in 0..inputs.len() {
        filter.push_str(&format!(
            "[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
             pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1[v{i}];\
             [{i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a{i}];"
        ));
    }
    for i in 0..inputs.len() {
        filter.push_str(&format!("[v{i}][a{i}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=1[outv][outa]", inputs.len()));

    let result = cmd
        .args([
            "-filter_complex",
            &filter,
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            // Quality-based (CRF) x264 instead of a fixed 16 Mbps: the old
            // constant bitrate ballooned montages well past the combined size
            // of their source clips. CRF 21 tracks the content and keeps the
            // output near (usually under) the inputs' total size.
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
        ])
        .arg(&output)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    Ok(output.to_string_lossy().replace('\\', "/"))
}

/// Short looping GIF of the trim range, palette-optimized, on the clipboard
/// when done.
#[tauri::command]
pub async fn export_gif(input: String, start: f64, end: f64) -> Result<String, String> {
    let duration = end - start;
    if duration <= 0.0 {
        return Err("set a trim range first".into());
    }
    if duration > 15.0 {
        return Err("GIF range too long — keep it under 15s".into());
    }
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let input_path = PathBuf::from(&input);
    let stem = input_path.file_stem().ok_or("bad path")?.to_string_lossy();
    let output = input_path.with_file_name(format!("{stem}_gif.gif"));

    let result = hidden_cmd(&ffmpeg)
        .args([
            "-hide_banner",
            "-y",
            "-ss",
            &format!("{start:.2}"),
            "-to",
            &format!("{end:.2}"),
            "-i",
            &input,
            "-vf",
            "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        ])
        .arg(&output)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    let out = output.to_string_lossy().replace('\\', "/");
    let _ = copy_file_to_clipboard(&out);
    Ok(out)
}

/// Grab the frame at `time` as a PNG and put it on the clipboard.
#[tauri::command]
pub async fn export_frame(input: String, time: f64) -> Result<String, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let input_path = PathBuf::from(&input);
    let stem = input_path.file_stem().ok_or("bad path")?.to_string_lossy();
    let output = input_path.with_file_name(format!("{stem}_frame_{}.png", time as u64));

    let result = hidden_cmd(&ffmpeg)
        .args([
            "-hide_banner",
            "-y",
            "-ss",
            &format!("{time:.3}"),
            "-i",
            &input,
            "-frames:v",
            "1",
        ])
        .arg(&output)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    let out = output.to_string_lossy().replace('\\', "/");
    let _ = copy_file_to_clipboard(&out);
    Ok(out)
}

/// Rename a clip on disk. Returns the new path.
#[tauri::command]
pub fn rename_clip(path: String, new_name: String) -> Result<String, String> {
    let clean: String = new_name
        .chars()
        .filter(|c| !r#"<>:"/\|?*"#.contains(*c))
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        return Err("empty name".into());
    }
    let old = PathBuf::from(&path);
    let ext = old
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp4".into());
    let target = old.with_file_name(format!("{clean}.{ext}"));
    if target.exists() {
        return Err("a clip with that name already exists".into());
    }
    std::fs::rename(&old, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().replace('\\', "/"))
}

/// Put a file on the Windows clipboard as CF_HDROP, so Ctrl+V pastes the
/// file itself (Discord, Explorer, etc.).
pub fn copy_file_to_clipboard(path: &str) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    // CF_HDROP wants native separators and a double-NUL terminated list.
    let native = path.replace('/', "\\");
    let wide: Vec<u16> = native.encode_utf16().chain([0u16, 0u16]).collect();
    let header = std::mem::size_of::<DROPFILES>();
    let size = header + wide.len() * 2;

    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, size).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hglobal) as *mut u8;
        if ptr.is_null() {
            return Err("GlobalLock failed".into());
        }
        let drop_files = ptr as *mut DROPFILES;
        (*drop_files).pFiles = header as u32;
        (*drop_files).fWide = true.into();
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr.add(header), wide.len() * 2);
        let _ = GlobalUnlock(hglobal);

        OpenClipboard(None).map_err(|e| e.to_string())?;
        let _ = EmptyClipboard();
        let result = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglobal.0)));
        let _ = CloseClipboard();
        result.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace a clip with only its final `keep_last` seconds (lossless).
/// Used by the short-clip hotkey so quick moments don't cost 500MB.
pub async fn shorten_clip(path: &str, keep_last: f64) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let duration = clip_duration(&ffmpeg, path)?;
    if duration <= keep_last + 1.0 {
        return Ok(()); // already short enough
    }
    let start = duration - keep_last;
    let tmp = PathBuf::from(path).with_extension("short.mp4");

    let result = hidden_cmd(&ffmpeg)
        .args([
            "-hide_banner",
            "-y",
            "-ss",
            &format!("{start:.2}"),
            "-i",
            path,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(&tmp)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Lossless trim: stream copy, no re-encode. `start`/`end` in seconds.
#[tauri::command]
pub async fn trim_clip(input: String, start: f64, end: f64) -> Result<String, String> {
    if end <= start {
        return Err("end must be after start".into());
    }
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found â€” install still running?")?;

    let input_path = PathBuf::from(&input);
    let stem = input_path
        .file_stem()
        .ok_or("bad input path")?
        .to_string_lossy();
    let output = input_path
        .with_file_name(format!("{stem}_trim_{}-{}.mp4", start as u64, end as u64));

    let result = hidden_cmd(ffmpeg)
        .args([
            "-y",
            "-ss",
            &start.to_string(),
            "-to",
            &end.to_string(),
            "-i",
            &input,
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(&output)
        .output()
        .map_err(|e| e.to_string())?;

    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    Ok(output.to_string_lossy().replace('\\', "/"))
}
