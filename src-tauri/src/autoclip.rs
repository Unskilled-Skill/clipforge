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

/// Seconds kept before the first event of a window (the play leading up),
/// for games without their own timing.
const PRE_ROLL: f64 = 10.0;
/// Longest auto clip for games without their own timing; a window that runs
/// longer keeps its newest part.
const MAX_AUTO_CLIP: f64 = 120.0;

/// How auto clips frame the action in one game.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timing {
    /// Events closer together than this share one clip. A live clip saves
    /// once this long passes without a new event, so it is also how much
    /// play a live clip keeps after the last one.
    pub window: f64,
    /// Kept before the first event: the play leading up to it.
    pub pre: f64,
    /// Kept after the last event when cutting from a session recording.
    pub post: f64,
    /// Longest clip; a longer moment keeps its end.
    pub max: f64,
}

/// Per-game timing, seeded from how established clippers tune each genre:
/// short windows for round shooters, long ones for MOBA team fights.
/// Other games use the user's clip delay and the standard lead-in.
pub fn timing(game_id: &str, default_window: f64) -> Timing {
    let t = |window, pre, post, max| Timing { window, pre, post, max };
    match game_id {
        "cs2" => t(5.0, 5.0, 5.0, 300.0),
        "valorant" => t(10.0, 10.0, 10.0, 300.0),
        "dota2" => t(20.0, 10.0, 10.0, 300.0),
        "lol" => t(35.0, 25.0, 10.0, 300.0),
        "rocketleague" => t(15.0, 15.0, 8.0, 120.0),
        "valheim" => t(10.0, 30.0, 10.0, 300.0),
        "arenabreakout" => t(45.0, 15.0, 10.0, 300.0),
        _ => t(default_window, PRE_ROLL, default_window, MAX_AUTO_CLIP),
    }
}

/// Timing for the game being played now.
fn current_timing(app: &AppHandle, default_window: f64) -> Timing {
    let game = app.state::<crate::obs::CurrentGame>().0.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    timing(&crate::clips::auto_clip_game_id(&game), default_window)
}

/// Highlights come from the session recording after the match instead:
/// live auto-clips only bookmark their kills, so nothing is saved twice.
fn highlights_instead(app: &AppHandle) -> bool {
    let s = crate::clips::load_settings_inner(app);
    s.session_recording && s.session_highlights && crate::engine::ENGINE.session_active()
}

/// An open event window.
struct Pending {
    /// First event in the window: the clip starts `timing.pre` before it.
    first: Instant,
    timing: Timing,
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

/// The last auto clip saved from an event window, so the next one can
/// absorb it when the two overlap (one fight, not two clips).
#[derive(Clone)]
struct LastAuto {
    path: String,
    /// The clip's first frame.
    start: Instant,
    saved_at: Instant,
    kills: u32,
    round_kills: u32,
}

static LAST_AUTO: Mutex<Option<LastAuto>> = Mutex::new(None);

/// An auto clip saved this run, with the wall-clock span it covers (Unix
/// seconds), so a game's own match record can check it afterwards.
#[derive(Clone, Debug)]
pub struct AutoClip {
    pub path: String,
    pub start: f64,
    pub end: f64,
}

static AUTO_CLIPS: Mutex<Vec<AutoClip>> = Mutex::new(Vec::new());

fn wall_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn remember_auto_clip(path: &str, keep: f64) {
    let end = wall_now();
    let mut clips = AUTO_CLIPS.lock().unwrap();
    clips.retain(|c| end - c.end < 6.0 * 3600.0);
    clips.push(AutoClip { path: path.into(), start: end - keep, end });
}

/// Auto clips saved this run that end inside `[from, to]`.
pub fn auto_clips_between(from: f64, to: f64) -> Vec<AutoClip> {
    AUTO_CLIPS.lock().unwrap().iter().filter(|c| c.end >= from && c.end <= to).cloned().collect()
}

pub fn forget_auto_clip(path: &str) {
    AUTO_CLIPS.lock().unwrap().retain(|c| c.path != path);
}

pub fn rename_auto_clip(old: &str, new: &str) {
    for c in AUTO_CLIPS.lock().unwrap().iter_mut().filter(|c| c.path == old) {
        c.path = new.into();
    }
    if let Some(l) = LAST_AUTO.lock().unwrap().as_mut().filter(|l| l.path == old) {
        l.path = new.into();
    }
}

/// Swap the running session's bookmarks inside `[from, to]` (wall time)
/// for `kills`: a game's own record of the match beats what was detected live.
pub fn replace_session_kills(from: f64, to: f64, kills: &[f64]) {
    let mut session = SESSION_KILLS.lock().unwrap();
    let Some(list) = session.as_mut() else { return };
    let (now, wall) = (Instant::now(), wall_now());
    let to_instant = |w: f64| {
        let ago = Duration::from_secs_f64((wall - w).max(0.0));
        now.checked_sub(ago)
    };
    let (Some(a), Some(b)) = (to_instant(from), to_instant(to)) else { return };
    list.retain(|k| *k < a || *k > b);
    list.extend(kills.iter().filter_map(|k| to_instant(*k)));
    list.sort();
}
/// An earlier clip is only replaced while it is this fresh: older, the
/// player may already have it open, shared or edited.
const MERGE_WITHIN: Duration = Duration::from_secs(60);

/// How the clip saved now should cover the window `[start, now]`, given
/// the last auto clip: `Some(seconds to keep)` when they overlap and one
/// clip starting at the earlier one's start still fits `limit` seconds
/// (the replay buffer, and the game's longest clip).
fn merged_keep(last: &LastAuto, start: Instant, now: Instant, limit: f64) -> Option<f64> {
    let fresh = now.saturating_duration_since(last.saved_at) < MERGE_WITHIN;
    let overlaps = start <= last.saved_at;
    let keep = now.saturating_duration_since(last.start).as_secs_f64();
    (fresh && overlaps && keep <= limit).then_some(keep)
}
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
    if highlights_instead(app) {
        // Bookmarked above; the session's highlights cut it after the match.
        *PENDING.lock().unwrap() = None;
        return;
    }
    let timing = current_timing(app, delay_s);
    let now = Instant::now();
    let deadline = now + Duration::from_secs_f64(timing.window.max(2.0));
    let mut pending = PENDING.lock().unwrap();
    let p = pending.get_or_insert_with(|| {
        let _ = app.emit("auto-clip-armed", ());
        Pending { first: now, timing, deadline, kills: 0, round_kills: 0, min_kills: 1 }
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

/// Save a closed event window: `keep` seconds with `kills` counted kills.
/// When it overlaps the auto clip saved just before, one clip covering
/// both replaces that one (moved to the Recycle Bin), so a fight that ran
/// a little past the window is still one clip.
async fn save_window(app: &AppHandle, settings: &crate::clips::Settings, keep: f64, kills: u32, round_kills: u32, max: f64) {
    let now = Instant::now();
    let start = now - Duration::from_secs_f64(keep);
    let limit = settings.replay_seconds.min(max);
    let last = LAST_AUTO.lock().unwrap().clone();
    let favorites = crate::clips::load_favorites(app.clone()).unwrap_or_default();
    let merge = last.filter(|l| std::path::Path::new(&l.path).exists() && !favorites.contains(&l.path)).and_then(|l| {
        let keep = merged_keep(&l, start, now, limit)?;
        Some((l, keep))
    });
    let (keep, kills, round_kills, start) = match &merge {
        Some((l, keep)) => (*keep, l.kills + kills, l.round_kills.max(round_kills), l.start),
        None => (keep, kills, round_kills, start),
    };
    let label = kill_label(kills, round_kills);
    crate::logs::line(&format!("auto-clip: saving last {keep:.0}s{}", if merge.is_some() { " (joins the previous clip)" } else { "" }));
    let Ok(path) = crate::obs::save_replay_keep(app, keep, label.as_deref()).await else { return };
    remember_auto_clip(&path, keep);
    if let Some((l, _)) = merge {
        forget_auto_clip(&l.path);
        let (app2, old) = (app.clone(), l.path.clone());
        match crate::obs::blocking(move || crate::clips::delete_clip(app2, old)).await {
            Ok(()) => crate::logs::line(&format!("auto-clip: replaced {} with the joined clip", l.path)),
            Err(e) => crate::logs::line(&format!("auto-clip: couldn't remove {} after joining: {e}", l.path)),
        }
        let _ = app.emit("clip-replaced", serde_json::json!({ "old": l.path, "new": path }));
    }
    *LAST_AUTO.lock().unwrap() = Some(LastAuto { path, start, saved_at: now, kills, round_kills });
    let _ = app.emit("auto-clipped", ());
}

/// Save one clip covering a whole round's kills, from the game's lead-in
/// before the first (round mode: "only rounds with N+ kills" is known at
/// round end).
pub fn save_round(app: &AppHandle, first_kill: Instant, kills: u32) {
    if highlights_instead(app) {
        return;
    }
    let timing = current_timing(app, crate::clips::load_settings_inner(app).auto_clip_delay_s);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let keep = window_length(first_kill, Instant::now(), timing);
        let label = kill_label(kills, kills);
        crate::logs::line(&format!("auto-clip: round with {kills} kills, saving last {keep:.0}s"));
        if let Ok(path) = crate::obs::save_replay_keep(&app, keep, label.as_deref()).await {
            remember_auto_clip(&path, keep);
            let _ = app.emit("auto-clipped", ());
        }
    });
}

/// Seconds an auto clip saved now keeps: back to the game's lead-in before
/// the window's first event, capped at its longest clip.
fn window_length(first: Instant, now: Instant, timing: Timing) -> f64 {
    (now.saturating_duration_since(first).as_secs_f64() + timing.pre).min(timing.max)
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

    // Windows close on a 250 ms tick, so a clip saves right as its window
    // ends instead of up to 2 s late (a kill in that gap landed on the last
    // frame of one clip and the first of the next).
    let mut tick: u64 = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        tick += 1;
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
                    let keep = window_length(p.first, now, p.timing);
                    let worth = p.kills >= p.min_kills;
                    let due = (keep, p.kills, p.round_kills, p.timing.max);
                    *pending = None;
                    if !worth {
                        crate::logs::line("auto-clip: skipped, fewer kills than the minimum");
                    }
                    worth.then_some(due)
                }
                _ => None,
            }
        };
        if let Some((keep, kills, round_kills, max)) = due {
            save_window(&app, &settings, keep, kills, round_kills, max).await;
        }
        if tick % 8 != 0 {
            continue; // everything below runs every 2 s
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
                poll_lol(&app, client, settings.auto_clip_delay_s, &game).await;
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
/// The League game being played: (game clock 0:00 as Unix seconds, last
/// game clock seen). A clock that runs backwards is a new game.
static LOL_GAME: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn lol_map(number: i64) -> Option<&'static str> {
    match number {
        11 => Some("Summoner's Rift"),
        12 => Some("Howling Abyss"),
        21 => Some("Nexus Blitz"),
        30 => Some("Rings of Wrath"),
        _ => None,
    }
}

fn lol_mode(mode: &str) -> String {
    match mode {
        "CLASSIC" => "Classic".into(),
        "ARAM" => "ARAM".into(),
        "CHERRY" => "Arena".into(),
        "KIWI" => "ARAM: Mayhem".into(),
        "STRAWBERRY" => "Swarm".into(),
        "NEXUSBLITZ" => "Nexus Blitz".into(),
        "ULTBOOK" => "Ultimate Spellbook".into(),
        "ONEFORALL" => "One for All".into(),
        "DOOMBOTSTEEMO" => "Doom Bots".into(),
        "URF" | "ARURF" => "URF".into(),
        "PRACTICETOOL" => "Practice Tool".into(),
        "TUTORIAL" | "TUTORIAL_MODULE_1" | "TUTORIAL_MODULE_2" | "TUTORIAL_MODULE_3" => "Tutorial".into(),
        other => {
            let mut c = other.to_lowercase();
            if let Some(f) = c.get_mut(0..1) {
                f.make_ascii_uppercase();
            }
            c
        }
    }
}

/// Match tracker update for a League game from the Live Client API: map,
/// mode, the game clock's start (which also names the game) and, once the
/// game-end event arrives, the result. `game` is the previous (clock
/// start, clock) for this game, if any; returns the new one.
fn lol_update(stats: &serde_json::Value, events: &[serde_json::Value], now: f64, game: Option<(f64, f64)>) -> Option<(crate::matchdata::Update, (f64, f64))> {
    let clock = stats["gameTime"].as_f64()?;
    // Same game while its clock keeps going forward; keep the first start
    // so the id doesn't wobble with polling jitter.
    let start = match game {
        Some((start, last)) if clock + 5.0 >= last => start,
        _ => now - clock,
    };
    let result = events
        .iter()
        .find(|e| e["EventName"] == "GameEnd")
        .and_then(|e| e["Result"].as_str())
        .map(|r| if r.eq_ignore_ascii_case("win") { "won" } else { "lost" }.to_string());
    let update = crate::matchdata::Update {
        external_id: Some(format!("lol-{}", start.round() as i64)),
        map: stats["mapNumber"].as_i64().and_then(lol_map).map(String::from),
        mode: stats["gameMode"].as_str().map(lol_mode),
        clock_start: Some(start),
        ended: result.is_some(),
        result,
        active: true,
        ..Default::default()
    };
    Some((update, (start, clock)))
}

async fn poll_lol(app: &AppHandle, client: &reqwest::Client, delay_s: f64, game_exe: &str) {
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
    // Bind this game's clips to the match: map, mode, clock, result.
    if let Ok(stats) = client.get("https://127.0.0.1:2999/liveclientdata/gamestats").send().await {
        if let Ok(stats) = stats.json::<serde_json::Value>().await {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let previous = *LOL_GAME.lock().unwrap();
            if let Some((update, game)) = lol_update(&stats, events, now, previous) {
                *LOL_GAME.lock().unwrap() = Some(game);
                crate::matchdata::ingest(app, game_exe, "lol-live-client", update);
            }
        }
    }

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

    #[test]
    fn league_games_are_named_by_their_clock_and_get_their_result() {
        let stats = json!({ "gameMode": "CLASSIC", "gameTime": 600.4, "mapNumber": 11 });
        let (u, game) = lol_update(&stats, &[], 10_000.0, None).unwrap();
        assert_eq!(u.external_id.as_deref(), Some("lol-9400"));
        assert_eq!((u.map.as_deref(), u.mode.as_deref()), (Some("Summoner's Rift"), Some("Classic")));
        assert_eq!(u.clock_start, Some(9_399.6));
        assert!(u.active && !u.ended && u.result.is_none());
        // Two seconds later, with a little polling jitter: the same game.
        let later = json!({ "gameMode": "CLASSIC", "gameTime": 602.0, "mapNumber": 11 });
        let end = [json!({ "EventName": "GameEnd", "Result": "Win" })];
        let (u2, _) = lol_update(&later, &end, 10_002.3, Some(game)).unwrap();
        assert_eq!(u2.external_id, u.external_id);
        assert_eq!((u2.result.as_deref(), u2.ended), (Some("won"), true));
        // The clock starting over is a new game.
        let next = json!({ "gameMode": "ARAM", "gameTime": 30.0, "mapNumber": 12 });
        let (u3, _) = lol_update(&next, &[], 11_000.0, Some(game)).unwrap();
        assert_ne!(u3.external_id, u.external_id);
        assert_eq!((u3.map.as_deref(), u3.mode.as_deref()), (Some("Howling Abyss"), Some("ARAM")));
        assert!(lol_update(&json!({}), &[], 0.0, None).is_none());
    }

    /// The 2026-10-26 21:17 fight: a 2K clip saved, a third kill 9.75 s
    /// after the second, and a second clip whose lead-in reached back
    /// into the first. It becomes one clip from the first one's start.
    #[test]
    fn overlapping_windows_join_into_one_clip() {
        let t0 = Instant::now();
        let at = |s: f64| t0 + Duration::from_secs_f64(s);
        let last = LastAuto { path: "a.mp4".into(), start: at(0.0), saved_at: at(21.4), kills: 2, round_kills: 2 };
        // Second window: kill at 21.4, lead-in 10 s back, saved at 39.5.
        assert_eq!(merged_keep(&last, at(11.4), at(39.5), 120.0), Some(39.5));
        // Too long for the buffer: kept apart.
        assert_eq!(merged_keep(&last, at(11.4), at(39.5), 30.0), None);
        // No overlap: a separate moment.
        assert_eq!(merged_keep(&last, at(25.0), at(45.0), 120.0), None);
        // The earlier clip is over a minute old: left alone.
        assert_eq!(merged_keep(&last, at(20.0), at(90.0), 120.0), None);
    }

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
        let other = timing("mygame.exe", 8.0);
        assert_eq!(window_length(t, t + Duration::from_secs(8), other), 18.0);
        assert_eq!(window_length(t, t + Duration::from_secs(500), other), MAX_AUTO_CLIP);
        // League fights are long: a bigger lead-in and room for the fight.
        let lol = timing("lol", 8.0);
        assert_eq!((lol.window, lol.pre), (35.0, 25.0));
        assert_eq!(window_length(t, t + Duration::from_secs(200), lol), 225.0);
    }

    #[test]
    fn web_pages_are_refused() {
        assert!(from_web_page(b"POST /api/v1/event/invoke HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n{}"));
        assert!(!from_web_page(b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n{}"));
    }
}
