//! Event-driven auto-clipping — zero cost unless a supported game runs.
//!
//! CS2 pushes kill events to us over Game State Integration (the game
//! POSTs JSON to a localhost port — no polling at all). League is polled
//! via its official local live-client API, only while it is running.
//! Other tools can trigger clips through a Medal-compatible endpoint,
//! `POST /api/v1/event/invoke`, on the same port.
//! A kill opens an event window; further kills extend it, so a multikill
//! ends up in one clip. Like Medal's event system, the saved clip covers
//! the first kill minus `PRE_ROLL` through the last kill plus the window,
//! capped at `MAX_AUTO_CLIP`, not the whole replay buffer.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// A user-extendable log trigger: when `game_exe` is the active game,
/// tail `log_path` and auto-clip whenever a line matches `pattern`.
/// Lives in <app config>/log_triggers.json.
#[derive(Serialize, Deserialize, Clone)]
pub struct LogTrigger {
    pub game_exe: String,
    /// May contain %ENV% variables, e.g. "%LOCALAPPDATA%/MyGame/game.log".
    pub log_path: String,
    /// Regex matched against each new log line.
    pub pattern: String,
}

fn expand_env(path: &str) -> String {
    let mut out = path.to_string();
    for var in ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "PROGRAMDATA"] {
        if let Ok(val) = std::env::var(var) {
            out = out
                .replace(&format!("%{var}%"), &val)
                .replace(&format!("${var}"), &val);
        }
    }
    out.replace('\\', "/")
}

fn triggers_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("log_triggers.json"))
}

fn load_triggers(app: &AppHandle) -> Vec<LogTrigger> {
    let Some(path) = triggers_path(app) else {
        return Vec::new();
    };
    if !path.exists() {
        // Seed an example file so users see the format.
        let example = r#"[
  {
    "_comment": "Example — find your game's kill line, add an entry, restart the app.",
    "game_exe": "example.exe",
    "log_path": "%LOCALAPPDATA%/Example/Saved/Logs/game.log",
    "pattern": "KillFeed: you eliminated"
  }
]"#;
        let _ = std::fs::write(&path, example);
        return Vec::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|v| serde_json::from_value::<LogTrigger>(v).ok())
                .filter(|t| t.game_exe != "example.exe")
                .collect()
        })
        .unwrap_or_default()
}

/// Tail state for the active log trigger.
struct LogTail {
    path: String,
    offset: u64,
    regex: regex::Regex,
}

static LOG_TAIL: Mutex<Option<LogTail>> = Mutex::new(None);

/// Check the active game's log for new matching lines.
fn poll_log_trigger(app: &AppHandle, game: &str, delay_s: f64) {
    if !crate::clips::load_settings_inner(app).clip_rule(&crate::clips::auto_clip_game_id(game)).enabled {
        return;
    }
    let trigger = load_triggers(app)
        .into_iter()
        .find(|t| t.game_exe.to_lowercase() == game)
        .or_else(|| crate::gamesources::builtin_log_trigger(game));
    let Some(trigger) = trigger else {
        *LOG_TAIL.lock().unwrap() = None;
        return;
    };

    let path = expand_env(&trigger.log_path);
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    let size = meta.len();

    let mut tail = LOG_TAIL.lock().unwrap();
    let state = match tail.as_mut() {
        Some(t) if t.path == path => t,
        _ => {
            let Ok(regex) = regex::Regex::new(&trigger.pattern) else {
                return;
            };
            // Start at EOF — history is not new kills.
            *tail = Some(LogTail {
                path: path.clone(),
                offset: size,
                regex,
            });
            return;
        }
    };
    if size < state.offset {
        state.offset = 0; // log rotated
    }
    if size == state.offset {
        return;
    }

    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(&path) else {
        return;
    };
    if file.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }
    let mut new_bytes = String::new();
    let _ = file.take(512 * 1024).read_to_string(&mut new_bytes);
    state.offset = size;

    if new_bytes.lines().any(|l| state.regex.is_match(l)) {
        schedule_clip(app, delay_s);
    }
}

const GSI_PORT: u16 = 3888;
/// Sent back by CS2 with every payload; anything else on the port is ignored.
const GSI_TOKEN: &str = "clipforge-gsi-v1";

/// Seconds kept before the first event of a window (the play leading up).
const PRE_ROLL: f64 = 10.0;
/// Longest auto clip; a window that runs longer keeps its newest part.
const MAX_AUTO_CLIP: f64 = 120.0;

/// An open event window.
struct Pending {
    /// First event in the window: the clip starts `PRE_ROLL` before it.
    first: Instant,
    /// When the clip is saved (slides forward on each event).
    deadline: Instant,
    /// Kills in this window from a source that counts them (Valorant).
    kills: u32,
    /// The round's kill total at the newest of those kills.
    round_kills: u32,
    /// Fewer counted kills than this and the window is dropped unsaved.
    min_kills: u32,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// `round_kills` from our own player's last CS2 GSI payload (-1 = unknown).
static CS2_ROUND_KILLS: AtomicI64 = AtomicI64::new(-1);
/// CS2 round mode (a minimum above one kill): the round's first kill and
/// kill count, saved as one clip when the round ends.
static CS2_ROUND: Mutex<Option<(Instant, u32)>> = Mutex::new(None);
/// `player.kills` from the last Dota 2 GSI payload (-1 = unknown).
static DOTA_KILLS: AtomicI64 = AtomicI64::new(-1);
/// Highest LoL event id already processed.
static LOL_LAST_EVENT: AtomicI64 = AtomicI64::new(-1);
static GSI_CONFIG_DONE: AtomicBool = AtomicBool::new(false);

/// Instants of recent detected kills, kept so a saved clip can be annotated
/// with where in its timeline each kill sits (timeline kill markers).
/// Pruned to the longest window a replay buffer can reach back.
static KILL_TIMES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
const KILL_RETENTION: Duration = Duration::from_secs(960); // > max replay_seconds

pub fn record_kill() {
    let mut kills = KILL_TIMES.lock().unwrap();
    let now = Instant::now();
    kills.retain(|t| now.duration_since(*t) < KILL_RETENTION);
    kills.push(now);
    if let Some(session) = SESSION_KILLS.lock().unwrap().as_mut() {
        session.push(now);
    }
}

/// Kills during the running full-session recording (None = no session):
/// they become its timeline bookmarks.
static SESSION_KILLS: Mutex<Option<Vec<Instant>>> = Mutex::new(None);

pub fn begin_session() {
    *SESSION_KILLS.lock().unwrap() = Some(Vec::new());
}

pub fn end_session() -> Vec<Instant> {
    SESSION_KILLS.lock().unwrap().take().unwrap_or_default()
}

/// Write the kill-marker sidecar for a clip that just hit disk: every
/// recorded kill inside the clip's window, as seconds from clip start.
/// The replay buffer always ends "now", so a kill K seconds ago sits at
/// `duration - K`. Works for hotkey saves too — any kill-tracked game
/// gets markers, not just auto-clipped saves.
/// `saved_at` is when the save was requested: the clip's last frame. Later
/// processing (renaming, short-clip trim) must not shift the markers.
pub fn write_kill_markers(clip_path: &str, saved_at: Instant) {
    let kills: Vec<Instant> = KILL_TIMES.lock().unwrap().clone();
    if kills.is_empty() {
        return;
    }
    let Ok(duration) = crate::clips::probe_clip_duration(clip_path) else {
        return;
    };
    let markers: Vec<f64> = kills
        .iter()
        .map(|t| duration - saved_at.saturating_duration_since(*t).as_secs_f64())
        .filter(|s| *s >= 0.0 && *s <= duration)
        .collect();
    if !markers.is_empty() {
        crate::clips::write_markers(clip_path, &markers);
    }
}

fn schedule_clip(app: &AppHandle, delay_s: f64) {
    open_window(app, delay_s, None);
}

/// `counted`: (round kill total, minimum window kills) from a source that
/// counts kills; None for sources that only say "something happened".
fn open_window(app: &AppHandle, delay_s: f64, counted: Option<(u32, u32)>) {
    record_kill();
    let now = Instant::now();
    let deadline = now + Duration::from_secs_f64(delay_s.max(2.0));
    let mut pending = PENDING.lock().unwrap();
    let p = pending.get_or_insert_with(|| {
        let _ = app.emit("auto-clip-armed", ());
        Pending { first: now, deadline, kills: 0, round_kills: 0, min_kills: 1 }
    });
    p.deadline = deadline;
    if let Some((round_kills, min_kills)) = counted {
        p.kills += 1;
        p.round_kills = p.round_kills.max(round_kills);
        p.min_kills = min_kills;
    }
}

/// Open or extend the event window for a highlight from any source.
pub fn schedule(app: &AppHandle) {
    schedule_clip(app, crate::clips::load_settings_inner(app).auto_clip_delay_s);
}

/// A kill from a source that knows the round's kill total (Valorant).
/// The window is saved only if it holds at least `min_kills` kills.
pub fn schedule_counted(app: &AppHandle, round_kills: u32, min_kills: u32) {
    let delay = crate::clips::load_settings_inner(app).auto_clip_delay_s;
    open_window(app, delay, Some((round_kills, min_kills)));
}

/// Filename tag for a multikill: "ACE" once the round reaches 5 kills,
/// else "2K".."4K" for kills in the clip; none for a single kill.
pub fn kill_label(kills: u32, round_kills: u32) -> Option<String> {
    if round_kills >= 5 {
        Some("ACE".into())
    } else if kills >= 2 {
        Some(format!("{kills}K"))
    } else {
        None
    }
}

/// Save one clip covering a whole round's kills, from `PRE_ROLL` before the
/// first (round mode: "only rounds with N+ kills" is known at round end).
pub fn save_round(app: &AppHandle, first_kill: Instant, kills: u32) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let keep = window_length(first_kill, Instant::now());
        let label = kill_label(kills, kills);
        crate::logs::line(&format!("auto-clip: round with {kills} kills, saving last {keep:.0}s"));
        if crate::obs::save_replay_keep(&app, keep, label.as_deref()).await.is_ok() {
            let _ = app.emit("auto-clipped", ());
        }
    });
}

/// Seconds an auto clip saved now keeps: back to `PRE_ROLL` before the
/// window's first event, capped at `MAX_AUTO_CLIP`.
fn window_length(first: Instant, now: Instant) -> f64 {
    (now.saturating_duration_since(first).as_secs_f64() + PRE_ROLL).min(MAX_AUTO_CLIP)
}

pub async fn run(app: AppHandle) {
    tauri::async_runtime::spawn(gsi_listener(app.clone()));
    tauri::async_runtime::spawn(crate::gamesources::rocket_league(app.clone()));
    // CS2 and Dota read GSI configs only at launch, so write ours before
    // the game starts, not when it's detected (too late for that session).
    if install_gsi_configs() {
        GSI_CONFIG_DONE.store(true, Ordering::Relaxed);
    }

    let lol_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // Riot's local API uses a self-signed cert
        .timeout(Duration::from_secs(2))
        .build()
        .ok();

    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let settings = crate::clips::load_settings_inner(&app);
        if !settings.auto_clip {
            *PENDING.lock().unwrap() = None;
            continue;
        }

        // Fire the pending clip once its window has passed.
        let due = {
            let mut pending = PENDING.lock().unwrap();
            let now = Instant::now();
            match pending.as_ref() {
                Some(p) if now >= p.deadline => {
                    let keep = window_length(p.first, now);
                    let worth = p.kills >= p.min_kills;
                    let label = kill_label(p.kills, p.round_kills);
                    *pending = None;
                    if !worth {
                        crate::logs::line("auto-clip: skipped, fewer kills than the minimum");
                    }
                    worth.then_some((keep, label))
                }
                _ => None,
            }
        };
        if let Some((keep, label)) = due {
            crate::logs::line(&format!("auto-clip: saving last {keep:.0}s"));
            if crate::obs::save_replay_keep(&app, keep, label.as_deref()).await.is_ok() {
                let _ = app.emit("auto-clipped", ());
            }
        }

        let game = app
            .state::<crate::obs::CurrentGame>()
            .0
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_default();

        if game.contains("cs2") && !GSI_CONFIG_DONE.load(Ordering::Relaxed) {
            if install_gsi_configs() {
                GSI_CONFIG_DONE.store(true, Ordering::Relaxed);
            }
        }
        if game.contains("league of legends") {
            if let Some(client) = &lol_client {
                poll_lol(&app, client, settings.auto_clip_delay_s).await;
            }
        } else {
            LOL_LAST_EVENT.store(-1, Ordering::Relaxed);
        }

        if !game.is_empty() {
            poll_log_trigger(&app, &game, settings.auto_clip_delay_s);
        }
    }
}

/// Minimal HTTP listener for CS2 Game State Integration payloads.
async fn gsi_listener(app: AppHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", GSI_PORT)).await else {
        return; // port taken — auto-clip for CS2 unavailable this session
    };

    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = Vec::with_capacity(8192);
            let mut tmp = [0u8; 4096];
            // Read until we have the full body per Content-Length.
            loop {
                let Ok(n) = stream.read(&mut tmp).await else {
                    return;
                };
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(body_start) = find_body(&buf) {
                    let need = content_length(&buf).unwrap_or(0);
                    if buf.len() - body_start >= need {
                        break;
                    }
                }
                if buf.len() > 1_000_000 {
                    return; // not a GSI payload
                }
            }
            // Web pages always send an http(s) Origin; the game and local
            // tools don't. Refusing those keeps
            // websites from triggering clips (Medal does the same).
            if from_web_page(&buf) {
                let _ = stream
                    .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return;
            }
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;

            let Some(body_start) = find_body(&buf) else {
                return;
            };
            let Ok(json) = serde_json::from_slice::<serde_json::Value>(&buf[body_start..]) else {
                return;
            };
            if buf.starts_with(b"POST /api/v1/event/invoke") {
                handle_event_invoke(&app, &json);
            } else if json["provider"]["appid"] == DOTA_APPID {
                handle_dota_payload(&app, &json);
            } else {
                handle_cs2_payload(&app, &json);
            }
        });
    }
}

fn find_body(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn content_length(buf: &[u8]) -> Option<usize> {
    let head = std::str::from_utf8(buf).ok()?;
    head.lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
}

fn from_web_page(request: &[u8]) -> bool {
    let head_end = find_body(request).unwrap_or(request.len());
    let Ok(head) = std::str::from_utf8(&request[..head_end]) else {
        return false;
    };
    head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("origin:") && l["origin:".len()..].trim().starts_with("http")
    })
}

/// Whether this CS2 payload carries a new kill by us. Diffs `round_kills`
/// (in `player_state`) against our last own payload; skips spectated
/// players (dead or watching) and warmup/freezetime/intermission/gameover.
fn cs2_new_kill(json: &serde_json::Value, last_round_kills: &AtomicI64) -> bool {
    if json["auth"]["token"] != GSI_TOKEN {
        return false;
    }
    let own = json["provider"]["steamid"].as_str().is_some()
        && json["provider"]["steamid"] == json["player"]["steamid"];
    if !own {
        return false;
    }
    let Some(kills) = json["player"]["state"]["round_kills"].as_i64() else {
        return false;
    };
    let last = last_round_kills.swap(kills, Ordering::Relaxed);
    let map_phase = json["map"]["phase"].as_str().unwrap_or("live");
    let round_phase = json["round"]["phase"].as_str().unwrap_or("live");
    let playing = !matches!(map_phase, "warmup" | "intermission" | "gameover")
        && round_phase != "freezetime";
    playing && last >= 0 && kills > last
}

fn handle_cs2_payload(app: &AppHandle, json: &serde_json::Value) {
    if let Some(update)=crate::matchdata::cs2_update(json) { crate::matchdata::ingest(app,"cs2.exe","cs2-gsi",update); }
    let rule = crate::clips::load_settings_inner(app).clip_rule("cs2");
    if cs2_new_kill(json, &CS2_ROUND_KILLS) && rule.enabled {
        let hs = json["player"]["state"]["round_killhs"].as_i64().unwrap_or(0);
        crate::logs::line(&format!("auto-clip: cs2 kill (round headshots {hs})"));
        let round_kills = CS2_ROUND_KILLS.load(Ordering::Relaxed).max(0) as u32;
        if rule.min_kills > 1 {
            record_kill();
            CS2_ROUND.lock().unwrap().get_or_insert((Instant::now(), 0)).1 = round_kills;
        } else {
            schedule_counted(app, round_kills, 1);
        }
    }
    // Round mode: the round is judged when it ends.
    if json["auth"]["token"] == GSI_TOKEN
        && (json["round"]["phase"] == "over" || json["map"]["phase"] == "gameover")
    {
        if let Some((first, kills)) = CS2_ROUND.lock().unwrap().take() {
            if rule.enabled && kills >= rule.min_kills {
                save_round(app, first, kills);
            } else {
                crate::logs::line("auto-clip: cs2 round skipped, fewer kills than the minimum");
            }
        }
    }
}

const DOTA_APPID: i64 = 570;

/// Whether this Dota 2 payload carries a new kill by us. While spectating,
/// `player` holds every player keyed by team, so `player.kills` is absent.
fn dota_new_kill(json: &serde_json::Value, last_kills: &AtomicI64) -> bool {
    if json["auth"]["token"] != GSI_TOKEN {
        return false;
    }
    let Some(kills) = json["player"]["kills"].as_i64() else {
        return false;
    };
    let last = last_kills.swap(kills, Ordering::Relaxed);
    last >= 0 && kills > last
}

fn handle_dota_payload(app: &AppHandle, json: &serde_json::Value) {
    if dota_new_kill(json, &DOTA_KILLS) {
        let rule = crate::clips::load_settings_inner(app).clip_rule("dota2");
        if !rule.enabled {
            return;
        }
        crate::logs::line("auto-clip: dota 2 kill");
        schedule_counted(app, 0, rule.min_kills);
    }
}

/// Medal's third-party game API shape: `{"eventId", "eventName",
/// "triggerActions": ["SaveClip"], ...}`, so a game, mod or script can ask
/// for a clip. An event that only asks for a screenshot is ignored.
fn handle_event_invoke(app: &AppHandle, json: &serde_json::Value) {
    if let Some(actions) = json["triggerActions"].as_array() {
        if !actions.iter().any(|a| a == "SaveClip") {
            return;
        }
    }
    let name = json["eventName"].as_str().or(json["eventId"].as_str()).unwrap_or("event");
    crate::logs::line(&format!("auto-clip: api event {name}"));
    schedule_clip(app, crate::clips::load_settings_inner(app).auto_clip_delay_s);
}

/// Poll League's local live-client API for ChampionKill events by us.
async fn poll_lol(app: &AppHandle, client: &reqwest::Client, delay_s: f64) {
    let Ok(resp) = client
        .get("https://127.0.0.1:2999/liveclientdata/activeplayername")
        .send()
        .await
    else {
        return; // not in a match yet
    };
    let Ok(me) = resp.json::<String>().await else {
        return;
    };
    // "Name#TAG" -> "Name" (events use the plain name)
    let me = me.split('#').next().unwrap_or(&me).to_string();

    let Ok(resp) = client
        .get("https://127.0.0.1:2999/liveclientdata/eventdata")
        .send()
        .await
    else {
        return;
    };
    let Ok(data) = resp.json::<serde_json::Value>().await else {
        return;
    };
    let Some(events) = data["Events"].as_array() else {
        return;
    };

    let last = LOL_LAST_EVENT.load(Ordering::Relaxed);
    let mut newest = last;
    let mut kill = false;
    for event in events {
        let id = event["EventID"].as_i64().unwrap_or(-1);
        if id <= last {
            continue;
        }
        newest = newest.max(id);
        // Skip the backlog on first poll of a match. Objectives we last-hit
        // count too (Medal clips these as well).
        let highlight = matches!(
            event["EventName"].as_str(),
            Some("ChampionKill" | "DragonKill" | "BaronKill" | "HeraldKill" | "HordeKill")
        );
        if last >= 0 && highlight && event["KillerName"].as_str() == Some(me.as_str())
        {
            kill = true;
        }
    }
    LOL_LAST_EVENT.store(newest, Ordering::Relaxed);
    let rule = crate::clips::load_settings_inner(app).clip_rule("lol");
    if kill && rule.enabled {
        open_window(app, delay_s, Some((0, rule.min_kills)));
    }
}

/// GSI config telling a Valve game to POST `data` sections to us.
fn gsi_config(data: &[&str]) -> String {
    let data: String = data.iter().map(|k| format!("  \"{k}\" \"1\"\n")).collect();
    format!(
        "\"ClipForge GSI\"\n{{\n \"uri\" \"http://127.0.0.1:{GSI_PORT}\"\n \
         \"timeout\" \"1.0\"\n \"buffer\" \"0.1\"\n \"throttle\" \"0.1\"\n \
         \"heartbeat\" \"30.0\"\n \"auth\"\n {{\n  \"token\" \"{GSI_TOKEN}\"\n }}\n \
         \"data\"\n {{\n{data} }}\n}}\n"
    )
}

/// Drop ClipForge's GSI config into CS2's and Dota 2's cfg folders so the
/// games know where to send events. True if at least one was written.
fn install_gsi_configs() -> bool {
    let games: [(&str, &str, &[&str]); 2] = [
        (
            "Counter-Strike Global Offensive",
            "game/csgo/cfg",
            &["provider", "map", "round", "player_id", "player_state"],
        ),
        (
            "dota 2 beta",
            "game/dota/cfg/gamestate_integration",
            &["provider", "map", "player", "hero"],
        ),
    ];
    let mut any = false;
    for (folder, cfg_sub, data) in games {
        let Some(dir) = crate::gamesources::steam_game_dir(folder) else {
            continue;
        };
        let cfg_dir = dir.join(cfg_sub);
        let file = cfg_dir.join("gamestate_integration_clipforge.cfg");
        if std::fs::create_dir_all(&cfg_dir).and_then(|_| std::fs::write(file, gsi_config(data))).is_ok() {
            any = true;
        }
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(round_kills: i64, player: &str, round_phase: &str) -> serde_json::Value {
        json!({
            "auth": {"token": GSI_TOKEN},
            "provider": {"steamid": "me"},
            "map": {"phase": "live"},
            "round": {"phase": round_phase},
            "player": {"steamid": player, "state": {"round_kills": round_kills}},
        })
    }

    #[test]
    fn cs2_kill_counts_only_own_live_kills() {
        let last = AtomicI64::new(-1);
        assert!(!cs2_new_kill(&payload(0, "me", "live"), &last), "first payload is a baseline");
        assert!(cs2_new_kill(&payload(1, "me", "live"), &last));
        assert!(!cs2_new_kill(&payload(3, "other", "live"), &last), "spectated player");
        assert!(!cs2_new_kill(&payload(0, "me", "freezetime"), &last), "new round resets");
        assert!(cs2_new_kill(&payload(1, "me", "live"), &last));
        let mut foreign = payload(2, "me", "live");
        foreign["auth"]["token"] = json!("other");
        assert!(!cs2_new_kill(&foreign, &last), "another app's GSI config");
    }

    #[test]
    fn dota_kill_counts_own_kills_only() {
        let last = AtomicI64::new(-1);
        let own = |kills: i64| json!({"auth": {"token": GSI_TOKEN}, "provider": {"appid": 570}, "player": {"kills": kills}});
        assert!(!dota_new_kill(&own(0), &last));
        assert!(dota_new_kill(&own(1), &last));
        assert!(!dota_new_kill(&own(1), &last));
        let spectating = json!({"auth": {"token": GSI_TOKEN}, "player": {"team2": {"player0": {"kills": 5}}}});
        assert!(!dota_new_kill(&spectating, &last));
        assert!(gsi_config(&["player", "hero"]).contains("  \"hero\" \"1\"\n"));
    }

    #[test]
    fn multikill_labels() {
        assert_eq!(kill_label(1, 1), None);
        assert_eq!(kill_label(1, 3), None, "a lone 3rd kill isn't a 3K clip");
        assert_eq!(kill_label(3, 3).as_deref(), Some("3K"));
        assert_eq!(kill_label(2, 5).as_deref(), Some("ACE"));
    }

    #[test]
    fn auto_clip_covers_pre_roll_and_caps() {
        let t = Instant::now();
        assert_eq!(window_length(t, t + Duration::from_secs(8)), 18.0);
        assert_eq!(window_length(t, t + Duration::from_secs(500)), MAX_AUTO_CLIP);
    }

    #[test]
    fn web_pages_are_refused() {
        assert!(from_web_page(b"POST /api/v1/event/invoke HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n{}"));
        assert!(!from_web_page(b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n{}"));
    }
}
