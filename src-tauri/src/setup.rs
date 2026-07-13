//! First-run bootstrap: find OBS, enable obs-websocket, read its password,
//! install ffmpeg — so a friend's machine needs zero manual configuration.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::clips::hidden_cmd;

/// Well-known OBS install locations, most common first.
pub fn detect_obs_path() -> Option<String> {
    let candidates = [
        "C:/Program Files/obs-studio/bin/64bit/obs64.exe".to_string(),
        "C:/Program Files (x86)/obs-studio/bin/64bit/obs64.exe".to_string(),
        format!(
            "{}/obs-studio/bin/64bit/obs64.exe",
            std::env::var("ProgramFiles").unwrap_or_default().replace('\\', "/")
        ),
    ];
    candidates
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
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
        // Random-enough local password without extra crates.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        cfg.server_password = format!("cf{seed:x}");
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

/// Install a tool via winget; blocks until done. `id` is allow-listed.
#[tauri::command]
pub async fn winget_install(id: String) -> Result<(), String> {
    let allowed = ["Gyan.FFmpeg", "OBSProject.OBSStudio"];
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

/// Make sure the replay buffer is enabled in the connected OBS profile —
/// both output modes — and matches the configured clip length.
pub async fn ensure_replay_buffer_config(client: &obws::Client, replay_seconds: f64) {
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
    // Buffer length follows the ClipForge "clip length" setting exactly,
    // and the RAM cap is sized to fit so the tail never gets truncated
    // (~4.5 MB/s covers a 25 Mbps recording plus audio).
    let secs = replay_seconds.clamp(15.0, 900.0);
    let size_mb = ((secs * 4.5).ceil() as u64).max(512);
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
    // OBS applies the new length only on a buffer (re)start — stop it,
    // the supervisor re-arms it on the next tick if a game is running.
    if changed && client.replay_buffer().status().await.unwrap_or(false) {
        let _ = client.replay_buffer().stop().await;
    }
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
    if changed && client.replay_buffer().status().await.unwrap_or(false) {
        let _ = client.replay_buffer().stop().await;
    }
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
    let re = regex::Regex::new(r"^\s*-\s+([a-z0-9_]+)\s+\(").unwrap();
    let mut ids: Vec<String> = raw
        .lines()
        .filter_map(|l| re.captures(l))
        .map(|c| c[1].to_string())
        .filter(|id| id.contains("264") || id.contains("265") || id.contains("hevc") || id.contains("av1"))
        .collect();
    ids.dedup();
    ids
}

/// Map a codec preference to this machine's best hardware encoder id.
fn pick_encoder(pref: &str, available: &[String]) -> Option<String> {
    let hw = |id: &String| id.contains("amf") || id.contains("nvenc") || id.contains("qsv");
    let find = |codec: &[&str]| {
        available
            .iter()
            .find(|id| hw(id) && codec.iter().any(|c| id.contains(c)))
            .cloned()
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

/// Apply the app's capture settings (fps / resolution / encoder / bitrate)
/// to OBS. Stops the replay buffer when something changed so the new
/// values take effect on the next arm.
pub async fn ensure_video_settings(client: &obws::Client, settings: &crate::clips::Settings) {
    use obws::requests::profiles::SetParameter;

    let mut changed = false;

    if let Ok(video) = client.config().video_settings().await {
        let fps = settings.video_fps.clamp(30, 240);
        let (out_w, out_h) = if settings.video_height == 0 {
            (video.base_width, video.base_height)
        } else {
            let h = settings.video_height.min(video.base_height);
            let w = (h as f64 * video.base_width as f64 / video.base_height as f64 / 2.0).round()
                as u32
                * 2;
            (w, h)
        };
        if video.fps_numerator != fps
            || video.fps_denominator != 1
            || video.output_width != out_w
            || video.output_height != out_h
        {
            let _ = client
                .config()
                .set_video_settings(obws::requests::config::SetVideoSettings {
                    fps_numerator: Some(fps),
                    fps_denominator: Some(1),
                    base_width: None,
                    base_height: None,
                    output_width: Some(out_w),
                    output_height: Some(out_h),
                })
                .await;
            changed = true;
        }
    }

    // Encoder: only touched when we can resolve a valid id for this GPU.
    if let Some(encoder) = pick_encoder(&settings.encoder_pref, &detect_obs_encoders()) {
        let current = client
            .profiles()
            .parameter("AdvOut", "RecEncoder")
            .await
            .ok()
            .and_then(|p| p.value);
        if current.as_deref() != Some(encoder.as_str()) {
            let _ = client
                .profiles()
                .set_parameter(SetParameter {
                    category: "AdvOut",
                    name: "RecEncoder",
                    value: Some(&encoder),
                })
                .await;
            changed = true;
        }
    }

    // Bitrate lives in the profile's recordEncoder.json; OBS reads it when
    // the profile loads, so this part only lands after an OBS restart.
    if let Ok(profiles) = client.profiles().list().await {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = std::path::PathBuf::from(appdata)
                .join("obs-studio/basic/profiles")
                .join(profiles.current.replace(' ', "_"))
                .join("recordEncoder.json");
            let desired = format!("{{\"bitrate\":{}}}", (settings.bitrate_mbps * 1000.0) as u64);
            let current = std::fs::read_to_string(&path).unwrap_or_default();
            if current.trim() != desired && path.parent().is_some_and(|p| p.exists()) {
                let _ = std::fs::write(&path, desired);
            }
        }
    }

    if changed && client.replay_buffer().status().await.unwrap_or(false) {
        let _ = client.replay_buffer().stop().await;
    }
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
