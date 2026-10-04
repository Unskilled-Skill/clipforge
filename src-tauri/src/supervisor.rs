use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};


use crate::clips::load_settings_inner;
use crate::engine::ENGINE;

/// User-requested pause: the buffer stays down regardless of running games
/// until unpaused. Deliberately session-only — a forgotten pause shouldn't
/// silently eat clips forever after a restart.
pub static BUFFER_PAUSED: AtomicBool = AtomicBool::new(false);

/// Latest state, for a window that opens (or reloads) after it was emitted:
/// `supervisor-state` only fires on changes, so a late listener would
/// otherwise show REC without knowing which game it records.
static LAST_STATE: std::sync::Mutex<Option<SupervisorState>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn supervisor_state() -> Option<SupervisorState> {
    LAST_STATE.lock().ok().and_then(|s| s.clone())
}

/// In-game ticks (3s each) the hook gets before falling back to window capture.
const HOOK_GRACE_TICKS: u32 = 10;

/// Set by the "Retry" buttons: skip the wait after a failed engine start.
pub static RETRY_ENGINE_NOW: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq)]
enum BufferAction { Keep, Start, Stop }

fn buffer_action(connected: bool, game: bool, active: bool, paused: bool,
    managed: bool, no_game_ticks: u32, save_recent: bool) -> BufferAction {
    if !connected { return BufferAction::Keep; }
    if paused {
        if active && !save_recent { BufferAction::Stop } else { BufferAction::Keep }
    } else if managed && game && !active {
        BufferAction::Start
    } else if managed && !game && active && no_game_ticks >= 10 && !save_recent {
        BufferAction::Stop
    } else { BufferAction::Keep }
}

#[derive(Serialize, Clone, PartialEq, Default)]
pub struct SupervisorState {
    pub obs_running: bool,
    pub connected: bool,
    pub game: Option<String>,
    pub buffer_active: bool,
    pub paused: bool,
    /// Kept false: the embedded engine has no websocket to switch on.
    pub obs_needs_restart: bool,
    /// Kept None: the engine ships its own OBS runtime.
    pub obs_outdated: Option<String>,
    /// First run: the capture engine's runtime is downloading.
    pub engine_downloading: bool,
    /// Why the capture engine couldn't start, if it couldn't.
    pub engine_error: Option<String>,
    /// The GPU is too busy with the game for OBS to render every frame
    /// (sustained over ~30s): clips will stutter.
    pub render_lag: bool,
    /// The encoder is dropping frames while the buffer records.
    pub encoder_lag: bool,
}

/// Background state machine, one tick every 3s:
///   1. capture engine down → download its runtime if needed, start it
///   2. settings → engine config (output changes wait for the buffer to stop)
///   3. game running → aim capture at it and arm the buffer; no game → disarm
/// Emits `supervisor-state` to the frontend whenever anything changes.
pub async fn run(app: AppHandle) {
    let mut system = System::new();
    let mut last_state = SupervisorState::default();
    // Games discovered by the fullscreen heuristic. Once seen, the game
    // counts as running until its process exits — alt-tabbing out must
    // not disarm the buffer mid-match.
    let mut session_games: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Consecutive ticks without a detected game — the buffer only disarms
    // after a grace period, not the instant a game exits.
    let mut no_game_ticks: u32 = 0;
    // Ticks to wait before retrying a failed engine start/download.
    let mut retry_in: u32 = 0;
    // Consecutive in-game ticks the game hook hasn't attached.
    let mut unhooked_ticks: u32 = 0;

    loop {
        let state = tick(&app, &mut system, &mut session_games, &mut no_game_ticks, &mut retry_in, &mut unhooked_ticks).await;
        if let Ok(mut current) = app.state::<crate::obs::CurrentGame>().0.lock() {
            *current = state.game.clone();
        }
        crate::clips::GAME_RUNNING.store(state.game.is_some(), Ordering::Relaxed);
        // Favorites go to the backup folder only between games, with the
        // buffer down, so uploads never compete with online play.
        if state.game.is_none() && !state.buffer_active {
            crate::backup::maybe_run(&app, false);
        }
        if let Ok(mut last) = LAST_STATE.lock() {
            *last = Some(state.clone());
        }
        if state != last_state {
            let _ = app.emit("supervisor-state", state.clone());
            last_state = state;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Bring the engine up: fetch the OBS runtime on first run, then start it
/// with the current settings applied.
/// Close an OBS Studio that older ClipForge versions launched in the
/// background (recognised by the flags they used): its game hook would
/// hold the game and keep the built-in engine from capturing it. An OBS
/// the user opened themselves is left alone.
fn close_legacy_obs(system: &mut System) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    for process in system.processes().values() {
        let ours = process.name().eq_ignore_ascii_case("obs64.exe")
            && process.cmd().iter().any(|a| a.to_string_lossy() == "--minimize-to-tray")
            && process.cmd().iter().any(|a| a.to_string_lossy() == "--disable-shutdown-check");
        if ours {
            process.kill();
        }
    }
}

async fn start_engine(app: &AppHandle, settings: &crate::clips::Settings, state: &mut SupervisorState) -> Result<(), String> {
    if !crate::engine::runtime_dir().join("obs.dll").exists() {
        state.engine_downloading = true;
        let _ = app.emit("supervisor-state", state.clone());
        crate::logs::line("downloading the capture engine");
        let progress_app = app.clone();
        let result = crate::engine::bootstrap(move |stage, pct| {
            let _ = progress_app.emit("engine-download-progress", serde_json::json!({ "stage": stage, "pct": pct }));
        })
        .await;
        state.engine_downloading = false;
        result.map_err(|e| format!("Couldn't download the capture engine: {e}"))?;
    }
    let settings = settings.clone();
    crate::obs::blocking(move || {
        let video = crate::engine::video_config(settings.video_fps, settings.video_height);
        ENGINE.ensure_started(video, &settings.vc_exe)?;
        crate::setup::apply_all(&settings)
    })
    .await?;
    let _ = app.emit("obs-config-applied", ());
    Ok(())
}

async fn tick(
    app: &AppHandle,
    system: &mut System,
    session_games: &mut std::collections::HashSet<String>,
    no_game_ticks: &mut u32,
    retry_in: &mut u32,
    unhooked_ticks: &mut u32,
) -> SupervisorState {
    let mut settings = load_settings_inner(app);
    let mut state = SupervisorState::default();
    crate::setup::localize_settings(app, &mut settings);

    // 1. Engine
    if !ENGINE.is_running() {
        crate::health::reset();
        if RETRY_ENGINE_NOW.swap(false, Ordering::Relaxed) {
            *retry_in = 0;
        }
        if *retry_in > 0 {
            *retry_in -= 1;
        } else if let Err(error) = {
            close_legacy_obs(system);
            start_engine(app, &settings, &mut state).await
        } {
            crate::logs::line(&error);
            if let Ok(mut slot) = ENGINE.error.lock() {
                *slot = Some(error.clone());
            }
            state.engine_error = Some(error);
            *retry_in = 20; // ~1 min
        }
        if !ENGINE.is_running() {
            state.engine_error = ENGINE.error.lock().ok().and_then(|e| e.clone());
            return state;
        }
    }
    state.obs_running = true;
    state.connected = true;

    // 2. Settings changed while recording land once the buffer is down.
    if crate::setup::RELOAD_PENDING.load(Ordering::Relaxed) && !ENGINE.buffer_active() {
        let s = settings.clone();
        let _ = crate::obs::blocking(move || crate::setup::apply_all(&s)).await;
    }

    // 3. Game detection → buffer arm/disarm.
    // Exe whitelist first (works for alt-tabbed games), fullscreen
    // heuristic second (catches games missing from the list).
    //
    // A process only counts as running if it owns a visible window: a game
    // hung at exit (dota2.exe wedged in kernel I/O, unkillable until
    // reboot) still enumerates as a process but has no windows — trusting
    // enumeration alone kept the buffer armed at an idle desktop and
    // blocked updates for as long as the corpse existed. Real games always
    // have a window, even alt-tabbed.
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let windowed = crate::fullscreen::pids_with_visible_windows();
    let running: std::collections::HashSet<String> = system
        .processes()
        .values()
        .filter(|p| windowed.contains(&p.pid().as_u32()))
        .map(|p| p.name().to_string_lossy().to_lowercase())
        .collect();
    // Forget heuristic games whose process exited.
    session_games.retain(|g| running.contains(g) && !settings.capture_blocked(g));
    let foreground = crate::fullscreen::fullscreen_game().filter(|g| !settings.capture_blocked(g));
    if let Some(fg) = foreground.as_ref() {
        // Auto-learn: remember this exe permanently so next time the game
        // arms the buffer even windowed or before it goes fullscreen — unless
        // the user blacklisted it (removed game / wrongly-detected non-game).
        if session_games.insert(fg.clone())
            && !settings.game_exes.iter().any(|g| g.eq_ignore_ascii_case(fg))
        {
            settings.game_exes.push(fg.clone());
            let _ = crate::clips::save_settings(app.clone(), settings.clone());
        }
    }
    state.game = foreground.or_else(|| settings
        .game_exes
        .iter()
        .map(|g| g.to_lowercase())
        .find(|g| running.contains(g) && !settings.capture_blocked(g))
        .or_else(|| session_games.iter().next().cloned()));

    // Aim the capture at the game (or idle it). Blocked apps never reach
    // here: `state.game` is already filtered.
    let game = state.game.clone();
    let window_capture = game
        .as_ref()
        .is_some_and(|g| settings.window_capture_games.iter().any(|w| w.eq_ignore_ascii_case(g)));
    if let Err(error) = crate::obs::blocking(move || ENGINE.set_game(game.as_deref(), window_capture)).await {
        crate::logs::line(&format!("Could not retarget capture: {error}"));
        // Fail closed rather than record with a stale, possibly blocked target.
        let _ = crate::obs::blocking(|| ENGINE.stop_buffer()).await;
        state.buffer_active = ENGINE.buffer_active();
        return state;
    }
    if state.game.is_some() {
        *no_game_ticks = 0;
    } else {
        *no_game_ticks = no_game_ticks.saturating_add(1);
    }

    // Hook never attaching while the player is in the game (anti-cheat,
    // some launchers' wrappers): after ~30s, switch that game to window
    // capture rather than keep recording nothing. Only in-game time counts:
    // a minimized or alt-tabbed game doesn't present frames to hook.
    match (&state.game, window_capture) {
        (Some(game), false) if ENGINE.buffer_active() && crate::fullscreen::foreground_exe().as_deref() == Some(game.as_str()) => {
            if ENGINE.info().game_hooked {
                *unhooked_ticks = 0;
            } else {
                *unhooked_ticks += 1;
                if *unhooked_ticks >= HOOK_GRACE_TICKS {
                    *unhooked_ticks = 0;
                    crate::obs::fall_back_to_window_capture(app, game, "Game capture couldn't attach to it.");
                }
            }
        }
        (None, _) | (_, true) => *unhooked_ticks = 0,
        _ => {}
    }

    state.buffer_active = ENGINE.buffer_active();
    crate::clips::GAME_RUNNING.store(state.game.is_some(), Ordering::Relaxed);
    // Only meaningful while a game is running and the buffer records;
    // a desktop with nothing to capture isn't "lagging".
    if let Some(counters) = ENGINE.frame_counters() {
        let health = crate::health::record(counters);
        state.render_lag = state.game.is_some() && crate::health::is_lagging(health.render_lag_pct);
        state.encoder_lag = state.buffer_active && crate::health::is_lagging(health.encoder_lag_pct);
    }
    state.paused = BUFFER_PAUSED.load(Ordering::Relaxed);
    // Never stop within 15s of a replay save — the flush may still be writing.
    let save_recent = crate::obs::LAST_SAVE
        .lock()
        .map(|t| t.is_some_and(|t| t.elapsed() < Duration::from_secs(15)))
        .unwrap_or(false);
    match buffer_action(state.connected, state.game.is_some(), state.buffer_active,
        state.paused, settings.auto_manage_buffer, *no_game_ticks, save_recent) {
        BufferAction::Stop => {
            if crate::obs::blocking(|| ENGINE.stop_buffer()).await.is_ok() {
                state.buffer_active = false;
            }
        },
        BufferAction::Start => {
            match crate::obs::blocking(|| ENGINE.start_buffer()).await {
                Ok(()) => state.buffer_active = true,
                Err(error) => state.engine_error = Some(error),
            }
        },
        BufferAction::Keep => {},
    }

    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arms_only_for_a_connected_game_and_rearms_after_reconnect() {
        assert_eq!(buffer_action(true, false, false, false, true, 0, false), BufferAction::Keep);
        assert_eq!(buffer_action(false, true, false, false, true, 0, false), BufferAction::Keep);
        assert_eq!(buffer_action(true, true, false, false, true, 0, false), BufferAction::Start);
        assert_eq!(buffer_action(true, true, true, false, true, 0, false), BufferAction::Keep);
    }

    #[test]
    fn exit_grace_and_pending_save_protect_the_buffer() {
        assert_eq!(buffer_action(true, false, true, false, true, 9, false), BufferAction::Keep);
        assert_eq!(buffer_action(true, false, true, false, true, 10, true), BufferAction::Keep);
        assert_eq!(buffer_action(true, false, true, false, true, 10, false), BufferAction::Stop);
    }

    #[test]
    fn pause_and_manual_control() {
        assert_eq!(buffer_action(true, true, false, true, true, 0, false), BufferAction::Keep);
        assert_eq!(buffer_action(true, true, true, true, false, 0, false), BufferAction::Stop);
        assert_eq!(buffer_action(true, true, true, true, true, 0, true), BufferAction::Keep);
        assert_eq!(buffer_action(true, true, false, false, false, 0, false), BufferAction::Keep);
        assert_eq!(buffer_action(true, false, true, false, false, 50, false), BufferAction::Keep);
    }
}
