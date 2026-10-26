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

/// PID of the admin game last warned about, so the toast shows once per run.
static WARNED_ELEVATED_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static RESTARTED_ELEVATED_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[derive(Debug, PartialEq)]
enum AdminAction { None, Warn, Restart }

fn admin_action(rule: &str, task_ready: bool, warned: bool, restarted: bool) -> AdminAction {
    if rule == "never" {
        AdminAction::None
    } else if rule == "auto" && task_ready {
        if restarted { AdminAction::None } else { AdminAction::Restart }
    } else if warned {
        AdminAction::None
    } else {
        AdminAction::Warn
    }
}

/// The running engine was started while adapter 0 was an integrated GPU.
static STARTED_ON_IGPU: AtomicBool = AtomicBool::new(false);
static IGPU_TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Seconds of a single-colour (black) or frozen picture before acting.
const SOLID_SECS: u32 = 20;
const FROZEN_SECS: u32 = 30;
/// The player counts as playing if they touched input this recently; an
/// idle player in front of a paused game isn't a frozen capture.
const ACTIVE_INPUT_SECS: u32 = 10;

#[derive(Debug, PartialEq)]
enum PictureAction { None, Rehook, WindowCapture, Warn }

/// What to do about the captured picture. `stage` counts earlier actions
/// this game run: first re-attach the capture; if a black picture persists
/// with the hook, switch to window capture; otherwise tell the user once.
fn picture_action(p: crate::picture::PictureState, stage: u8, hooked: bool) -> PictureAction {
    let solid = p.solid_secs >= SOLID_SECS;
    let frozen = p.still_secs >= FROZEN_SECS;
    match (solid || frozen, stage) {
        (false, _) => PictureAction::None,
        (true, 0) => PictureAction::Rehook,
        (true, 1) if solid && hooked => PictureAction::WindowCapture,
        (true, 1) => PictureAction::Warn,
        _ => PictureAction::None,
    }
}

/// (game, stage) for `picture_action`, reset when the game changes.
static PICTURE_STAGE: std::sync::Mutex<(Option<String>, u8)> = std::sync::Mutex::new((None, 0));

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
    /// The label clip files use for the game ("Valorant"), for display.
    pub game_label: Option<String>,
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
    /// The game runs as admin and ClipForge doesn't: capture and hotkeys
    /// can't reach it.
    pub game_elevated: bool,
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
    // libobs picks its GPU once, here. Started at login before the dGPU
    // driver is up, it lands on the iGPU (QuickSync, cross-adapter capture).
    let discrete = crate::gpu::primary_is_discrete();
    STARTED_ON_IGPU.store(!discrete, Ordering::Relaxed);
    if !discrete {
        crate::logs::line("capture engine starting on an integrated GPU");
    }
    crate::obs::blocking(move || {
        let video = crate::engine::video_config(settings.video_fps, settings.video_height);
        ENGINE.ensure_started(video, &crate::engine::AudioConfig::from_settings(&settings))?;
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

    // 1b. Engine came up on the iGPU but a discrete GPU is there now: libobs
    // can't switch adapters live, so relaunch onto it. Only fires if adapter
    // 0 really is the dGPU now, so a user's power-saving preference can't loop.
    if STARTED_ON_IGPU.load(Ordering::Relaxed) {
        // Every ~30s; enumerating adapters every tick is wasteful.
        if IGPU_TICKS.fetch_add(1, Ordering::Relaxed) % 10 == 9 && crate::gpu::primary_is_discrete() {
            crate::logs::line("discrete GPU appeared; restarting onto it");
            app.restart();
        }
    }

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
    state.game_label = state.game.as_deref().map(crate::obs::pretty_game_name);

    // Keep the game's icon for the library (once per game; needs its path,
    // which an admin game hides from a non-admin ClipForge).
    if let Some(path) = state.game.as_ref().and_then(|g| {
        system.processes().values().find(|p| p.name().to_string_lossy().eq_ignore_ascii_case(g)).and_then(|p| p.exe())
    }) {
        crate::gameicons::remember(app, path);
    }

    // A game running as admin is out of reach of a non-elevated ClipForge:
    // black clips and a dead save hotkey. Say so, once per game run.
    if let Some(g) = state.game.as_ref().filter(|_| !crate::elevation::is_elevated()) {
        let elevated_pid = system
            .processes()
            .values()
            .filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case(g))
            .map(|p| p.pid().as_u32())
            .find(|&pid| crate::elevation::process_elevated(pid));
        // The admin rule decides: "never" stays quiet, "auto" restarts
        // ClipForge elevated (when the task exists), "ask" warns once.
        let rule = settings.admin_rule_for(g).to_string();
        if let Some(pid) = elevated_pid.filter(|_| rule != "never") {
            state.game_elevated = true;
            let action = admin_action(
                &rule,
                rule == "auto" && crate::elevation::task_ready(),
                WARNED_ELEVATED_PID.load(Ordering::Relaxed) == pid,
                RESTARTED_ELEVATED_PID.load(Ordering::Relaxed) == pid,
            );
            if action != AdminAction::None {
                crate::logs::line(&format!("{g} runs as admin; ClipForge doesn't (rule: {rule})"));
                if action == AdminAction::Restart {
                    RESTARTED_ELEVATED_PID.store(pid, Ordering::Relaxed);
                    crate::logs::line("Restarting ClipForge as admin to match");
                    if let Err(error) = crate::elevation::restart_elevated(app.clone()) {
                        crate::logs::line(&format!("Could not restart as admin: {error}"));
                    }
                } else {
                    WARNED_ELEVATED_PID.store(pid, Ordering::Relaxed);
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("Can't capture this game")
                        .body("It runs as admin, so clips come out black and the save hotkey can't reach it. Open ClipForge to restart it as admin.")
                        .show();
                }
            }
        }
    }

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

    // Frozen or black picture while the player is actively in the game.
    // Anything else (alt-tabbed, idle, no game) restarts the count.
    // An unattached hook is black for a known reason (handled above).
    let watching = state.game.as_ref().filter(|g| {
        ENGINE.buffer_active()
            && crate::fullscreen::foreground_exe().as_deref() == Some(g.as_str())
            && crate::fullscreen::idle_secs() < ACTIVE_INPUT_SECS
            && (window_capture || ENGINE.info().game_hooked)
    });
    match watching {
        None => crate::picture::reset(),
        Some(game) => {
            let picture = crate::picture::state();
            // Decide and advance the stage under the lock; act after it.
            let action = {
                let mut stage = PICTURE_STAGE.lock().unwrap();
                if stage.0.as_deref() != Some(game.as_str()) {
                    *stage = (Some(game.clone()), 0);
                }
                let action = picture_action(picture, stage.1, !window_capture);
                stage.1 = match action {
                    PictureAction::None => stage.1,
                    PictureAction::Rehook | PictureAction::WindowCapture => 1,
                    PictureAction::Warn => 2,
                };
                action
            };
            let what = if picture.solid_secs >= SOLID_SECS { "black" } else { "frozen" };
            match action {
                PictureAction::None => {}
                PictureAction::Rehook => {
                    crate::logs::line(&format!("{game}: captured picture {what}; re-attaching capture"));
                    let _ = crate::obs::blocking(|| Ok(ENGINE.reset_target())).await;
                }
                PictureAction::WindowCapture => {
                    crate::picture::reset();
                    crate::obs::fall_back_to_window_capture(app, game, "Its captured picture stayed black.");
                }
                PictureAction::Warn => {
                    crate::picture::reset();
                    crate::logs::line(&format!("{game}: captured picture still {what} after re-attaching"));
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app
                        .notification()
                        .builder()
                        .title("Capture looks stuck")
                        .body(format!(
                            "ClipForge's picture of {} has been {what} for a while. Try Settings → Games → Test, or restart the game.",
                            crate::obs::pretty_game_name(game)
                        ))
                        .show();
                }
            }
        }
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
            match crate::obs::blocking(crate::setup::start_buffer).await {
                Ok(()) => state.buffer_active = true,
                Err(error) => state.engine_error = Some(error),
            }
            if let Some(msg) = crate::setup::FALLBACK_NOTICE.lock().unwrap().take() {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().builder().title("Switched video encoder").body(msg).show();
            }
        },
        BufferAction::Keep => {},
    }
    crate::session::tick(app, &settings, state.game.as_deref(), state.buffer_active).await;

    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_restart_is_independent_of_an_earlier_warning() {
        assert_eq!(admin_action("ask", false, false, false), AdminAction::Warn);
        assert_eq!(admin_action("ask", false, true, false), AdminAction::None);
        assert_eq!(admin_action("auto", true, true, false), AdminAction::Restart);
        assert_eq!(admin_action("auto", true, true, true), AdminAction::None);
        assert_eq!(admin_action("auto", false, false, false), AdminAction::Warn);
        assert_eq!(admin_action("never", true, false, false), AdminAction::None);
    }

    #[test]
    fn picture_recovery_steps() {
        use crate::picture::PictureState;
        let fine = PictureState { still_secs: 3, solid_secs: 0 };
        let black = PictureState { still_secs: 25, solid_secs: 25 };
        let frozen = PictureState { still_secs: 31, solid_secs: 0 };
        assert_eq!(picture_action(fine, 0, true), PictureAction::None);
        assert_eq!(picture_action(black, 0, true), PictureAction::Rehook);
        assert_eq!(picture_action(black, 1, true), PictureAction::WindowCapture);
        assert_eq!(picture_action(black, 1, false), PictureAction::Warn, "already window capture");
        assert_eq!(picture_action(frozen, 1, true), PictureAction::Warn, "frozen never switches methods");
        assert_eq!(picture_action(black, 2, true), PictureAction::None, "said so once");
    }

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
