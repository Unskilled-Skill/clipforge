//! Clip saving and capture control on top of the embedded engine
//! (`engine.rs`). Command names predate the engine (they used to drive OBS
//! Studio over obs-websocket) and are kept so the frontend stays unchanged.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

use crate::engine::ENGINE;

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

/// Short chimes embedded in the exe: rising = saved, falling = failed.
/// Our own sounds rather than Windows' system ones, which read as errors.
static SAVED_SOUND: &[u8] = include_bytes!("../sounds/clip-saved.wav");
static FAILED_SOUND: &[u8] = include_bytes!("../sounds/clip-failed.wav");

/// Play an embedded WAV without blocking (audible in-game feedback).
fn play(sound: &'static [u8]) {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    unsafe {
        let _ = PlaySoundW(PCWSTR(sound.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}

/// Rename a fresh clip to carry the game name, feedback via chime + toast.
/// If the short-clip hotkey triggered this save, keep only the tail.
/// Returns the clip's final path.
async fn on_clip_saved(app: &AppHandle, path: std::path::PathBuf, short: bool) -> String {
    if short {
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

    play(SAVED_SOUND);
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

    let final_str = final_path.to_string_lossy().replace('\\', "/");
    // Annotate the clip with recent kill positions (timeline markers).
    // The buffer ends at save time, so this works for hotkey saves too.
    crate::autoclip::write_kill_markers(&final_str);

    let _ = app.emit("clip-saved", ClipSaved { path: final_str.clone() });

    // Keep the folder under the storage cap; favorites survive.
    if let Err(error) = crate::clips::enforce_storage_cap_preserving(app, Some(&final_path)) {
        let _ = app.emit("clip-error", error);
    }
    final_str
}

/// Surface a failure the same way a save success is surfaced — chime + OS
/// notification, not just an in-app banner. The app is normally minimized
/// or behind a fullscreen game exactly when this matters (hotkey pressed,
/// startup hotkey registration failed), so anything window-only is
/// invisible at the moment a friend would actually need to see it.
pub fn notify_failure(app: &AppHandle, title: &str, reason: &str) {
    play(FAILED_SOUND);
    let _ = app.notification().builder().title(title).body(reason).show();
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

fn status() -> ObsStatus {
    let info = ENGINE.info();
    ObsStatus {
        connected: ENGINE.is_running(),
        replay_buffer_active: info.active,
        obs_version: info.version,
    }
}

/// Run blocking engine work off the async runtime.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Kept for the frontend's "connect" button: the supervisor starts the
/// engine, so this only reports its state (or why it failed to start).
#[tauri::command]
pub async fn obs_connect() -> Result<ObsStatus, String> {
    match ENGINE.error.lock().ok().and_then(|e| e.clone()) {
        Some(error) if !ENGINE.is_running() => Err(error),
        _ => Ok(status()),
    }
}

#[tauri::command]
pub async fn obs_status() -> Result<ObsStatus, String> {
    Ok(status())
}

/// Push all ClipForge-managed capture settings (clips folder, encoder,
/// bitrate, buffer length, video size, voice-chat app) to the engine now.
/// Output changes wait for the buffer to stop if it's recording.
#[tauri::command]
pub async fn apply_obs_config(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("obs-config-applying", ());
    let settings = crate::clips::load_settings_inner(&app);
    let result = blocking(move || crate::setup::apply_all(&settings)).await;
    let _ = app.emit("obs-config-applied", ());
    result
}

#[tauri::command]
pub async fn start_replay_buffer() -> Result<(), String> {
    blocking(|| ENGINE.start_buffer()).await
}

/// When the last replay save was requested. The supervisor won't stop the
/// buffer right after a save (the flush may still be writing).
pub static LAST_SAVE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
static SAVE_GATE: Mutex<()> = Mutex::const_new(());

/// Quitting ClipForge stops the buffer and shuts the engine down. A save
/// still flushing is allowed to finish first (it holds the save gate).
pub async fn stop_buffer_for_exit() {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), SAVE_GATE.lock()).await;
    let _ = blocking(|| {
        ENGINE.shutdown();
        Ok(())
    })
    .await;
}

/// Flush the replay buffer to disk. `short` trims the clip to its last N
/// seconds (short-clip hotkey).
pub async fn save_replay(app: &AppHandle, short: bool) -> Result<(), String> {
    save_replay_path(app, short).await.map(|_| ())
}

async fn save_replay_path(app: &AppHandle, short: bool) -> Result<String, String> {
    let _guard = SAVE_GATE
        .try_lock()
        .map_err(|_| "A clip is still saving. Wait for it to finish, then try again.")?;
    *LAST_SAVE.lock().unwrap() = Some(std::time::Instant::now());
    if !ENGINE.is_running() {
        return Err("The capture engine isn't running yet. Give it a few seconds, then try again.".into());
    }
    if !ENGINE.buffer_active() {
        // Nothing to flush. Arm it now so the next save works, and say so.
        let _ = blocking(|| ENGINE.start_buffer()).await;
        return Err(
            "Replay buffer wasn't recording yet — just started it. Play for a few seconds, then save again."
                .into(),
        );
    }
    let path = blocking(|| ENGINE.save()).await?;
    Ok(on_clip_saved(app, path, short).await)
}

#[tauri::command]
pub async fn save_setup_replay(app: AppHandle) -> Result<String, String> {
    save_replay_path(&app, false).await
}

#[tauri::command]
pub async fn save_replay_cmd(app: AppHandle) -> Result<(), String> {
    save_replay(&app, false).await
}

/// Capture method per game. The automatic hook (`game_capture`) follows the
/// detected game by exe; `window_capture` (WGC) is the per-game fallback for
/// games the hook shows black. Stored in settings, applied by the supervisor.
const CAPTURE_KINDS: [&str; 2] = ["window_capture", "game_capture"];

#[tauri::command]
pub async fn add_game_capture_source(app: AppHandle, exe: String, kind: String) -> Result<(), String> {
    let mut settings = crate::clips::load_settings_inner(&app);
    if settings.capture_blocked(&exe) {
        return Err(format!("{exe} is blocked. Remove it from the app blacklist first."));
    }
    if !CAPTURE_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown capture kind: {kind}"));
    }
    let exe = exe.trim().to_lowercase();
    settings.window_capture_games.retain(|g| *g != exe);
    if kind == "window_capture" {
        settings.window_capture_games.push(exe);
    }
    crate::clips::save_settings(app, settings)
}

#[tauri::command]
pub async fn remove_game_capture_source(app: AppHandle, exe: String) -> Result<(), String> {
    let mut settings = crate::clips::load_settings_inner(&app);
    settings
        .window_capture_games
        .retain(|g| !g.eq_ignore_ascii_case(exe.trim()));
    crate::clips::save_settings(app, settings)
}

#[derive(Serialize)]
pub struct GameSource {
    pub exe: String,
    pub kind: String,
}

/// Games switched to window capture (everything else uses the hook).
#[tauri::command]
pub async fn list_game_capture_sources(app: AppHandle) -> Result<Vec<GameSource>, String> {
    Ok(crate::clips::load_settings_inner(&app)
        .window_capture_games
        .into_iter()
        .map(|exe| GameSource { exe, kind: "window_capture".into() })
        .collect())
}

#[derive(Serialize)]
pub struct CaptureTest {
    pub capturing: bool,
}

/// Whether the capture source currently has a picture (the hook attached,
/// or the window was found). Whether it's the game rather than black is
/// still confirmed by eye or a test clip.
#[tauri::command]
pub async fn test_capture_source(name: String) -> Result<CaptureTest, String> {
    let _ = name;
    Ok(CaptureTest { capturing: ENGINE.info().game_hooked })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_game_names() {
        assert_eq!(pretty_game("valorant-win64-shipping.exe"), "Valorant");
        assert_eq!(pretty_game("deadlock.exe"), "Deadlock");
        assert_eq!(pretty_game("MyGame-Win64-Shipping.exe"), "Mygame");
    }
}
