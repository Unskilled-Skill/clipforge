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
/// both output modes — without touching the user's other settings.
pub async fn ensure_replay_buffer_config(client: &obws::Client) {
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
    // Fresh OBS installs default to a ~20s buffer — raise anything under
    // 60s to 120s, leave deliberate longer settings alone.
    for category in ["AdvOut", "SimpleOutput"] {
        let secs: f64 = client
            .profiles()
            .parameter(category, "RecRBTime")
            .await
            .ok()
            .and_then(|p| p.value)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0);
        if secs < 60.0 {
            let _ = client
                .profiles()
                .set_parameter(SetParameter {
                    category,
                    name: "RecRBTime",
                    value: Some("120"),
                })
                .await;
        }
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
