use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};


use crate::clips::load_settings_inner;
use crate::obs::{connect_internal, ensure_autogame_source, ObsState};

/// User-requested pause: the buffer stays down regardless of running games
/// until unpaused. Deliberately session-only — a forgotten pause shouldn't
/// silently eat clips forever after a restart.
pub static BUFFER_PAUSED: AtomicBool = AtomicBool::new(false);

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
    /// OBS is running with its websocket server off (or never set up): the
    /// config can only be changed while OBS is closed, so the user has to
    /// close it once. Without this the app just sat disconnected.
    pub obs_needs_restart: bool,
    /// Connected OBS is too old for the recording format (version string).
    pub obs_outdated: Option<String>,
    /// The GPU is too busy with the game for OBS to render every frame
    /// (sustained over ~30s): clips will stutter.
    pub render_lag: bool,
    /// The encoder is dropping frames while the buffer records.
    pub encoder_lag: bool,
}

/// Background state machine, one tick every 3s:
///   1. OBS process missing → spawn it (tray-minimized)
///   2. websocket down → reconnect with saved credentials
///   3. game running → arm replay buffer; no game → disarm
/// Emits `supervisor-state` to the frontend whenever anything changes.
pub async fn run(app: AppHandle) {
    let mut system = System::new();
    let mut last_state = SupervisorState::default();
    // Skip the OBS-launch step right after a spawn so a slow-starting
    // OBS is not spawned twice.
    let mut launch_cooldown: u8 = 0;
    // Games discovered by the fullscreen heuristic. Once seen, the game
    // counts as running until its process exits — alt-tabbing out must
    // not disarm the buffer mid-match.
    let mut session_games: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Exe the GameAudio split-track is currently bound to; retarget on change.
    let mut audio_game: Option<String> = None;
    // Consecutive ticks without a detected game — the buffer only disarms
    // after a grace period, not the instant a game exits.
    let mut no_game_ticks: u32 = 0;

    loop {
        let state = tick(
            &app,
            &mut system,
            &mut launch_cooldown,
            &mut session_games,
            &mut audio_game,
            &mut no_game_ticks,
        )
        .await;
        if let Ok(mut current) = app.state::<crate::obs::CurrentGame>().0.lock() {
            *current = state.game.clone();
        }
        crate::clips::GAME_RUNNING.store(state.game.is_some(), Ordering::Relaxed);
        // Favorites go to the backup folder only between games, with the
        // buffer down, so uploads never compete with online play.
        if state.game.is_none() && !state.buffer_active {
            crate::backup::maybe_run(&app, false);
        }
        if state != last_state {
            let _ = app.emit("supervisor-state", state.clone());
            last_state = state;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn tick(
    app: &AppHandle,
    system: &mut System,
    launch_cooldown: &mut u8,
    session_games: &mut std::collections::HashSet<String>,
    audio_game: &mut Option<String>,
    no_game_ticks: &mut u32,
) -> SupervisorState {
    let mut settings = load_settings_inner(app);
    let mut state = SupervisorState::default();
    // First-run friendliness: detect OBS path / clips dir / websocket
    // password on machines that never configured anything.
    crate::setup::localize_settings(app, &mut settings);

    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );

    // 1. OBS process
    state.obs_running = system
        .processes()
        .values()
        .any(|p| p.name().eq_ignore_ascii_case("obs64.exe"));

    if !state.obs_running {
        // OBS closed = safe moment to switch its websocket server on and
        // mint a password if none exists; next tick picks the password up.
        // Unconditional (it's a no-op when already set up): a user who
        // switched the server off in OBS would otherwise stay disconnected.
        crate::setup::enable_websocket_server(false);
        // Also pre-seed global.ini so a freshly (silently) installed OBS
        // doesn't stall its first launch behind the Auto-Configuration Wizard.
        crate::setup::suppress_autoconfig_wizard(false);
        if *launch_cooldown > 0 {
            *launch_cooldown -= 1;
        } else if settings.auto_launch_obs {
            let exe = std::path::PathBuf::from(&settings.obs_path);
            if let Some(dir) = exe.parent() {
                let spawned = crate::clips::hidden_cmd(&exe)
                    .current_dir(dir)
                    .args(["--minimize-to-tray", "--disable-shutdown-check"])
                    .spawn();
                if spawned.is_ok() {
                    // ~5 ticks = 15s grace for OBS to boot
                    *launch_cooldown = 5;
                }
            }
        }
        return state;
    }

    // 2. Connection — verify liveness with a cheap request, not just presence.
    let obs_state = app.state::<ObsState>();
    let alive = {
        let guard = obs_state.client.lock().await;
        match guard.as_ref() {
            Some(client) => client.general().version().await.is_ok(),
            None => false,
        }
    };
    if !alive {
        *obs_state.client.lock().await = None;
        if settings.password.is_some() {
            state.connected = connect_internal(
                app,
                obs_state.inner(),
                settings.host.clone(),
                settings.port,
                settings.password.clone(),
            )
            .await
            .is_ok();
            if state.connected {
                let guard = obs_state.client.lock().await;
                if let Some(client) = guard.as_ref() {
                    let _ = ensure_autogame_source(client).await;
                    // Game-audio track binds when a game is actually detected
                    // (see the retarget below), so no game here.
                    crate::setup::apply_all(client, &settings, None).await;
                    let _ = app.emit("obs-config-applied", ());
                }
            }
        }
        if !state.connected {
            // Can't connect while OBS runs: either its websocket server is
            // off (only fixable with OBS closed — tell the user), or OBS has
            // a different password than we saved (user changed it; re-read).
            if settings.password.is_none() || !crate::setup::websocket_server_enabled() {
                state.obs_needs_restart = true;
            } else if let Some((password, port)) = crate::setup::read_websocket_password() {
                if settings.password.as_deref() != Some(password.as_str()) || settings.port != port {
                    settings.password = Some(password);
                    settings.port = port;
                    let _ = crate::clips::save_settings(app.clone(), settings.clone());
                }
            }
        }
    } else {
        state.connected = true;
    }
    if !state.connected {
        crate::health::reset();
        return state;
    }
    state.obs_outdated = crate::obs::outdated_obs_version(obs_state.inner());

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

    let guard = obs_state.client.lock().await;
    if let Some(client) = guard.as_ref() {
        // Constrain OBS itself: its old any_fullscreen source bypassed detection.
        if let Err(error) = crate::obs::enforce_capture_exclusions(client, &settings, state.game.as_deref()).await {
            eprintln!("Could not enforce capture exclusions: {error}");
            // Fail closed rather than record with a stale, possibly blocked source.
            let _ = client.replay_buffer().stop().await;
            state.buffer_active = client.replay_buffer().status().await.unwrap_or(false);
            return state;
        }
        // Point the GameAudio split-track at the game that's actually running.
        if let Some(game) = &state.game {
            if audio_game.as_deref() != Some(game.as_str()) {
                crate::setup::ensure_split_audio(client, Some(game), &settings.vc_exe).await;
                *audio_game = Some(game.clone());
            }
        }
        if state.game.is_some() {
            *no_game_ticks = 0;
        } else {
            *no_game_ticks = no_game_ticks.saturating_add(1);
        }
        // Output settings OBS hasn't picked up yet (it was busy when they
        // were written): reload once the buffer is down and no game runs.
        if state.game.is_none()
            && crate::setup::RELOAD_PENDING.load(Ordering::Relaxed)
            && crate::setup::reload_profile_if_idle(client).await
        {
            crate::setup::RELOAD_PENDING.store(false, Ordering::Relaxed);
        }

        state.buffer_active = client.replay_buffer().status().await.unwrap_or(false);
        crate::clips::GAME_RUNNING.store(state.game.is_some(), Ordering::Relaxed);
        // Only meaningful while a game is running and the buffer records;
        // a desktop with nothing to capture isn't "lagging".
        if let Ok(stats) = client.general().stats().await {
            let health = crate::health::record(&stats);
            state.render_lag = state.game.is_some() && crate::health::is_lagging(health.render_lag_pct);
            state.encoder_lag = state.buffer_active && crate::health::is_lagging(health.encoder_lag_pct);
        }
        state.paused = BUFFER_PAUSED.load(Ordering::Relaxed);
        // Never issue a stop within 15s of a replay save — OBS's stop can
        // wedge ("Stopping Replay Buffer…" forever) if it lands while the
        // flush is still writing.
        let save_recent = crate::obs::LAST_SAVE
            .lock()
            .map(|t| t.is_some_and(|t| t.elapsed() < Duration::from_secs(15)))
            .unwrap_or(false);
        match buffer_action(state.connected, state.game.is_some(), state.buffer_active,
            state.paused, settings.auto_manage_buffer, *no_game_ticks, save_recent) {
            BufferAction::Stop => {
                if client.replay_buffer().stop().await.is_ok() {
                    state.buffer_active = false;
                }
            },
            BufferAction::Start => {
                if client.replay_buffer().start().await.is_ok() {
                    state.buffer_active = true;
                }
            },
            BufferAction::Keep => {},
        }
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
