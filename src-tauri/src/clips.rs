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
use tauri::{AppHandle, Emitter, Manager};

/// Run an ffmpeg command (output path already added) streaming its
/// `-progress pipe:1` reports as `export-progress` events, so long renders
/// show a real percentage instead of an indeterminate spinner. Call from a
/// blocking context (`spawn_blocking`) — reads the pipe synchronously.
fn run_ffmpeg_with_progress(
    app: &AppHandle,
    mut cmd: Command,
    total_secs: f64,
    label: &str,
) -> Result<(), String> {
    use std::io::BufRead;
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(stdout) = child.stdout.take() {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            // ffmpeg quirk: out_time_ms is microseconds too (same as out_time_us).
            let us = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="));
            if let Some(us) = us {
                if let Ok(us) = us.trim().parse::<f64>() {
                    let pct = ((us / 1_000_000.0) / total_secs.max(0.1) * 100.0).clamp(0.0, 100.0);
                    let _ = app.emit("export-progress", serde_json::json!({ "label": label, "pct": pct }));
                }
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

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
    /// Voice-chat app whose audio gets its own recording track (Discord etc.).
    #[serde(default = "default_vc_exe")]
    pub vc_exe: String,
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

fn default_vc_exe() -> String {
    "discord.exe".into()
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
            vc_exe: default_vc_exe(),
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

/// Open Explorer with the clip highlighted. A plain backend spawn instead of
/// the opener plugin's reveal, which needs a static path scope — the clips
/// folder is user-configurable so no scope could cover it.
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    hidden_cmd("explorer.exe")
        .arg(format!("/select,{}", path.replace('/', "\\")))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Sidecar with kill timestamps (seconds into the clip), written when an
/// auto-clip trigger knows where the kills landed. Lives in `.thumbs` next
/// to the other derived files so it's swept with them.
pub fn markers_path(clip: &str) -> Option<PathBuf> {
    let p = PathBuf::from(clip);
    let stem = p.file_stem()?.to_string_lossy().to_string();
    Some(p.parent()?.join(".thumbs").join(format!("{stem}.markers.json")))
}

pub fn read_markers(clip: &str) -> Vec<f64> {
    markers_path(clip)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_markers(clip: &str, markers: &[f64]) {
    let Some(path) = markers_path(clip) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string(markers) {
        let _ = std::fs::write(path, raw);
    }
}

/// Kill timestamps for a clip, seconds from its start. Empty when the clip
/// wasn't auto-clipped (or predates markers).
#[tauri::command]
pub fn load_markers(input: String) -> Vec<f64> {
    read_markers(&input)
}

/// Free bytes on the volume holding `dir` — the clips drive filling up makes
/// OBS silently fail to save, so the frontend warns before that happens.
#[tauri::command]
pub fn disk_free(dir: String) -> Result<u64, String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut free = 0u64;
    unsafe {
        GetDiskFreeSpaceExW(&HSTRING::from(dir.as_str()), Some(&mut free), None, None)
            .map_err(|e| e.to_string())?;
    }
    Ok(free)
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
    // Write-then-rename so a crash mid-write can't leave settings.json
    // half-written (which would silently reset every setting on next boot).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
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
    trash::delete(&path).map_err(|e| e.to_string())?;
    // Sweep the cached thumbnail/waveforms too, or they pile up forever.
    let p = PathBuf::from(&path);
    if let (Some(dir), Some(stem)) = (p.parent(), p.file_stem()) {
        let thumbs = dir.join(".thumbs");
        let stem = stem.to_string_lossy();
        let _ = std::fs::remove_file(thumbs.join(format!("{stem}.jpg")));
        let _ = std::fs::remove_file(thumbs.join(format!("{stem}.wave.png")));
        let _ = std::fs::remove_file(thumbs.join(format!("{stem}.markers.json")));
        for i in 0..6 {
            let _ = std::fs::remove_file(thumbs.join(format!("{stem}.wave{i}.png")));
        }
    }
    Ok(())
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

/// Duration of a clip for callers outside this module (marker math).
pub fn probe_clip_duration(path: &str) -> Result<f64, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    clip_duration(&ffmpeg, path)
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

    // Per-clip work (duration probe + thumbnail render) runs in parallel
    // batches — a cold library of N clips costs ~N/8 probe round-trips
    // instead of N. Existing thumbnails and cached durations short-circuit,
    // so a warm refresh spawns almost nothing.
    let clips = list_clips(dir.clone())?;
    let mut map = std::collections::HashMap::new();
    for batch in clips.chunks(8) {
        let handles: Vec<_> = batch
            .iter()
            .map(|clip| {
                let ffmpeg = ffmpeg.clone();
                let path = clip.path.clone();
                let thumb = thumbs_dir.join(format!(
                    "{}.jpg",
                    PathBuf::from(&clip.name)
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
                std::thread::spawn(move || {
                    let duration = clip_duration(&ffmpeg, &path).unwrap_or(0.0);
                    if !thumb.exists() {
                        let ok = hidden_cmd(&ffmpeg)
                            .args([
                                "-hide_banner",
                                "-y",
                                "-ss",
                                &format!("{:.2}", duration / 2.0),
                                "-i",
                                &path,
                                "-frames:v",
                                "1",
                                "-vf",
                                "scale=320:-1",
                            ])
                            .arg(&thumb)
                            .output()
                            .map(|o| o.status.success())
                            .unwrap_or(false);
                        if !ok {
                            return None;
                        }
                    }
                    Some((
                        path,
                        ThumbInfo {
                            thumb: thumb.to_string_lossy().replace('\\', "/"),
                            duration,
                        },
                    ))
                })
            })
            .collect();
        for handle in handles {
            if let Ok(Some((path, info))) = handle.join() {
                map.insert(path, info);
            }
        }
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
    app: AppHandle,
    input: String,
    target_mb: f64,
    start: f64,
    end: f64,
    // (track index, gain) pairs — gain 1.0 = unchanged, 0.5 = half, 2.0 = double.
    audio_tracks: Option<Vec<(u32, f32)>>,
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

    // Tracks the user wants kept, each with its export gain (OBS layout:
    // 0=mix, 1=game, 2=vc, 3=desktop, 4=mic). Clamp to what the file actually
    // has — old clips are single-track — dedupe, fall back to the full mix.
    let count = audio_stream_count(&ffmpeg, &input);
    let mut keep: Vec<(u32, f32)> = audio_tracks
        .unwrap_or_default()
        .into_iter()
        .filter(|(t, _)| *t < count)
        .map(|(t, g)| (t, g.clamp(0.0, 4.0)))
        .collect();
    keep.sort_by_key(|(t, _)| *t);
    keep.dedup_by_key(|(t, _)| *t);
    if keep.is_empty() {
        keep.push((0, 1.0));
    }

    // One filter graph does both the video scale and the audio: each kept
    // track gets its gain applied, then multiple get summed with amix
    // (normalize=0 keeps the chosen levels instead of re-normalizing).
    let audio_filter = if keep.len() == 1 {
        let (t, g) = keep[0];
        format!("[0:a:{t}]volume={g:.2}[aout]")
    } else {
        let mut chains = String::new();
        for (idx, (t, g)) in keep.iter().enumerate() {
            chains.push_str(&format!("[0:a:{t}]volume={g:.2}[ga{idx}];"));
        }
        let labels: String = (0..keep.len()).map(|i| format!("[ga{i}]")).collect();
        format!("{chains}{labels}amix=inputs={}:normalize=0[aout]", keep.len())
    };
    let filter_complex = format!("[0:v:0]{scale}[vout];{audio_filter}");

    let mut cmd = hidden_cmd(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-y",
        "-nostats",
        "-progress",
        "pipe:1",
        "-ss",
        &format!("{start:.2}"),
        "-to",
        &format!("{end:.2}"),
        "-i",
        &input,
        "-filter_complex",
        &filter_complex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        &best_h264_encoder(&ffmpeg),
        "-b:v",
        &format!("{video_kbps:.0}k"),
        "-maxrate",
        &format!("{:.0}k", video_kbps * 1.2),
        "-c:a",
        "aac",
        "-b:a",
        &format!("{AUDIO_KBPS:.0}k"),
        "-ac",
        "2",
        "-movflags",
        "+faststart",
    ])
    .arg(&output);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg_with_progress(&app2, cmd, duration, "export")
    })
    .await
    .map_err(|e| e.to_string())??;
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

#[derive(Serialize)]
pub struct TrackWave {
    pub track: u32,
    pub waveform: String,
}

/// One waveform image per audio stream, so the editor can show each track
/// (mix / game / voice / desktop / mic) stacked with its own keep-checkbox.
#[tauri::command]
pub async fn gen_waveforms(input: String) -> Result<Vec<TrackWave>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let count = audio_stream_count(&ffmpeg, &input);
    let input_path = PathBuf::from(&input);
    let dir = input_path.parent().ok_or("bad path")?.join(".thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = input_path.file_stem().ok_or("bad path")?.to_string_lossy().to_string();

    // All missing tracks render concurrently — each is its own ffmpeg
    // process, so this cuts editor-open latency to the slowest single track
    // instead of the sum of all five.
    let jobs: Vec<(u32, PathBuf)> = (0..count)
        .map(|i| (i, dir.join(format!("{stem}.wave{i}.png"))))
        .collect();
    let handles: Vec<_> = jobs
        .iter()
        .filter(|(_, wpath)| !wpath.exists())
        .map(|(i, wpath)| {
            let (i, wpath, ffmpeg, input) = (*i, wpath.clone(), ffmpeg.clone(), input.clone());
            std::thread::spawn(move || {
                // Per-track failure is non-fatal — a silent track just yields
                // a flat image, and we still want the rest of the tracks.
                let _ = hidden_cmd(&ffmpeg)
                    .args([
                        "-hide_banner",
                        "-y",
                        "-i",
                        &input,
                        "-filter_complex",
                        &format!(
                            "[0:a:{i}]aformat=channel_layouts=mono,compand,showwavespic=s=1200x40:colors=#6b8bff"
                        ),
                        "-frames:v",
                        "1",
                    ])
                    .arg(&wpath)
                    .output();
            })
        })
        .collect();
    for handle in handles {
        let _ = handle.join();
    }

    let mut out = Vec::new();
    for (i, wpath) in jobs {
        if wpath.exists() {
            out.push(TrackWave {
                track: i,
                waveform: wpath.to_string_lossy().replace('\\', "/"),
            });
        }
    }
    Ok(out)
}

/// One montage entry: a clip plus the cut to take from it. `end <= start`
/// means "use the whole clip" (clips without a saved trim range).
#[derive(Deserialize)]
pub struct MontageSeg {
    pub path: String,
    pub start: f64,
    pub end: f64,
}

/// Concatenate clip segments into one montage video (normalized 1080p60, AV1
/// archive quality is overkill here — H264 for shareability). Each clip's
/// trim range is applied input-side (`-ss/-to` before `-i`), so only the
/// selected cut is decoded at all.
#[tauri::command]
pub async fn export_montage(app: AppHandle, inputs: Vec<MontageSeg>) -> Result<String, String> {
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

    // Total output length for the progress percentage.
    let total_secs: f64 = inputs
        .iter()
        .map(|seg| {
            let full = clip_duration(&ffmpeg, &seg.path).unwrap_or(0.0);
            if seg.end > seg.start {
                (seg.end.min(full) - seg.start.max(0.0)).max(0.0)
            } else {
                full
            }
        })
        .sum();

    let mut cmd = hidden_cmd(&ffmpeg);
    cmd.args(["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"]);
    for seg in &inputs {
        if seg.end > seg.start {
            cmd.args([
                "-ss",
                &format!("{:.2}", seg.start.max(0.0)),
                "-to",
                &format!("{:.2}", seg.end),
            ]);
        }
        cmd.args(["-i", &seg.path]);
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

    // Same hardware encoder the Discord export uses — 3-5x faster than
    // CPU x264 on a long montage. Quality-targeted (not fixed bitrate) so
    // output size tracks the content; each encoder spells that differently.
    let encoder = best_h264_encoder(&ffmpeg);
    let quality_args: &[&str] = match encoder.as_str() {
        "h264_nvenc" => &["-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0"],
        "h264_qsv" => &["-preset", "veryfast", "-global_quality", "21"],
        "h264_amf" => &["-quality", "balanced", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23"],
        _ => &["-preset", "veryfast", "-crf", "21"],
    };
    cmd.args([
        "-filter_complex",
        &filter,
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        &encoder,
    ]);
    cmd.args(quality_args);
    cmd.args([
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
    ])
    .arg(&output);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg_with_progress(&app2, cmd, total_secs, "montage")
    })
    .await
    .map_err(|e| e.to_string())??;
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
    // Kill markers can't be regenerated (unlike thumbnails) — carry them over.
    if let (Some(from), Some(to)) = (
        markers_path(&path),
        markers_path(&target.to_string_lossy()),
    ) {
        let _ = std::fs::rename(from, to);
    }
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
    // Keep the source container: remuxing an mkv's streams (e.g. AV1) into
    // mp4 via stream copy can produce a file players choke on.
    let ext = input_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    let output = input_path
        .with_file_name(format!("{stem}_trim_{}-{}.{ext}", start as u64, end as u64));

    let mut cmd = hidden_cmd(ffmpeg);
    cmd.args([
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
    ]);
    if ext == "mp4" {
        // mp4-muxer-only option; mkv rejects it.
        cmd.args(["-movflags", "+faststart"]);
    }
    let result = cmd.arg(&output).output().map_err(|e| e.to_string())?;

    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    let out = output.to_string_lossy().replace('\\', "/");
    // Shift kill markers into the trimmed clip's own time base.
    let shifted: Vec<f64> = read_markers(&input)
        .into_iter()
        .map(|t| t - start)
        .filter(|t| *t >= 0.0 && *t <= end - start)
        .collect();
    if !shifted.is_empty() {
        write_markers(&out, &shifted);
    }
    Ok(out)
}
