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

/// Surface a failure the same way a save success is surfaced — sound + OS
/// notification, not just an in-app banner. The app is normally minimized
/// or behind a fullscreen game exactly when this matters (hotkey pressed,
/// startup hotkey registration failed), so anything window-only is
/// invisible at the moment a friend would actually need to see it.
pub fn notify_failure(app: &AppHandle, title: &str, reason: &str) {
    unsafe {
        use windows::core::w;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC};
        let _ = PlaySoundW(w!("SystemHand"), None, SND_ALIAS | SND_ASYNC);
    }
    let _ = app.notification().builder().title(title).body(reason).show();
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

/// Re-push all ClipForge-managed OBS config (output path, tracks, replay
/// length, audio routing, video settings) right now, instead of waiting for
/// the next reconnect. Called by the frontend after the user changes settings
/// like the clips folder so the change lands in OBS immediately.
#[tauri::command]
pub async fn apply_obs_config(
    app: AppHandle,
    state: tauri::State<'_, ObsState>,
) -> Result<(), String> {
    let settings = crate::clips::load_settings_inner(&app);
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    crate::setup::ensure_output_config(client, &settings.clips_dir).await;
    crate::setup::ensure_replay_buffer_config(client, settings.replay_seconds).await;
    crate::setup::ensure_audio_devices(client).await;
    crate::setup::ensure_audio_tracks(client).await;
    crate::setup::ensure_video_settings(client, &settings).await;
    Ok(())
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

/// The universal `any_fullscreen` hook (`ensure_autogame_source`) misses a
/// lot of games in practice — anti-cheat, exclusive fullscreen, and some
/// borderless titles just don't get hooked by it. This binds a dedicated
/// source to one game, matched by executable name so it survives window
/// title/class changes across game updates and works whether or not the
/// game is running right now (OBS just starts capturing once it launches).
///
/// `kind` is either `"window_capture"` (BitBlt/WGC — often the more reliable
/// pick in practice) or `"game_capture"` (the DXGI hook — needed for some
/// exclusive-fullscreen or anti-cheat titles that block window capture).
fn game_capture_source_name(exe: &str) -> String {
    format!("Capture: {exe}")
}

const CAPTURE_KINDS: [&str; 2] = ["window_capture", "game_capture"];
/// OBS `enum window_priority`: 0 = class, 1 = title, 2 = executable.
const WINDOW_PRIORITY_EXE: i32 = 2;

#[tauri::command]
pub async fn add_game_capture_source(
    state: tauri::State<'_, ObsState>,
    exe: String,
    kind: String,
) -> Result<(), String> {
    if !CAPTURE_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown capture kind: {kind}"));
    }
    // Best-effort real title/class for a nicer label in OBS; matching is by
    // executable (priority below) either way, so an empty title/class when
    // the game isn't running is fine.
    let window = match crate::fullscreen::find_window_for_exe(&exe) {
        Some((title, class)) => format!("{title}:{class}:{exe}"),
        None => format!("::{exe}"),
    };
    let name = game_capture_source_name(&exe);

    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;

    // Replace any stale source for this game — same name, possibly a
    // different kind than last time, or a window/title that's since changed.
    // Input names are unique across ALL kinds in OBS, so an unconditional
    // remove-by-name is both simpler and more robust than filtering by kind
    // (kind filters can miss versioned-kind mismatches, leaving a stale
    // source that makes the create below fail with ResourceAlreadyExists).
    let _ = client.inputs().remove(name.as_str().into()).await;

    let scene = client
        .scenes()
        .current_program_scene()
        .await
        .map_err(|e| e.to_string())?;

    let settings = if kind == "game_capture" {
        serde_json::json!({
            "capture_mode": "window",
            "window": window,
            "priority": WINDOW_PRIORITY_EXE,
            "capture_cursor": true,
            "anti_cheat_hook": true,
        })
    } else {
        serde_json::json!({
            "window": window,
            "priority": WINDOW_PRIORITY_EXE,
            "cursor": true,
        })
    };

    client
        .inputs()
        .create(obws::requests::inputs::Create {
            scene: scene.id.into(),
            input: &name,
            kind: &kind,
            settings: Some(settings),
            enabled: Some(true),
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_game_capture_source(
    state: tauri::State<'_, ObsState>,
    exe: String,
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    client
        .inputs()
        .remove(game_capture_source_name(&exe).as_str().into())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GameSource {
    pub exe: String,
    pub kind: String,
}

/// Which games currently have a dedicated capture source configured (as
/// opposed to relying on the universal AutoGame fallback), and which kind.
#[tauri::command]
pub async fn list_game_capture_sources(
    state: tauri::State<'_, ObsState>,
) -> Result<Vec<GameSource>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    let mut out = Vec::new();
    for kind in CAPTURE_KINDS {
        let inputs = client
            .inputs()
            .list(Some(kind))
            .await
            .map_err(|e| e.to_string())?;
        out.extend(inputs.into_iter().filter_map(|i| {
            i.id.name
                .strip_prefix("Capture: ")
                .map(|exe| GameSource {
                    exe: exe.to_string(),
                    kind: kind.to_string(),
                })
        }));
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct CaptureTest {
    pub capturing: bool,
}

/// Ask OBS whether the source is actively rendering in the program output.
///
/// Deliberately uses `GetSourceActive`, NOT a source screenshot: forcing a
/// screenshot render of a game-capture hook can freeze OBS's preview and the
/// hook itself, which is exactly what broke on real hardware. This is a
/// lightweight query with no render side effects. It confirms the source is
/// live in the scene; whether the picture is actually the game (vs. black) is
/// something the user still confirms by eye or by saving a test clip.
#[tauri::command]
pub async fn test_capture_source(
    state: tauri::State<'_, ObsState>,
    name: String,
) -> Result<CaptureTest, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("not connected")?;
    let status = client
        .sources()
        .active(name.as_str().into())
        .await
        .map_err(|e| e.to_string())?;
    Ok(CaptureTest {
        capturing: status.active || status.showing,
    })
}
