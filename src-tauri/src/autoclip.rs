//! Event-driven auto-clipping — zero cost unless a supported game runs.
//!
//! CS2/Dota push kill events to us over Game State Integration (the game
//! POSTs JSON to a localhost port — no polling at all). League is polled
//! via its official local live-client API, only while it is running.
//! A kill arms a short countdown; further kills extend it, so a multikill
//! ends up in one clip that includes the whole sequence.

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
    let triggers = load_triggers(app);
    let Some(trigger) = triggers
        .iter()
        .find(|t| t.game_exe.to_lowercase() == game)
    else {
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

/// When the pending clip should be saved (slides forward on each kill).
static PENDING: Mutex<Option<Instant>> = Mutex::new(None);
/// Kill counter from the last CS2 GSI payload (-1 = unknown/new match).
static CS2_KILLS: AtomicI64 = AtomicI64::new(-1);
/// Highest LoL event id already processed.
static LOL_LAST_EVENT: AtomicI64 = AtomicI64::new(-1);
static GSI_CONFIG_DONE: AtomicBool = AtomicBool::new(false);

/// Instants of recent detected kills, kept so a saved clip can be annotated
/// with where in its timeline each kill sits (timeline kill markers).
/// Pruned to the longest window a replay buffer can reach back.
static KILL_TIMES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
const KILL_RETENTION: Duration = Duration::from_secs(960); // > max replay_seconds

fn record_kill() {
    let mut kills = KILL_TIMES.lock().unwrap();
    let now = Instant::now();
    kills.retain(|t| now.duration_since(*t) < KILL_RETENTION);
    kills.push(now);
}

/// Write the kill-marker sidecar for a clip that just hit disk: every
/// recorded kill inside the clip's window, as seconds from clip start.
/// The replay buffer always ends "now", so a kill K seconds ago sits at
/// `duration - K`. Works for hotkey saves too — any kill-tracked game
/// gets markers, not just auto-clipped saves.
pub fn write_kill_markers(clip_path: &str) {
    let kills: Vec<Instant> = KILL_TIMES.lock().unwrap().clone();
    if kills.is_empty() {
        return;
    }
    let Ok(duration) = crate::clips::probe_clip_duration(clip_path) else {
        return;
    };
    let now = Instant::now();
    let markers: Vec<f64> = kills
        .iter()
        .map(|t| duration - now.duration_since(*t).as_secs_f64())
        .filter(|s| *s >= 0.0 && *s <= duration)
        .collect();
    if !markers.is_empty() {
        crate::clips::write_markers(clip_path, &markers);
    }
}

fn schedule_clip(app: &AppHandle, delay_s: f64) {
    record_kill();
    let mut pending = PENDING.lock().unwrap();
    let already = pending.is_some();
    *pending = Some(Instant::now() + Duration::from_secs_f64(delay_s.max(2.0)));
    if !already {
        let _ = app.emit("auto-clip-armed", ());
    }
}

pub async fn run(app: AppHandle) {
    tauri::async_runtime::spawn(gsi_listener(app.clone()));

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
            match *pending {
                Some(deadline) if Instant::now() >= deadline => {
                    *pending = None;
                    true
                }
                _ => false,
            }
        };
        if due {
            let state = app.state::<crate::obs::ObsState>();
            if crate::obs::save_replay(state.inner()).await.is_ok() {
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
            if install_cs2_gsi_config() {
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
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;

            let Some(body_start) = find_body(&buf) else {
                return;
            };
            let Ok(json) = serde_json::from_slice::<serde_json::Value>(&buf[body_start..]) else {
                return;
            };
            handle_cs2_payload(&app, &json);
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

fn handle_cs2_payload(app: &AppHandle, json: &serde_json::Value) {
    // Only count our own player, not someone we spectate.
    let own = json["provider"]["steamid"].as_str().is_some()
        && json["provider"]["steamid"] == json["player"]["steamid"];
    if !own {
        return;
    }
    let Some(kills) = json["player"]["match_stats"]["kills"].as_i64() else {
        return;
    };
    let last = CS2_KILLS.swap(kills, Ordering::Relaxed);
    if last >= 0 && kills > last {
        let delay = crate::clips::load_settings_inner(app).auto_clip_delay_s;
        schedule_clip(app, delay);
    }
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
        // Skip the backlog on first poll of a match.
        if last >= 0
            && event["EventName"] == "ChampionKill"
            && event["KillerName"].as_str() == Some(me.as_str())
        {
            kill = true;
        }
    }
    LOL_LAST_EVENT.store(newest, Ordering::Relaxed);
    if kill {
        schedule_clip(app, delay_s);
    }
}

/// Drop ClipForge's GSI config into the CS2 cfg folder so the game knows
/// where to send events. Searches all Steam library folders.
fn install_cs2_gsi_config() -> bool {
    let mut roots = vec![
        "C:/Program Files (x86)/Steam".to_string(),
        "C:/Program Files/Steam".to_string(),
    ];
    // Additional library folders from the main install.
    for root in roots.clone() {
        let vdf = std::path::Path::new(&root).join("steamapps/libraryfolders.vdf");
        if let Ok(raw) = std::fs::read_to_string(vdf) {
            for line in raw.lines() {
                let line = line.trim();
                if line.starts_with("\"path\"") {
                    if let Some(path) = line.split('"').nth(3) {
                        roots.push(path.replace("\\\\", "/"));
                    }
                }
            }
        }
    }

    for root in roots {
        let cfg_dir = std::path::Path::new(&root)
            .join("steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg");
        if cfg_dir.exists() {
            let cfg = format!(
                "\"ClipForge GSI\"\n{{\n \"uri\" \"http://127.0.0.1:{GSI_PORT}\"\n \
                 \"timeout\" \"1.0\"\n \"buffer\" \"0.2\"\n \"throttle\" \"0.5\"\n \
                 \"heartbeat\" \"30.0\"\n \"data\"\n {{\n  \"provider\" \"1\"\n  \
                 \"player_state\" \"1\"\n  \"map\" \"1\"\n }}\n}}\n"
            );
            return std::fs::write(cfg_dir.join("gamestate_integration_clipforge.cfg"), cfg)
                .is_ok();
        }
    }
    false
}
