use std::time::Duration;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::clips::load_settings_inner;
use crate::obs::{connect_internal, ensure_autogame_source, ObsState};

#[derive(Serialize, Clone, PartialEq, Default)]
pub struct SupervisorState {
    pub obs_running: bool,
    pub connected: bool,
    pub game: Option<String>,
    pub buffer_active: bool,
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
        if settings.password.is_none() {
            crate::setup::enable_websocket_server(false);
        }
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
                    crate::setup::ensure_output_config(client, &settings.clips_dir).await;
                    crate::setup::ensure_replay_buffer_config(client, settings.replay_seconds)
                        .await;
                    crate::setup::ensure_audio_devices(client).await;
                    crate::setup::ensure_audio_tracks(client).await;
                    // VC track binds now; the game-audio track binds when a
                    // game is actually detected (see the retarget below) —
                    // binding it to an arbitrary list entry here would sit on
                    // the wrong exe until then.
                    crate::setup::ensure_split_audio(client, None, &settings.vc_exe).await;
                    crate::setup::ensure_video_settings(client, &settings).await;
                }
            }
        }
    } else {
        state.connected = true;
    }
    if !state.connected {
        return state;
    }

    // 3. Game detection → buffer arm/disarm.
    // Exe whitelist first (works for alt-tabbed games), fullscreen
    // heuristic second (catches games missing from the list).
    let running: std::collections::HashSet<String> = system
        .processes()
        .values()
        .map(|p| p.name().to_string_lossy().to_lowercase())
        .collect();
    // Forget heuristic games whose process exited.
    session_games.retain(|g| running.contains(g));
    if let Some(fg) = crate::fullscreen::fullscreen_game() {
        // Auto-learn: remember this exe permanently so next time the game
        // arms the buffer even windowed or before it goes fullscreen — unless
        // the user blacklisted it (removed game / wrongly-detected non-game).
        let blacklisted = settings.game_blacklist.iter().any(|g| g.to_lowercase() == fg);
        if !blacklisted
            && session_games.insert(fg.clone())
            && !settings.game_exes.iter().any(|g| g.to_lowercase() == fg)
        {
            settings.game_exes.push(fg);
            let _ = crate::clips::save_settings(app.clone(), settings.clone());
        }
    }
    state.game = settings
        .game_exes
        .iter()
        .map(|g| g.to_lowercase())
        .find(|g| running.contains(g))
        .or_else(|| session_games.iter().next().cloned());

    let guard = obs_state.client.lock().await;
    if let Some(client) = guard.as_ref() {
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

        state.buffer_active = client.replay_buffer().status().await.unwrap_or(false);
        if settings.auto_manage_buffer {
            if state.game.is_some() && !state.buffer_active {
                if client.replay_buffer().start().await.is_ok() {
                    state.buffer_active = true;
                }
            } else if state.game.is_none() && state.buffer_active {
                // Disarm carefully — OBS's stop request can wedge it on
                // "Stopping Replay Buffer…" if it lands during encoder
                // teardown or while a save is still flushing to disk:
                //  - grace period: the game must be gone for ~30s (brief
                //    exits, crashes-and-relaunches, launcher hops don't
                //    cycle the buffer at all)
                //  - never stop within 15s of a replay save
                let save_recent = crate::obs::LAST_SAVE
                    .lock()
                    .map(|t| t.is_some_and(|t| t.elapsed() < Duration::from_secs(15)))
                    .unwrap_or(false);
                if *no_game_ticks >= 10 && !save_recent {
                    if client.replay_buffer().stop().await.is_ok() {
                        state.buffer_active = false;
                    }
                }
            }
        }
    }

    state
}
