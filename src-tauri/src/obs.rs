use futures_util::{pin_mut, StreamExt};
use obws::{events::Event, Client};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

/// Game currently detected by the supervisor, used to name new clips.
#[derive(Default)]
pub struct CurrentGame(pub std::sync::Mutex<Option<String>>);

/// Friendly names for exes whose stems make terrible labels.
const GAME_NAMES: &[(&str, &str)] = &[
    ("valorant-win64-shipping", "Valorant"),
    ("fortniteclient-win64-shipping", "Fortnite"),
    ("rainbowsix", "R6"),
    ("rainbowsix_dx11", "R6"),
    ("rainbowsix_be", "R6"),
    ("r5apex", "Apex"),
    ("r5apex_dx12", "Apex"),
    ("uagame", "ArenaBreakout"),
    ("cs2", "CS2"),
    ("league of legends", "LoL"),
    ("huntgame", "Hunt"),
    ("fsd-win64-shipping", "DeepRock"),
    ("overwatch", "Overwatch"),
    ("rocketleague", "RocketLeague"),
    ("helldivers2", "Helldivers"),
    ("gta5", "GTA"),
];

/// Prettify an exe name for filenames: known games get friendly labels,
/// the rest get generic suffixes stripped and the first letter uppercased.
fn pretty_game(exe: &str) -> String {
    let stem = exe.to_lowercase();
    let stem = stem.trim_end_matches(".exe");
    if let Some((_, name)) = GAME_NAMES.iter().find(|(k, _)| *k == stem) {
        return (*name).to_string();
    }
    let stem = stem
        .trim_end_matches("-win64-shipping")
        .trim_end_matches("client-win64-shipping")
        .trim_end_matches("_dx11")
        .trim_end_matches("_dx12")
        .trim_end_matches("_be")
        .trim_end_matches("-game")
        .replace(' ', "");
    let mut chars = stem.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => stem.to_string(),
    }
}

/// Rename a fresh clip to carry the game name, feedback via sound + toast.
/// If the short-clip hotkey triggered this save, keep only the tail.
async fn on_clip_saved(app: &AppHandle, path: std::path::PathBuf) {
    if crate::PENDING_SHORT.swap(false, std::sync::atomic::Ordering::Relaxed) {
        let secs = crate::clips::load_settings_inner(app).short_clip_seconds;
        let _ = crate::clips::shorten_clip(&path.to_string_lossy(), secs).await;
    }

    let game = app
        .state::<CurrentGame>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone());

    let final_path = match (&game, path.file_name()) {
        (Some(game), Some(file_name)) => {
            let new_name = format!(
                "{} {}",
                pretty_game(game),
                file_name.to_string_lossy().replacen("Replay ", "", 1)
            );
            let target = path.with_file_name(new_name);
            match std::fs::rename(&path, &target) {
                Ok(()) => target,
                Err(_) => path,
            }
        }
        _ => path,
    };

    // Audible in-game feedback; async so we never block the event loop.
    unsafe {
        use windows::core::w;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC};
        let _ = PlaySoundW(w!("SystemAsterisk"), None, SND_ALIAS | SND_ASYNC);
    }
    let _ = app
        .notification()
        .builder()
        .title("Clip saved")
        .body(
            final_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
        .show();

    let _ = app.emit(
        "clip-saved",
        ClipSaved {
            path: final_path.to_string_lossy().replace('\\', "/"),
        },
    );

    // Keep the folder under the storage cap; favorites survive.
    let _ = crate::clips::enforce_storage_cap(app);
}

/// Managed state: the live obs-websocket connection, if any.
pub struct ObsState {
    pub client: Mutex<Option<Client>>,
}

impl Default for ObsState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ObsStatus {
    pub connected: bool,
    pub replay_buffer_active: bool,
    pub obs_version: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ClipSaved {
    pub path: String,
}

/// Connect to obs-websocket and start listening for events.
#[tauri::command]
pub async fn obs_connect(
    app: AppHandle,
    state: tauri::State<'_, ObsState>,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<ObsStatus, String> {
    connect_internal(&app, state.inner(), host, port, password).await
}

pub async fn connect_internal(
    app: &AppHandle,
    state: &ObsState,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<ObsStatus, String> {
    let client = Client::connect(host.clone(), port, password.clone())
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    // Second connection just for the event stream: obws consumes the
    // event receiver, and we want the request client to stay usable.
    let event_client = Client::connect(host, port, password)
        .await
        .map_err(|e| format!("event connect failed: {e}"))?;

    let events = event_client
        .events()
        .map_err(|e| format!("event stream failed: {e}"))?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Keep the client alive for as long as we poll its events.
        let _keep_alive = event_client;
        pin_mut!(events);
        while let Some(event) = events.next().await {
            match event {
                Event::ReplayBufferSaved { path } => {
                    on_clip_saved(&app_handle, path).await;
                }
                Event::ReplayBufferStateChanged { active, .. } => {
                    let _ = app_handle.emit("replay-buffer-state", active);
                }
                _ => {}
            }
        }
        let _ = app_handle.emit("obs-disconnected", ());
    });

    let version = client
        .general()
        .version()
        .await
        .map(|v| v.obs_studio_version.to_string())
        .ok();

    let replay_active = client.replay_buffer().status().await.unwrap_or(false);

    *state.client.lock().await = Some(client);

    Ok(ObsStatus {
        connected: true,
        replay_buffer_active: replay_active,
        obs_version: version,
    })
}

#[tauri::command]
pub async fn obs_status(state: tauri::State<'_, ObsState>) -> Result<ObsStatus, String> {
    let guard = state.client.lock().await;
    match guard.as_ref() {
        Some(client) => {
            let replay_active = client.replay_buffer().status().await.unwrap_or(false);
            Ok(ObsStatus {
                connected: true,
                replay_buffer_active: replay_active,
                obs_version: None,
            })
        }
        None => Ok(ObsStatus {
            connected: false,
            replay_buffer_active: false,
            obs_version: None,
        }),
    }
}

/// Make sure the replay buffer is running (it is off by default when OBS starts).
#[tauri::command]
pub async fn start_replay_buffer(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    let active = client
        .replay_buffer()
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !active {
        client
            .replay_buffer()
            .start()
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Flush the replay buffer to disk. The resulting file path arrives
/// asynchronously via the `clip-saved` event.
pub async fn save_replay(state: &ObsState) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    client
        .replay_buffer()
        .save()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_replay_cmd(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    save_replay(state.inner()).await
}

/// Ensure the current scene has a universal game capture source on top:
/// `any_fullscreen` hooks whatever game runs — no per-game window binding,
/// no dead sources after a game update renames its window.
pub async fn ensure_autogame_source(client: &Client) -> Result<(), String> {
    const NAME: &str = "AutoGame";

    let inputs = client
        .inputs()
        .list(Some("game_capture"))
        .await
        .map_err(|e| e.to_string())?;
    if inputs.iter().any(|i| i.id.name == NAME) {
        return Ok(());
    }

    let scene = client
        .scenes()
        .current_program_scene()
        .await
        .map_err(|e| e.to_string())?;

    client
        .inputs()
        .create(obws::requests::inputs::Create {
            scene: scene.id.into(),
            input: NAME,
            kind: "game_capture",
            settings: Some(serde_json::json!({ "capture_mode": "any_fullscreen" })),
            enabled: Some(true),
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
