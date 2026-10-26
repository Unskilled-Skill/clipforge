//! Source-reported match context. No roster, account identifiers or inferred scores.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub won: u32,
    pub lost: u32,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MatchInfo {
    pub id: String,
    pub game: String,
    pub source: String,
    pub map: Option<String>,
    pub mode: Option<String>,
    pub score: Option<Score>,
    pub result: Option<String>,
    #[serde(default)]
    pub round_results: BTreeMap<u32, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedMatch {
    pub start: f64,
    pub end: f64,
    pub info: MatchInfo,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedRound {
    pub match_id: String,
    pub number: u32,
    pub start: f64,
    pub end: f64,
    pub result: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordingMetadata {
    pub version: u32,
    pub is_session: bool,
    pub matches: Vec<RecordedMatch>,
    pub rounds: Vec<RecordedRound>,
}

#[derive(Clone, Debug, Default)]
pub struct Update {
    pub external_id: Option<String>,
    pub map: Option<String>,
    pub mode: Option<String>,
    pub round: Option<u32>,
    pub score: Option<Score>,
    pub result: Option<String>,
    pub round_result: Option<String>,
    pub active: bool,
    pub ended: bool,
}
#[derive(Clone, PartialEq)]
struct Context {
    info: MatchInfo,
    round: Option<u32>,
    external_id: Option<String>,
}
#[derive(Clone)]
struct Point {
    at: Instant,
    seen: Instant,
    context: Option<Context>,
}
#[derive(Default)]
pub struct Tracker {
    history: HashMap<String, VecDeque<Point>>,
    serial: u64,
}
static TRACKER: LazyLock<Mutex<Tracker>> = LazyLock::new(|| Mutex::new(Tracker::default()));

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 160)
        .map(String::from)
}
fn number(v: &Value) -> Option<u32> {
    v.as_u64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| *n <= 10000)
        .map(|n| n as u32)
}
fn object(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or(Value::Null)
    } else {
        v.clone()
    }
}
fn outcome(s: &str) -> Option<String> {
    match s {
        "victory" | "win" | "won" => Some("won".into()),
        "defeat" | "lose" | "lost" => Some("lost".into()),
        "draw" | "tie" => Some("draw".into()),
        _ => None,
    }
}

pub fn valorant_map(raw: &str) -> String {
    match raw {
        "Infinity" => "Abyss",
        "Triad" => "Haven",
        "Duality" => "Bind",
        "Bonsai" => "Split",
        "Port" => "Icebox",
        "Foxtrot" => "Breeze",
        "Canyon" => "Fracture",
        "Pitt" => "Pearl",
        "Jam" => "Lotus",
        "Juliett" => "Sunset",
        "Rook" => "Corrode",
        "Range" => "Practice Range",
        _ => raw,
    }
    .into()
}
/// Companion sends a merged whitelist of match_info fields, never player names.
pub fn valorant_update(info: &Value) -> Update {
    let mode = object(&info["game_mode"]);
    let score = object(&info["score"]);
    let map = text(&info["map"]).map(|s| valorant_map(&s));
    let phase = info["round_phase"].as_str().unwrap_or("");
    let game_mode = if mode["custom"].as_bool() == Some(true) {
        Some("Custom".into())
    } else if mode["ranked"].as_str() == Some("1") || mode["ranked"].as_u64() == Some(1) {
        Some("Competitive".into())
    } else {
        text(&mode["mode"]).map(|s| match s.as_str() {
            "bomb"
                if mode["ranked"].as_str() == Some("2") || mode["ranked"].as_u64() == Some(2) =>
            {
                "Unrated".into()
            }
            "bomb" => "Bomb".into(),
            "quick bomb" => "Spike Rush".into(),
            "swift" => "Swiftplay".into(),
            _ => s,
        })
    };
    Update {
        external_id: text(&info["pseudo_match_id"]).or_else(|| text(&info["match_id"])),
        active: map.is_some(),
        map,
        mode: game_mode,
        round: number(&info["round_number"]).filter(|n| *n > 0),
        score: number(&score["won"])
            .zip(number(&score["lost"]))
            .map(|(won, lost)| Score { won, lost }),
        result: info["match_outcome"].as_str().and_then(outcome),
        ended: phase == "game_end" || info["match_outcome"].as_str().and_then(outcome).is_some(),
        ..Default::default()
    }
}

pub fn cs2_update(json: &Value) -> Option<Update> {
    if json["auth"]["token"] != "clipforge-gsi-v1"
        || json["provider"]["appid"]
            .as_u64()
            .is_some_and(|id| id != 730)
    {
        return None;
    }
    let map = &json["map"];
    let phase = map["phase"].as_str().unwrap_or("");
    let own = json["provider"]["steamid"].as_str().is_some()
        && json["provider"]["steamid"] == json["player"]["steamid"];
    let team = if own {
        json["player"]["team"].as_str()
    } else {
        None
    };
    let score = match team {
        Some("CT") => Some((&map["team_ct"], &map["team_t"])),
        Some("T") => Some((&map["team_t"], &map["team_ct"])),
        _ => None,
    }
    .and_then(|(us, them)| number(&us["score"]).zip(number(&them["score"])))
    .map(|(won, lost)| Score { won, lost });
    let ended = phase == "gameover";
    let result = if ended {
        score.as_ref().map(|s| {
            if s.won > s.lost {
                "won"
            } else if s.won < s.lost {
                "lost"
            } else {
                "draw"
            }
            .to_string()
        })
    } else {
        None
    };
    let round_result = if json["round"]["phase"] == "over"
        && score
            .as_ref()
            .zip(number(&map["round"]))
            .is_some_and(|(s, r)| s.won + s.lost == r + 1)
    {
        team.zip(json["round"]["win_team"].as_str())
            .map(|(us, winner)| if us == winner { "won" } else { "lost" }.to_string())
    } else {
        None
    };
    let mode = text(&map["mode"]);
    let numbered = mode.as_deref().is_some_and(|m| {
        matches!(
            m,
            "competitive" | "casual" | "premier" | "wingman" | "scrimcomp2v2"
        )
    });
    Some(Update {
        // Halftime is still the same match; dropping context here would stop
        // first-half clips from resolving its final result.
        active: !matches!(phase, "warmup" | "") && map["name"].as_str().is_some(),
        map: text(&map["name"]),
        mode,
        round: numbered
            .then(|| number(&map["round"]).map(|n| n + 1))
            .flatten(),
        score,
        result,
        round_result,
        ended,
        ..Default::default()
    })
}

impl Tracker {
    fn observe(
        &mut self,
        game: &str,
        source: &str,
        update: Update,
        now: Instant,
        stamp: u64,
    ) -> Option<MatchInfo> {
        let points = self.history.entry(game.into()).or_default();
        let previous = points.back().and_then(|p| p.context.as_ref()).cloned();
        let external = update.external_id.clone();
        let fresh = previous.as_ref().is_none_or(|p| {
            external
                .as_ref()
                .zip(p.external_id.as_ref())
                .is_some_and(|(new, old)| new != old)
                || (update.map.is_some() && update.map != p.info.map)
                || (p.info.result.is_some() && !update.ended)
                || update
                    .round
                    .zip(p.round)
                    .is_some_and(|(new, old)| new < old)
        });
        let context = if update.active {
            let mut info = if !fresh {
                previous.as_ref().unwrap().info.clone()
            } else {
                self.serial += 1;
                MatchInfo {
                    id: format!("{source}-{stamp}-{}", self.serial),
                    game: game.into(),
                    source: source.into(),
                    ..Default::default()
                }
            };
            // A missing/observed player must not turn an opponent's score into ours.
            if let Some(ref new) = update.score {
                if !fresh {
                    if let Some(ref old) = info.score {
                        if new.won == old.won + 1 && new.lost == old.lost {
                            info.round_results.insert(new.won + new.lost, "won".into());
                        } else if new.lost == old.lost + 1 && new.won == old.won {
                            info.round_results.insert(new.won + new.lost, "lost".into());
                        }
                    }
                }
            }
            if let Some(map) = update.map {
                info.map = Some(map);
            }
            if let Some(mode) = update.mode {
                info.mode = Some(mode);
            }
            if update.score.is_some() {
                info.score = update.score;
            }
            if update.result.is_some() {
                info.result = update.result;
            }
            if let Some((round, result)) = update.round.zip(update.round_result) {
                info.round_results.insert(round, result);
            }
            Some(Context {
                info,
                round: update.round,
                external_id: external.or_else(|| {
                    if fresh {
                        None
                    } else {
                        previous.as_ref().and_then(|p| p.external_id.clone())
                    }
                }),
            })
        } else {
            None
        };
        let changed = points.back().is_none_or(|p| p.context != context);
        if !changed {
            if let Some(p) = points.back_mut() {
                p.seen = now;
            }
            return None;
        }
        let record = context.as_ref().map(|c| c.info.clone());
        points.push_back(Point {
            at: now,
            seen: now,
            context,
        });
        while points.len() > 16384 {
            points.pop_front();
        }
        record
    }

    fn window(
        &self,
        game: &str,
        start: Instant,
        end: Instant,
        is_session: bool,
    ) -> RecordingMetadata {
        let mut out = RecordingMetadata {
            version: 1,
            is_session,
            ..Default::default()
        };
        let Some(points) = self.history.get(game) else {
            return out;
        };
        for (i, p) in points.iter().enumerate() {
            let Some(ctx) = &p.context else { continue };
            let until = points
                .get(i + 1)
                .map(|p| p.at)
                .unwrap_or(end)
                .min(p.seen + Duration::from_secs(120))
                .min(end);
            let from = p.at.max(start);
            if until <= from {
                continue;
            }
            let a = from.duration_since(start).as_secs_f64();
            let b = until.duration_since(start).as_secs_f64();
            if let Some(last) = out
                .matches
                .last_mut()
                .filter(|m| m.info.id == ctx.info.id && (m.end - a).abs() < 0.01)
            {
                last.end = b;
                last.info = ctx.info.clone();
            } else {
                out.matches.push(RecordedMatch {
                    start: a,
                    end: b,
                    info: ctx.info.clone(),
                });
            }
            if let Some(number) = ctx.round {
                if let Some(last) = out.rounds.last_mut().filter(|r| {
                    r.match_id == ctx.info.id && r.number == number && (r.end - a).abs() < 0.01
                }) {
                    last.end = b;
                } else {
                    out.rounds.push(RecordedRound {
                        match_id: ctx.info.id.clone(),
                        number,
                        start: a,
                        end: b,
                        result: None,
                    });
                }
            }
        }
        out
    }
}

fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(120)
        .collect()
}
pub fn path(clip: &str) -> Option<PathBuf> {
    let p = Path::new(clip);
    Some(
        p.parent()?
            .join(".thumbs")
            .join(format!("{}.match.json", p.file_stem()?.to_string_lossy())),
    )
}
fn record_path(root: &Path, id: &str) -> Option<PathBuf> {
    (!id.is_empty() && safe_id(id) == id).then(|| root.join(".matches").join(format!("{id}.json")))
}
fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw)
        .and_then(|_| std::fs::rename(tmp, path))
        .map_err(|e| e.to_string())
}
pub fn ingest(app: &AppHandle, game: &str, source: &str, update: Update) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    // Keep event order and canonical file writes in the same critical section.
    let mut tracker = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(record) = tracker.observe(game, source, update, Instant::now(), stamp) {
        let root = crate::clips::load_settings_inner(app).clips_dir;
        if let Some(path) = record_path(Path::new(&root), &record.id) {
            if let Err(e) = write_json(&path, &record) {
                crate::logs::line(&format!("Could not save match data: {e}"));
            }
        }
        let _ = app.emit("match-metadata-changed", ());
    }
}
pub fn write_recording(clip: &str, game: &str, start: Instant, end: Instant, is_session: bool) {
    if end <= start {
        return;
    }
    let data = TRACKER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .window(game, start, end, is_session);
    if !data.matches.is_empty() {
        if let Some(path) = path(clip) {
            if let Err(e) = write_json(&path, &data) {
                crate::logs::line(&format!("Could not annotate recording: {e}"));
            }
        }
    }
}
pub fn read(clip: &str) -> Option<RecordingMetadata> {
    let mut data: RecordingMetadata =
        serde_json::from_slice(&std::fs::read(path(clip)?).ok()?).ok()?;
    if data.version != 1 {
        return None;
    }
    let root = Path::new(clip).parent()?;
    for m in &mut data.matches {
        if let Some(latest) = record_path(root, &m.info.id)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice::<MatchInfo>(&raw).ok())
        {
            if latest.id == m.info.id && latest.game == m.info.game {
                m.info = latest;
            }
        }
    }
    for round in &mut data.rounds {
        round.result = data
            .matches
            .iter()
            .find(|m| m.info.id == round.match_id)
            .and_then(|m| m.info.round_results.get(&round.number))
            .cloned();
    }
    Some(data)
}
#[tauri::command]
pub fn load_recording_metadata(input: String) -> Option<RecordingMetadata> {
    read(&input)
}
#[tauri::command]
pub fn list_recording_metadata(inputs: Vec<String>) -> HashMap<String, RecordingMetadata> {
    inputs
        .into_iter()
        .filter_map(|input| read(&input).map(|data| (input, data)))
        .collect()
}

pub fn slice(data: RecordingMetadata, start: f64, end: f64) -> RecordingMetadata {
    let mut out = RecordingMetadata {
        version: 1,
        is_session: false,
        ..Default::default()
    };
    if !start.is_finite() || !end.is_finite() || end <= start {
        return out;
    }
    for mut m in data.matches {
        if m.end > start && m.start < end {
            m.start = m.start.max(start) - start;
            m.end = m.end.min(end) - start;
            out.matches.push(m);
        }
    }
    for mut r in data.rounds {
        if r.end > start && r.start < end {
            r.start = r.start.max(start) - start;
            r.end = r.end.min(end) - start;
            out.rounds.push(r);
        }
    }
    out
}
pub fn copy_selection(input: &str, output: &str, start: f64, end: f64) {
    if let Some(data) = read(input) {
        if let Some(path) = path(output) {
            let _ = write_json(&path, &slice(data, start, end));
        }
    }
}
pub fn copy_whole(input: &str, output: &str) {
    if let Some(data) = read(input) {
        if let Some(path) = path(output) {
            let _ = write_json(&path, &data);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn live(round: u32, won: u32, lost: u32) -> Update {
        Update {
            map: Some("Lotus".into()),
            round: Some(round),
            score: Some(Score { won, lost }),
            active: true,
            ..Default::default()
        }
    }
    #[test]
    fn valorant_parses_documented_strings_and_unknown_fields_stay_unknown() {
        let u = valorant_update(
            &json!({"map":"Jam","round_number":"9","score":"{\"won\":5,\"lost\":3}","game_mode":"{\"mode\":\"bomb\",\"custom\":false,\"ranked\":\"1\"}","match_outcome":"victory"}),
        );
        assert_eq!(u.map.as_deref(), Some("Lotus"));
        assert_eq!(u.round, Some(9));
        assert_eq!(u.mode.as_deref(), Some("Competitive"));
        assert_eq!(u.score, Some(Score { won: 5, lost: 3 }));
        assert_eq!(u.result.as_deref(), Some("won"));
        let missing = valorant_update(&json!({}));
        assert!(!missing.active);
        assert_eq!(missing.round, None);
        assert_eq!(missing.result, None);
        assert_eq!(missing.score, None);
        assert_eq!(
            valorant_update(&json!({"game_mode":{"mode":"bomb"}}))
                .mode
                .as_deref(),
            Some("Bomb")
        );
        assert_eq!(
            valorant_update(&json!({"game_mode":{"mode":"bomb","ranked":"2"}}))
                .mode
                .as_deref(),
            Some("Unrated")
        );
    }
    #[test]
    fn cs2_scores_are_local_perspective_and_spectated_scores_are_never_used() {
        let mut payload = json!({"auth":{"token":"clipforge-gsi-v1"},"provider":{"appid":730,"steamid":"me"},"player":{"steamid":"me","team":"CT"},"map":{"name":"de_nuke","mode":"competitive","round":21,"phase":"gameover","team_ct":{"score":13},"team_t":{"score":9}},"round":{"phase":"over","win_team":"CT"}});
        let u = cs2_update(&payload).unwrap();
        assert_eq!(u.round, Some(22));
        assert_eq!(u.score, Some(Score { won: 13, lost: 9 }));
        assert_eq!(u.result.as_deref(), Some("won"));
        payload["player"]["steamid"] = json!("other");
        let u = cs2_update(&payload).unwrap();
        assert_eq!(u.score, None);
        assert_eq!(u.result, None);
        assert_eq!(u.round_result, None);
        payload["auth"]["token"] = json!("wrong");
        assert!(cs2_update(&payload).is_none());
    }
    #[test]
    fn cs2_halftime_keeps_the_match_identity_for_late_results() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        let mut payload = json!({"auth":{"token":"clipforge-gsi-v1"},"provider":{"steamid":"me"},"player":{"steamid":"me","team":"CT"},"map":{"name":"de_nuke","mode":"competitive","round":11,"phase":"live","team_ct":{"score":7},"team_t":{"score":4}}});
        let first = tracker
            .observe("cs2.exe", "cs2-gsi", cs2_update(&payload).unwrap(), now, 1)
            .unwrap();
        payload["map"]["phase"] = json!("intermission");
        payload["map"]["team_ct"]["score"] = json!(8);
        let halftime = tracker
            .observe(
                "cs2.exe",
                "cs2-gsi",
                cs2_update(&payload).unwrap(),
                now + Duration::from_secs(5),
                2,
            )
            .unwrap();
        assert_eq!(halftime.id, first.id);
        payload["map"]["phase"] = json!("gameover");
        payload["map"]["round"] = json!(20);
        payload["map"]["team_ct"]["score"] = json!(13);
        payload["map"]["team_t"]["score"] = json!(8);
        let final_info = tracker
            .observe(
                "cs2.exe",
                "cs2-gsi",
                cs2_update(&payload).unwrap(),
                now + Duration::from_secs(30),
                3,
            )
            .unwrap();
        assert_eq!(final_info.id, first.id);
        assert_eq!(final_info.result.as_deref(), Some("won"));
    }
    #[test]
    fn timeline_keeps_match_and_round_boundaries_and_does_not_invent_a_round_start() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        tracker.observe("game", "test", live(1, 0, 0), now, 1);
        tracker.observe(
            "game",
            "test",
            live(2, 1, 0),
            now + Duration::from_secs(20),
            2,
        );
        let data = tracker.window(
            "game",
            now + Duration::from_secs(10),
            now + Duration::from_secs(40),
            true,
        );
        assert_eq!(data.matches.len(), 1);
        assert_eq!(data.rounds.len(), 2);
        assert_eq!((data.rounds[0].start, data.rounds[0].end), (0.0, 10.0));
        assert_eq!((data.rounds[1].start, data.rounds[1].end), (10.0, 30.0));
        assert_eq!(
            data.matches[0]
                .info
                .round_results
                .get(&1)
                .map(String::as_str),
            Some("won")
        );
        let trimmed = slice(data, 12.0, 25.0);
        assert!(!trimmed.is_session);
        assert_eq!(trimmed.rounds.len(), 1);
        assert_eq!(
            (trimmed.rounds[0].start, trimmed.rounds[0].end),
            (0.0, 13.0)
        );
    }
    #[test]
    fn round_reset_and_match_id_changes_separate_matches_without_losing_late_identity() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        let a = tracker
            .observe("game", "test", live(9, 5, 3), now, 1)
            .unwrap();
        let mut identified = live(9, 5, 3);
        identified.external_id = Some("match-a".into());
        let b = tracker
            .observe("game", "test", identified, now + Duration::from_secs(1), 2)
            .unwrap();
        assert_eq!(a.id, b.id);
        let mut next = live(1, 0, 0);
        next.external_id = Some("match-b".into());
        let c = tracker
            .observe("game", "test", next, now + Duration::from_secs(30), 3)
            .unwrap();
        assert_ne!(c.id, b.id);
        assert!(c.round_results.is_empty());
        let data = tracker.window("game", now, now + Duration::from_secs(40), true);
        assert_eq!(data.matches.len(), 2);
    }
    #[test]
    fn stale_context_and_stopped_games_do_not_leak_into_new_recordings() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        tracker.observe("game", "test", live(1, 0, 0), now, 1);
        assert!(tracker
            .window(
                "game",
                now + Duration::from_secs(130),
                now + Duration::from_secs(150),
                false
            )
            .matches
            .is_empty());
        tracker.observe(
            "game",
            "test",
            Update::default(),
            now + Duration::from_secs(10),
            2,
        );
        assert!(tracker
            .window(
                "game",
                now + Duration::from_secs(11),
                now + Duration::from_secs(15),
                false
            )
            .matches
            .is_empty());
    }
    #[test]
    fn saved_clips_resolve_late_results_and_sliced_metadata_survives_rename() {
        let root = std::env::temp_dir().join(format!(
            "clipforge-match-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let clip = root.join("clip.mp4").to_string_lossy().into_owned();
        let info = MatchInfo {
            id: "safe-id".into(),
            game: "cs2.exe".into(),
            map: Some("de_nuke".into()),
            ..Default::default()
        };
        let data = RecordingMetadata {
            version: 1,
            is_session: false,
            matches: vec![RecordedMatch {
                start: 0.0,
                end: 30.0,
                info: info.clone(),
            }],
            rounds: vec![RecordedRound {
                match_id: info.id.clone(),
                number: 9,
                start: 0.0,
                end: 30.0,
                result: None,
            }],
        };
        write_json(&path(&clip).unwrap(), &data).unwrap();
        let mut final_info = info;
        final_info.result = Some("won".into());
        final_info.score = Some(Score { won: 13, lost: 9 });
        final_info.round_results.insert(9, "lost".into());
        write_json(&record_path(&root, "safe-id").unwrap(), &final_info).unwrap();
        let read = read(&clip).unwrap();
        assert_eq!(read.matches[0].info.result.as_deref(), Some("won"));
        assert_eq!(read.rounds[0].result.as_deref(), Some("lost"));
        let output = root.join("trim.mp4").to_string_lossy().into_owned();
        copy_selection(&clip, &output, 10.0, 20.0);
        assert_eq!(super::read(&output).unwrap().rounds[0].end, 10.0);
        std::fs::write(&output, b"video").unwrap();
        let renamed = crate::clips::rename_clip(output.clone(), "renamed".into()).unwrap();
        assert_eq!(
            super::read(&renamed).unwrap().matches[0]
                .info
                .result
                .as_deref(),
            Some("won")
        );
        let blocked = root.join("blocked.mp4").to_string_lossy().into_owned();
        write_json(&path(&blocked).unwrap(), &data).unwrap();
        assert!(crate::clips::rename_clip(renamed.clone(), "blocked".into()).is_err());
        assert!(Path::new(&renamed).exists());
        let backup = root
            .join("backup")
            .join("keeper.mp4")
            .to_string_lossy()
            .into_owned();
        copy_whole(&renamed, &backup);
        assert_eq!(
            super::read(&backup).unwrap().matches[0]
                .info
                .result
                .as_deref(),
            Some("won")
        );
        assert!(record_path(&root, "../../escape").is_none());
        std::fs::remove_file(&renamed).unwrap();
        std::fs::remove_file(path(&blocked).unwrap()).unwrap();
        std::fs::remove_file(path(&backup).unwrap()).unwrap();
        std::fs::remove_dir(root.join("backup/.thumbs")).unwrap();
        std::fs::remove_dir(root.join("backup")).unwrap();
        std::fs::remove_file(path(&clip).unwrap()).unwrap();
        std::fs::remove_file(path(&renamed).unwrap()).unwrap();
        std::fs::remove_file(record_path(&root, "safe-id").unwrap()).unwrap();
        std::fs::remove_dir(root.join(".thumbs")).unwrap();
        std::fs::remove_dir(root.join(".matches")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
