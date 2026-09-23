//! First-run bootstrap: find OBS, enable obs-websocket, read its password,
//! install ffmpeg — so a friend's machine needs zero manual configuration.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::clips::hidden_cmd;

/// Where OBS lives: well-known Program Files paths first (no process spawn),
/// then the install dir OBS's own installer records in the registry
/// (custom install locations), then Steam's default library (the Steam build
/// of OBS never touches Program Files).
pub fn detect_obs_path() -> Option<String> {
    // Called from the supervisor tick while OBS is missing — cache the
    // registry/Steam lookup for 30s instead of spawning `reg` every 3s.
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Option<String>)>> =
        std::sync::Mutex::new(None);

    let exists = |p: &String| std::path::Path::new(p).exists();
    let fixed = [
        "C:/Program Files/obs-studio/bin/64bit/obs64.exe".to_string(),
        "C:/Program Files (x86)/obs-studio/bin/64bit/obs64.exe".to_string(),
        format!(
            "{}/obs-studio/bin/64bit/obs64.exe",
            std::env::var("ProgramFiles").unwrap_or_default().replace('\\', "/")
        ),
    ];
    if let Some(p) = fixed.into_iter().find(exists) {
        return Some(p);
    }

    if let Ok(cache) = CACHE.lock() {
        if let Some((at, hit)) = cache.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(30) {
                return hit.clone().filter(exists);
            }
        }
    }
    let found = [
        reg_value(r"HKLM\SOFTWARE\OBS Studio", None),
        reg_value(r"HKLM\SOFTWARE\WOW6432Node\OBS Studio", None),
    ]
    .into_iter()
    .flatten()
    .map(|dir| format!("{}/bin/64bit/obs64.exe", dir.replace('\\', "/")))
    .chain(
        reg_value(r"HKCU\Software\Valve\Steam", Some("SteamPath")).map(|steam| {
            format!(
                "{}/steamapps/common/OBS Studio/bin/64bit/obs64.exe",
                steam.replace('\\', "/")
            )
        }),
    )
    .find(exists);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((std::time::Instant::now(), found.clone()));
    }
    found
}

/// Read a registry string via `reg query` (`None` name = the key's default
/// value). Avoids pulling in the windows crate's registry feature for two
/// lookups.
fn reg_value(key: &str, name: Option<&str>) -> Option<String> {
    let mut cmd = hidden_cmd("reg");
    cmd.args(["query", key]);
    match name {
        Some(n) => cmd.args(["/v", n]),
        None => cmd.arg("/ve"),
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // Value line: "    <name>    REG_SZ    <data>"
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

fn websocket_config_path() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(
        std::path::PathBuf::from(appdata)
            .join("obs-studio/plugin_config/obs-websocket/config.json"),
    )
}

#[derive(Serialize, Deserialize)]
struct WsConfig {
    #[serde(default)]
    alerts_enabled: bool,
    #[serde(default = "yes")]
    auth_required: bool,
    #[serde(default)]
    first_load: bool,
    #[serde(default)]
    server_enabled: bool,
    #[serde(default)]
    server_password: String,
    #[serde(default = "default_port")]
    server_port: u16,
}
fn yes() -> bool {
    true
}
fn default_port() -> u16 {
    4455
}

/// Whether OBS's websocket server is switched on, per its config file. OBS
/// rewrites the file when the setting changes, so it reflects the live
/// state closely enough to explain a failed connection.
pub fn websocket_server_enabled() -> bool {
    websocket_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<WsConfig>(&raw).ok())
        .is_some_and(|cfg| cfg.server_enabled)
}

/// Read the local obs-websocket password (it lives in a user-readable file).
pub fn read_websocket_password() -> Option<(String, u16)> {
    let raw = std::fs::read_to_string(websocket_config_path()?).ok()?;
    let cfg: WsConfig = serde_json::from_str(&raw).ok()?;
    if cfg.server_password.is_empty() {
        return None;
    }
    Some((cfg.server_password, cfg.server_port))
}

/// Enable the websocket server in OBS config. Only safe while OBS is not
/// running (OBS rewrites the file on exit); returns whether it acted.
pub fn enable_websocket_server(obs_running: bool) -> bool {
    if obs_running {
        return false;
    }
    let Some(path) = websocket_config_path() else {
        return false;
    };
    let mut cfg: WsConfig = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| WsConfig {
            alerts_enabled: false,
            auth_required: true,
            first_load: false,
            server_enabled: false,
            server_password: String::new(),
            server_port: 4455,
        }),
        // Fresh OBS install without the file yet — create it.
        Err(_) => WsConfig {
            alerts_enabled: false,
            auth_required: true,
            first_load: false,
            server_enabled: false,
            server_password: String::new(),
            server_port: 4455,
        },
    };

    let mut changed = false;
    if !cfg.server_enabled {
        cfg.server_enabled = true;
        changed = true;
    }
    if cfg.server_password.is_empty() {
        cfg.server_password = random_password();
        changed = true;
    }
    if changed {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&cfg) {
            return std::fs::write(&path, raw).is_ok();
        }
        return false;
    }
    true
}

/// 128-bit random password for obs-websocket. OBS listens on every network
/// interface, so the old time-derived `cf{nanos}` was guessable from the
/// LAN. std's `RandomState` keys come from the OS RNG (fresh per call), which
/// gives real entropy without an extra crate.
fn random_password() -> String {
    use std::hash::{BuildHasher, Hasher};
    let word = || std::collections::hash_map::RandomState::new().build_hasher().finish();
    format!("cf{:016x}{:016x}", word(), word())
}

/// OBS shows a blocking Auto-Configuration Wizard on its very first launch
/// (checked via `global.ini`'s `[General] FirstRun` flag — see OBSBasic.cpp).
/// A silently-installed OBS has never set that flag, so without this the
/// wizard would pop up and stall the whole zero-touch setup on first launch.
/// Only safe while OBS is not running (same reason as `enable_websocket_server`).
pub fn suppress_autoconfig_wizard(obs_running: bool) {
    if obs_running {
        return;
    }
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let path = std::path::PathBuf::from(appdata).join("obs-studio/global.ini");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let ini = std::fs::read_to_string(&path).unwrap_or_default();
    if ini.lines().any(|l| l.trim() == "FirstRun=true") {
        return;
    }
    let mut out = String::new();
    let mut in_general = false;
    let mut wrote = false;
    for line in ini.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if in_general && !wrote {
                out.push_str("FirstRun=true\n");
                wrote = true;
            }
            in_general = trimmed.eq_ignore_ascii_case("[General]");
        }
        out.push_str(line);
        out.push('\n');
    }
    if in_general && !wrote {
        out.push_str("FirstRun=true\n");
        wrote = true;
    }
    if !wrote {
        out.push_str("[General]\nFirstRun=true\n");
    }
    let _ = std::fs::write(&path, out);
}

/// Launch OBS hidden to the tray, on demand (e.g. from the connection-error
/// bar). Mirrors the supervisor's auto-launch spawn; the supervisor then
/// connects on its next tick. No-op-ish if OBS is already running — OBS's
/// single-instance guard just focuses the existing process.
#[tauri::command]
pub fn launch_obs(app: AppHandle) -> Result<(), String> {
    let mut settings = crate::clips::load_settings_inner(&app);
    if !std::path::Path::new(&settings.obs_path).exists() {
        localize_settings(&app, &mut settings);
    }
    let exe = std::path::PathBuf::from(&settings.obs_path);
    if !exe.exists() {
        return Err("OBS isn't installed — install it from the setup bar first".into());
    }
    // Make sure the websocket server is on and the wizard won't block, same
    // as first-run bootstrap, before we start it.
    if settings.password.is_none() {
        enable_websocket_server(false);
    }
    suppress_autoconfig_wizard(false);
    let dir = exe.parent().ok_or("bad OBS path")?;

    // Try a plain spawn first. If OBS is configured to run as administrator
    // it needs elevation, which CreateProcess can't do (os error 740) — fall
    // back to ShellExecute, which honours the exe's manifest and shows the
    // UAC prompt so an elevated OBS can start.
    let spawned = crate::clips::hidden_cmd(&exe)
        .current_dir(dir)
        .args(["--minimize-to-tray", "--disable-shutdown-check"])
        .spawn();
    match spawned {
        Ok(_) => Ok(()),
        Err(e) if e.raw_os_error() == Some(740) => shell_launch_elevated(&exe, dir),
        Err(e) => Err(format!("couldn't launch OBS: {e}")),
    }
}

/// Launch a program via ShellExecuteW with the default verb, which triggers
/// the UAC prompt when the target requires elevation (unlike CreateProcess).
fn shell_launch_elevated(exe: &std::path::Path, dir: &std::path::Path) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWMINNOACTIVE;

    let file = HSTRING::from(exe);
    let params = HSTRING::from("--minimize-to-tray --disable-shutdown-check");
    let directory = HSTRING::from(dir);
    let result = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &file,
            &params,
            &directory,
            SW_SHOWMINNOACTIVE,
        )
    };
    // ShellExecuteW returns an HINSTANCE > 32 on success.
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err("OBS needs administrator rights to launch. Start OBS manually, or turn off \"Run as administrator\" in OBS's shortcut/compatibility settings.".into())
    }
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
    pub obs_installed: bool,
    pub ffmpeg_installed: bool,
}

#[tauri::command]
pub fn setup_status() -> SetupStatus {
    SetupStatus {
        obs_installed: detect_obs_path().is_some(),
        ffmpeg_installed: crate::clips::ffmpeg_available(),
    }
}

/// Install OBS: winget only *downloads* the installer (hash-verified), then we
/// run it ourselves as admin.
///
/// Letting winget run it failed on real machines: OBS's installer refuses to
/// overwrite files other apps have loaded — typically a leftover OBS virtual
/// camera DLL that browsers, Electron apps and Ollama load while listing
/// cameras. Silent (`/S`) it can't show its "close these apps" dialog, so it
/// just exits with code 6, which winget reported as "ShellExecute installer
/// failed: 6". On that code we re-run it with its UI, so the user sees which
/// apps to close and can hit Retry.
fn install_obs() -> Result<(), String> {
    const OBS_FILES_IN_USE: u32 = 6;

    let dir = std::env::temp_dir().join("clipforge-obs-installer");
    let _ = std::fs::remove_dir_all(&dir);
    let out = hidden_cmd("winget")
        .args([
            "download",
            "--id",
            "OBSProject.OBSStudio",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--skip-license",
            "--download-directory",
        ])
        .arg(&dir)
        .output()
        .map_err(|e| format!("winget not available: {e}"))?;
    let installer = std::fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
        .ok_or_else(|| {
            format!(
                "couldn't download the OBS installer: {}",
                String::from_utf8_lossy(&out.stdout).trim()
            )
        })?;

    let mut code = run_elevated_and_wait(&installer, "/S", false)?;
    if code == OBS_FILES_IN_USE {
        code = run_elevated_and_wait(&installer, "", true)?;
    }
    let _ = std::fs::remove_dir_all(&dir);
    match code {
        0 => Ok(()),
        OBS_FILES_IN_USE => Err(
            "OBS files are in use by other apps (often browsers or Ollama). Close them and install again."
                .into(),
        ),
        c => Err(format!("OBS installer failed (exit code {c})")),
    }
}

/// Launch `exe` as administrator (one UAC prompt) and wait for its exit code.
fn run_elevated_and_wait(exe: &std::path::Path, params: &str, visible: bool) -> Result<u32, String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(exe);
    let params = HSTRING::from(params);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: if visible { SW_SHOWNORMAL.0 } else { SW_HIDE.0 },
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            return Err(if e.code() == ERROR_CANCELLED.to_hresult() {
                "Install cancelled: Windows needs your OK on the admin prompt to install OBS.".into()
            } else {
                format!("couldn't start the installer: {e}")
            });
        }
        let process = info.hProcess;
        if process.is_invalid() {
            return Err("couldn't start the installer".into());
        }
        WaitForSingleObject(process, INFINITE);
        let mut code = 0u32;
        let got = GetExitCodeProcess(process, &mut code);
        let _ = CloseHandle(process);
        got.map_err(|e| format!("couldn't read the installer's result: {e}"))?;
        Ok(code)
    }
}

/// Install a tool via winget; blocks until done. `id` is allow-listed.
#[tauri::command]
pub async fn winget_install(id: String) -> Result<(), String> {
    crate::clips::blocking(move || winget_install_blocking(id)).await
}

fn winget_install_blocking(id: String) -> Result<(), String> {
    let allowed = ["Gyan.FFmpeg", "OBSProject.OBSStudio"];
    if !allowed.contains(&id.as_str()) {
        return Err("unknown package".into());
    }
    // OBS installs machine-wide and can hit in-use files; see install_obs.
    if id == "OBSProject.OBSStudio" {
        return install_obs();
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

/// Make sure the replay buffer is enabled in the connected OBS profile —
/// both output modes — and matches the configured clip length.
/// Returns whether anything changed (applied on the next profile reload).
pub async fn ensure_replay_buffer_config(client: &obws::Client, replay_seconds: f64, bitrate_mbps: f64) -> bool {
    use obws::requests::profiles::SetParameter;
    for (category, name) in [("AdvOut", "RecRB"), ("SimpleOutput", "RecRB")] {
        let current = client
            .profiles()
            .parameter(category, name)
            .await
            .ok()
            .and_then(|p| p.value);
        if current.as_deref() != Some("true") {
            let _ = client
                .profiles()
                .set_parameter(SetParameter {
                    category,
                    name,
                    value: Some("true"),
                })
                .await;
        }
    }
    // Buffer length follows the ClipForge "clip length" setting exactly, and
    // the RAM cap is sized from the actual video bitrate so the oldest part
    // is never dropped. (It used to assume ~25 Mbps: at 50 Mbps a 3-minute
    // buffer silently lost its first minute.) +25% covers CBR overshoot and
    // keyframes; 5 AAC tracks add ~0.12 MB/s.
    let secs = replay_seconds.clamp(15.0, 900.0);
    let mb_per_sec = bitrate_mbps / 8.0 * 1.25 + 0.12;
    let size_mb = ((secs * mb_per_sec).ceil() as u64).max(512);
    let mut changed = false;
    for (name, value) in [
        ("RecRBTime", format!("{}", secs as u64)),
        ("RecRBSize", size_mb.to_string()),
    ] {
        for category in ["AdvOut", "SimpleOutput"] {
            let current = client
                .profiles()
                .parameter(category, name)
                .await
                .ok()
                .and_then(|p| p.value);
            if current.as_deref() != Some(value.as_str()) {
                let _ = client
                    .profiles()
                    .set_parameter(SetParameter {
                        category,
                        name,
                        value: Some(&value),
                    })
                    .await;
                changed = true;
            }
        }
    }
    // OBS applies the new length on the next profile reload (`apply_all`),
    // not mid-buffer; stopping an armed buffer here threw away the moment
    // the user was about to clip.
    changed
}

/// Point OBS at ClipForge's clips folder and force the output layout the app
/// depends on: Advanced output mode (Simple mode can't record the separate
/// audio tracks the export dropdown offers), recording path = `clips_dir`
/// (otherwise clips save wherever OBS defaults and never show in the library),
/// and record tracks 1+2+3 enabled (mix / game / mic). Returns whether it
/// changed anything so callers can restart the replay buffer to apply it.
pub async fn ensure_output_config(client: &obws::Client, clips_dir: &str) -> bool {
    use obws::requests::profiles::SetParameter;
    // OBS stores the recording path with native separators on Windows.
    let path = clips_dir.replace('/', "\\");
    let mut changed = false;
    let desired: [(&str, &str, String); 7] = [
        ("Output", "Mode", "Advanced".into()),
        ("AdvOut", "RecType", "Standard".into()),
        ("AdvOut", "RecFilePath", path.clone()),
        ("SimpleOutput", "FilePath", path.clone()),
        // Bitmask tracks 1-5: mix(1)|game(2)|vc(4)|desktop(8)|mic(16) = 31.
        ("AdvOut", "RecTracks", "31".into()),
        // Fragmented mp4: plays in the in-app <video> preview (mkv doesn't),
        // holds multiple audio tracks, and survives a crash mid-recording.
        ("AdvOut", "RecFormat2", "hybrid_mp4".into()),
        ("SimpleOutput", "RecFormat2", "hybrid_mp4".into()),
    ];
    for (category, name, value) in desired {
        let current = client
            .profiles()
            .parameter(category, name)
            .await
            .ok()
            .and_then(|p| p.value);
        if current.as_deref() != Some(value.as_str()) {
            let _ = client
                .profiles()
                .set_parameter(SetParameter {
                    category,
                    name,
                    value: Some(&value),
                })
                .await;
            changed = true;
        }
    }
    // Applied by the profile reload in `apply_all` once OBS is idle.
    changed
}

/// Encoder ids OBS registered, parsed from its newest log (obs-websocket
/// has no encoder-list request).
fn detect_obs_encoders() -> Vec<String> {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return Vec::new();
    };
    let logs = std::path::PathBuf::from(appdata).join("obs-studio/logs");
    let Ok(entries) = std::fs::read_dir(&logs) else {
        return Vec::new();
    };
    let newest = entries
        .filter_map(|e| e.ok())
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let Some(newest) = newest else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(newest.path()) else {
        return Vec::new();
    };
    parse_encoder_ids(&raw)
}

/// Video-encoder ids from an OBS log's "Available Encoders" list.
fn parse_encoder_ids(raw: &str) -> Vec<String> {
    // Log lines carry a timestamp: "13:27:06.774: \t- av1_texture_amf (AMD HW AV1)".
    // The old `^\s*-` pattern never matched those, so no encoder was ever
    // detected and OBS silently kept whatever it defaulted to.
    let re = regex::Regex::new(r"^(?:[\d:.]+:)?\s*-\s+([a-z0-9_]+)\s+\(").unwrap();
    let mut ids: Vec<String> = raw
        .lines()
        .filter_map(|l| re.captures(l))
        .map(|c| c[1].to_string())
        // Video codecs only; QuickSync H.264 ("obs_qsv11_v2") names no codec.
        .filter(|id| ["264", "265", "hevc", "av1", "qsv"].iter().any(|c| id.contains(c)))
        .collect();
    ids.dedup();
    ids
}

/// Map a codec preference to this machine's best hardware encoder id.
/// Vendor order matters on laptops/desktops with an Intel iGPU next to a
/// discrete card: the dGPU's encoder (NVENC, then AMF) beats QuickSync, which
/// OBS also logs as "app not on intel GPU, fall back to old qsv encoder".
fn pick_encoder(pref: &str, available: &[String]) -> Option<String> {
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
    match pref {
        "av1" => find(&["av1"]),
        "hevc" => find(&["hevc", "265"]),
        "h264" => find(&["264", "avc"]).or_else(|| Some("obs_x264".into())),
        // auto: best codec this GPU offers
        _ => find(&["av1"])
            .or_else(|| find(&["hevc", "265"]))
            .or_else(|| find(&["264", "avc"])),
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

/// What `ensure_video_settings` settled on.
pub struct VideoApplied {
    /// Output-affecting settings changed; OBS needs a profile reload.
    pub changed: bool,
    /// The bitrate actually configured (drives the replay-buffer RAM cap).
    pub bitrate_mbps: f64,
}

/// Apply the app's capture settings to OBS: fps, resolution (Lanczos
/// downscale), this GPU's best encoder and the clip-tuned encoder settings.
pub async fn ensure_video_settings(client: &obws::Client, settings: &crate::clips::Settings) -> VideoApplied {
    use obws::requests::profiles::SetParameter;

    let mut changed = false;
    let fps = settings.video_fps.clamp(30, 240);
    let mut out_h = settings.video_height;

    if let Ok(video) = client.config().video_settings().await {
        let (out_w, h) = if settings.video_height == 0 {
            (video.base_width, video.base_height)
        } else {
            let h = settings.video_height.min(video.base_height);
            let w = (h as f64 * video.base_width as f64 / video.base_height as f64 / 2.0).round()
                as u32
                * 2;
            (w, h)
        };
        out_h = h;
        if video.fps_numerator != fps
            || video.fps_denominator != 1
            || video.output_width != out_w
            || video.output_height != h
        {
            let _ = client
                .config()
                .set_video_settings(obws::requests::config::SetVideoSettings {
                    fps_numerator: Some(fps),
                    fps_denominator: Some(1),
                    base_width: None,
                    base_height: None,
                    output_width: Some(out_w),
                    output_height: Some(h),
                })
                .await;
            changed = true;
        }
    }

    // Sharpest downscale when recording below the canvas resolution.
    let set_param = |category: &'static str, name: &'static str, value: String| async move {
        let current = client
            .profiles()
            .parameter(category, name)
            .await
            .ok()
            .and_then(|p| p.value);
        if current.as_deref() == Some(value.as_str()) {
            return false;
        }
        let _ = client
            .profiles()
            .set_parameter(SetParameter { category, name, value: Some(&value) })
            .await;
        true
    };
    changed |= set_param("Video", "ScaleType", "lanczos".into()).await;

    // Encoder: only touched when we can resolve a valid id for this GPU.
    let encoder = pick_encoder(&settings.encoder_pref, &detect_obs_encoders());
    if let Some(encoder) = &encoder {
        changed |= set_param("AdvOut", "RecEncoder", encoder.clone()).await;
    }
    let encoder_id = encoder.unwrap_or_default();
    let bitrate_mbps = target_bitrate_mbps(settings, out_h, fps, &encoder_id);

    // Encoder settings live in the profile's recordEncoder.json, which OBS
    // only reads when the profile loads (see `reload_profile_if_idle`).
    // Merge rather than overwrite, so keys we don't manage survive.
    if let Ok(profiles) = client.profiles().list().await {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = std::path::PathBuf::from(appdata)
                .join("obs-studio/basic/profiles")
                .join(profiles.current.replace(' ', "_"))
                .join("recordEncoder.json");
            if path.parent().is_some_and(|p| p.exists()) {
                let raw = std::fs::read_to_string(&path).unwrap_or_default();
                let mut json: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str(&raw).unwrap_or_default();
                let before = json.clone();
                json.extend(encoder_tuning(&encoder_id, bitrate_mbps));
                if json != before {
                    if let Ok(out) = serde_json::to_string(&json) {
                        let _ = std::fs::write(&path, out);
                        changed = true;
                    }
                }
            }
        }
    }

    VideoApplied { changed, bitrate_mbps }
}

/// Make OBS pick up output changes (mode, encoder, recordEncoder.json):
/// it only rebuilds its outputs when a profile loads, so written settings
/// sat unused until OBS restarted — a fresh setup kept recording with
/// Simple-mode QuickSync. Round-tripping through a temporary profile
/// reloads the current one cleanly. Only while nothing is recording or
/// streaming; otherwise it stays pending for the next config pass.
pub async fn reload_profile_if_idle(client: &obws::Client) -> bool {
    const TEMP: &str = "ClipForge reload";
    let busy = client.replay_buffer().status().await.unwrap_or(true)
        || client.recording().status().await.map(|s| s.active).unwrap_or(true)
        || client.streaming().status().await.map(|s| s.active).unwrap_or(true);
    if busy {
        return false;
    }
    let Ok(current) = client.profiles().current().await else {
        return false;
    };
    let _ = client.profiles().create(TEMP).await;
    let reloaded = client.profiles().set_current(TEMP).await.is_ok()
        && client.profiles().set_current(&current).await.is_ok();
    let _ = client.profiles().remove(TEMP).await;
    reloaded
}

/// Output-affecting changes not yet picked up by OBS (it was busy).
pub static RELOAD_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Every ClipForge-managed OBS setting, in dependency order, then one
/// profile reload if outputs changed. Used on connect and after the user
/// edits settings.
pub async fn apply_all(client: &obws::Client, settings: &crate::clips::Settings, game: Option<&str>) {
    use std::sync::atomic::Ordering;
    let mut outputs_changed = ensure_output_config(client, &settings.clips_dir).await;
    let video = ensure_video_settings(client, settings).await;
    outputs_changed |= video.changed;
    outputs_changed |= ensure_replay_buffer_config(client, settings.replay_seconds, video.bitrate_mbps).await;
    ensure_audio_devices(client).await;
    ensure_audio_tracks(client).await;
    ensure_split_audio(client, game, &settings.vc_exe).await;

    if outputs_changed || RELOAD_PENDING.load(Ordering::Relaxed) {
        // Reload now if OBS is idle (fresh connect, settings edited at the
        // desktop). While the buffer is armed it holds the moment the user
        // may be about to clip, so never stop it for this: the supervisor
        // reloads once the game has exited and the buffer is down.
        let done = reload_profile_if_idle(client).await;
        RELOAD_PENDING.store(!done, Ordering::Relaxed);
    }
}

/// Everything the Settings "Health" panel shows, gathered in one call: what
/// OBS is actually using (not what we asked for), plus live frame health.
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
    /// Settings written but not yet loaded by OBS (applies after the game).
    pub settings_pending: bool,
    pub health: crate::health::Health,
    pub disk_free_bytes: Option<u64>,
    pub ffmpeg_found: bool,
    /// Sync client the clips folder lives in (e.g. "Google Drive"), if any.
    pub clips_dir_cloud: Option<String>,
}

#[tauri::command]
pub async fn obs_diagnostics(
    app: AppHandle,
    state: tauri::State<'_, crate::obs::ObsState>,
) -> Result<Diagnostics, String> {
    let settings = crate::clips::load_settings_inner(&app);
    let mut d = Diagnostics {
        obs_connected: false,
        obs_version: state.version.lock().ok().and_then(|v| v.clone()),
        obs_outdated: crate::obs::outdated_obs_version(state.inner()).is_some(),
        output_mode: None,
        encoder: None,
        best_encoder: pick_encoder(&settings.encoder_pref, &detect_obs_encoders()),
        rate_control: None,
        bitrate_kbps: None,
        keyint_sec: None,
        buffer_seconds: None,
        buffer_ram_mb: None,
        fps: None,
        resolution: None,
        settings_pending: RELOAD_PENDING.load(std::sync::atomic::Ordering::Relaxed),
        health: crate::health::latest(),
        disk_free_bytes: crate::clips::disk_free(settings.clips_dir.clone()).ok(),
        ffmpeg_found: crate::clips::ffmpeg_available(),
        clips_dir_cloud: crate::backup::cloud_synced_provider(&settings.clips_dir).map(String::from),
    };
    let guard = state.client.lock().await;
    let Some(client) = guard.as_ref() else {
        return Ok(d);
    };
    d.obs_connected = true;
    let param = |category: &'static str, name: &'static str| async move {
        client.profiles().parameter(category, name).await.ok().and_then(|p| p.value)
    };
    d.output_mode = param("Output", "Mode").await;
    d.encoder = param("AdvOut", "RecEncoder").await;
    d.buffer_seconds = param("AdvOut", "RecRBTime").await.and_then(|v| v.parse().ok());
    d.buffer_ram_mb = param("AdvOut", "RecRBSize").await.and_then(|v| v.parse().ok());
    if let Ok(video) = client.config().video_settings().await {
        d.fps = Some(video.fps_numerator / video.fps_denominator.max(1));
        d.resolution = Some(format!("{}x{}", video.output_width, video.output_height));
    }
    if let (Ok(profile), Ok(appdata)) = (client.profiles().current().await, std::env::var("APPDATA")) {
        let path = std::path::PathBuf::from(appdata)
            .join("obs-studio/basic/profiles")
            .join(profile.replace(' ', "_"))
            .join("recordEncoder.json");
        if let Some(json) = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            d.rate_control = json["rate_control"].as_str().map(String::from);
            d.bitrate_kbps = json["bitrate"].as_u64();
            d.keyint_sec = json["keyint_sec"].as_f64();
        }
    }
    Ok(d)
}

/// Detect audio capture sources bound to devices that no longer exist
/// (unplugged headset, changed default) and reset them to "default" —
/// otherwise OBS silently records silence on every track.
pub async fn ensure_audio_devices(client: &obws::Client) {
    let Ok(inputs) = client.inputs().list(None).await else {
        return;
    };
    for input in inputs {
        if !input.kind.starts_with("wasapi_") {
            continue;
        }
        let id = obws::requests::inputs::InputId::Name(&input.id.name);
        let Ok(settings) = client
            .inputs()
            .settings::<serde_json::Value>(id)
            .await
        else {
            continue;
        };
        let device = settings
            .settings
            .get("device_id")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();
        if device == "default" {
            continue;
        }
        let Ok(items) = client
            .inputs()
            .properties_list_property_items(
                obws::requests::inputs::InputId::Name(&input.id.name),
                "device_id",
            )
            .await
        else {
            continue;
        };
        let still_exists = items.iter().any(|i| {
            i.value.as_str().is_some_and(|v| v == device)
        });
        if !still_exists {
            let _ = client
                .inputs()
                .set_settings(obws::requests::inputs::SetSettings {
                    input: obws::requests::inputs::InputId::Name(&input.id.name),
                    settings: &serde_json::json!({ "device_id": "default" }),
                    overlay: Some(true),
                })
                .await;
        }
    }
}

/// Track layout the export dropdown promises:
///   1 = full mix, 2 = game, 3 = voice chat, 4 = desktop, 5 = mic.
/// Desktop output feeds mix(1) + desktop(4); mic feeds mix(1) + mic(5).
/// Game and voice-chat isolation live on tracks 2/3 via dedicated
/// application-audio-capture sources (see `ensure_split_audio`) — they are
/// NOT added to the mix here since they already come through desktop, so the
/// mix wouldn't double them. Extra duplicate desktop captures are muted.
pub async fn ensure_audio_tracks(client: &obws::Client) {
    use obws::requests::inputs::InputId;

    let Ok(inputs) = client.inputs().list(None).await else {
        return;
    };

    let mut seen_output_devices: Vec<String> = Vec::new();
    for input in inputs {
        let is_mic = input.kind.starts_with("wasapi_input");
        let is_desktop = input.kind.starts_with("wasapi_output");
        if !is_mic && !is_desktop {
            continue;
        }
        let name = input.id.name.clone();

        let desired: [Option<bool>; 6] = if is_mic {
            // mix + mic-only (track 5)
            [Some(true), Some(false), Some(false), Some(false), Some(true), Some(false)]
        } else {
            let device = client
                .inputs()
                .settings::<serde_json::Value>(InputId::Name(&name))
                .await
                .ok()
                .and_then(|s| {
                    s.settings
                        .get("device_id")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                })
                .unwrap_or_else(|| "default".into());
            if seen_output_devices.contains(&device) {
                // duplicate desktop capture — take it off every track
                [Some(false); 6]
            } else {
                seen_output_devices.push(device);
                // mix + desktop-only (track 4)
                [Some(true), Some(false), Some(false), Some(true), Some(false), Some(false)]
            }
        };

        let current = client
            .inputs()
            .audio_tracks(InputId::Name(&name))
            .await
            .unwrap_or([false; 6]);
        let needs_change = desired
            .iter()
            .zip(current.iter())
            .any(|(want, have)| want.is_some_and(|w| w != *have));
        if needs_change {
            let _ = client
                .inputs()
                .set_audio_tracks(InputId::Name(&name), desired)
                .await;
        }
    }
}

/// Isolate game and voice-chat audio onto their own tracks via OBS
/// Application Audio Capture (`wasapi_process_output_capture`), matched by
/// executable. Game audio → track 2, voice chat → track 3. `game_exe` is the
/// currently-active game (None leaves the game source untouched).
pub async fn ensure_split_audio(client: &obws::Client, game_exe: Option<&str>, vc_exe: &str) {
    if let Some(game) = game_exe {
        upsert_process_audio(client, "GameAudio", game, 1).await;
    }
    if !vc_exe.trim().is_empty() {
        upsert_process_audio(client, "VCAudio", vc_exe, 2).await;
    }
}

/// Create-or-update an application-audio-capture input bound to `exe`, routed
/// to exactly one recording track (`track_index`, 0-based). Matched by
/// executable (priority 2) so it works whether or not the app is running yet.
async fn upsert_process_audio(client: &obws::Client, name: &str, exe: &str, track_index: usize) {
    use obws::requests::inputs::{InputId, SetSettings};
    const KIND: &str = "wasapi_process_output_capture";
    // priority 2 = match by executable (OBS window_priority enum).
    let settings = serde_json::json!({ "window": format!("::{exe}"), "priority": 2 });

    let exists = client
        .inputs()
        .list(Some(KIND))
        .await
        .map(|v| v.iter().any(|i| i.id.name == name))
        .unwrap_or(false);

    if exists {
        let _ = client
            .inputs()
            .set_settings(SetSettings {
                input: InputId::Name(name),
                settings: &settings,
                overlay: Some(true),
            })
            .await;
    } else {
        let Ok(scene) = client.scenes().current_program_scene().await else {
            return;
        };
        let _ = client
            .inputs()
            .create(obws::requests::inputs::Create {
                scene: scene.id.into(),
                input: name,
                kind: KIND,
                settings: Some(settings),
                enabled: Some(true),
            })
            .await;
    }

    let mut tracks: [Option<bool>; 6] = [Some(false); 6];
    tracks[track_index] = Some(true);
    let _ = client
        .inputs()
        .set_audio_tracks(InputId::Name(name), tracks)
        .await;
}

/// Fill in machine-specific defaults on first run: detected OBS path,
/// the user's Videos folder for clips, and the websocket password.
pub fn localize_settings(app: &AppHandle, settings: &mut crate::clips::Settings) -> bool {
    let mut changed = false;

    if !std::path::Path::new(&settings.obs_path).exists() {
        if let Some(path) = detect_obs_path() {
            settings.obs_path = path;
            changed = true;
        }
    }

    if !std::path::Path::new(&settings.clips_dir).exists() {
        let videos = std::env::var("USERPROFILE")
            .map(|p| format!("{}/Videos/Clips", p.replace('\\', "/")))
            .unwrap_or_else(|_| settings.clips_dir.clone());
        if std::fs::create_dir_all(&videos).is_ok() {
            settings.clips_dir = videos;
            changed = true;
        }
    }

    if settings.password.is_none() {
        if let Some((password, port)) = read_websocket_password() {
            settings.password = Some(password);
            settings.port = port;
            settings.auto_connect = true;
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

    // Verbatim from a real OBS 32.2.2 log on an AMD + Intel iGPU machine.
    const LOG: &str = "13:27:06.774: Available Encoders:
13:27:06.774:   Video Encoders:
13:27:06.774: 	- ffmpeg_svt_av1 (SVT-AV1)
13:27:06.774: 	- ffmpeg_aom_av1 (AOM AV1)
13:27:06.774: 	- h264_texture_amf (AMD HW H.264 (AVC))
13:27:06.774: 	- h265_texture_amf (AMD HW H.265 (HEVC))
13:27:06.774: 	- av1_texture_amf (AMD HW AV1)
13:27:06.774: 	- obs_qsv11_v2 (QuickSync H.264)
13:27:06.774: 	- obs_qsv11_hevc (QuickSync HEVC)
13:27:06.774: 	- obs_x264 (x264)
13:27:06.774:   Audio Encoders:
13:27:06.774: 	- ffmpeg_aac (FFmpeg AAC)";

    #[test]
    fn parses_timestamped_encoder_list() {
        let ids = parse_encoder_ids(LOG);
        assert!(ids.contains(&"av1_texture_amf".to_string()), "{ids:?}");
        assert!(ids.contains(&"obs_x264".to_string()), "{ids:?}");
        assert!(!ids.iter().any(|i| i.contains("aac")), "{ids:?}");
    }

    #[test]
    fn prefers_discrete_gpu_encoder() {
        let ids = parse_encoder_ids(LOG);
        assert_eq!(pick_encoder("auto", &ids).as_deref(), Some("av1_texture_amf"));
        assert_eq!(pick_encoder("hevc", &ids).as_deref(), Some("h265_texture_amf"));
        assert_eq!(pick_encoder("h264", &ids).as_deref(), Some("h264_texture_amf"));
        let intel_only: Vec<String> = ["obs_qsv11_v2", "obs_qsv11_hevc", "obs_x264"].map(String::from).into();
        assert_eq!(pick_encoder("h264", &intel_only).as_deref(), Some("obs_qsv11_v2"));
        assert_eq!(pick_encoder("auto", &intel_only).as_deref(), Some("obs_qsv11_hevc"));
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
