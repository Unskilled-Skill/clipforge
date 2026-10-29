//! Local League match data. Final history survives the game client's shutdown.
use crate::matchdata::{MatchInfo, PlayerStats};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct CompletedMatch {
    start: f64,
    duration: f64,
    champion_id: u64,
    info: MatchInfo,
}

fn number(value: &Value, key: &str) -> Option<u32> {
    value[key].as_u64().and_then(|n| n.try_into().ok())
}
fn completed(game: &Value, puuid: &str) -> Option<CompletedMatch> {
    if puuid.is_empty() {
        return None;
    }
    let identity = game["participantIdentities"]
        .as_array()?
        .iter()
        .find(|entry| entry["player"]["puuid"].as_str() == Some(puuid))?;
    let participant = game["participants"]
        .as_array()?
        .iter()
        .find(|entry| entry["participantId"] == identity["participantId"])?;
    let stats = &participant["stats"];
    let won = stats["win"].as_bool()?;
    let start = game["gameCreation"].as_f64()? / 1000.0;
    let duration = game["gameDuration"].as_f64()?;
    if !start.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    let platform = game["platformId"]
        .as_str()
        .unwrap_or("local")
        .to_ascii_lowercase();
    if !platform.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(CompletedMatch {
        start,
        duration,
        champion_id: participant["championId"].as_u64()?,
        info: MatchInfo {
            id: format!("league-{platform}-{}", game["gameId"].as_u64()?),
            game: "league of legends.exe".into(),
            source: "league-client-history".into(),
            map: game["mapId"]
                .as_i64()
                .and_then(crate::autoclip::lol_map)
                .map(String::from),
            mode: game["gameMode"].as_str().map(crate::autoclip::lol_mode),
            result: Some(if won { "won" } else { "lost" }.into()),
            player_stats: Some(PlayerStats {
                champion: None,
                kills: number(stats, "kills"),
                deaths: number(stats, "deaths"),
                assists: number(stats, "assists"),
                cs: number(stats, "totalMinionsKilled")
                    .zip(number(stats, "neutralMinionsKilled"))
                    .map(|(a, b)| a.saturating_add(b)),
                gold: number(stats, "goldEarned"),
                champion_damage: number(stats, "totalDamageDealtToChampions"),
                vision_score: number(stats, "visionScore"),
                finalized: true,
            }),
            ..Default::default()
        },
    })
}
// History creation includes loading; tolerate bounded loading/remux delay.
fn associated(start: f64, end: f64, game: &CompletedMatch) -> bool {
    if !start.is_finite() || !end.is_finite() || end <= start {
        return false;
    }
    let first = game.start - 15.0;
    let last = game.start + game.duration + 180.0;
    let overlap = (end.min(last) - start.max(first)).max(0.0);
    start >= first - 60.0
        && start <= game.start + game.duration
        && end <= last
        && overlap / (end - start) >= 0.8
}
fn live_stats(data: &Value) -> Option<PlayerStats> {
    let active = &data["activePlayer"];
    let id = active["riotId"]
        .as_str()
        .or_else(|| active["summonerName"].as_str())?;
    if id.is_empty() {
        return None;
    }
    let players: Vec<_> = data["allPlayers"]
        .as_array()?
        .iter()
        .filter(|p| p["riotId"].as_str() == Some(id) || p["summonerName"].as_str() == Some(id))
        .collect();
    if players.len() != 1 {
        return None;
    }
    let player = players[0];
    let scores = &player["scores"];
    Some(PlayerStats {
        champion: player["championName"].as_str().map(String::from),
        kills: number(scores, "kills"),
        deaths: number(scores, "deaths"),
        assists: number(scores, "assists"),
        cs: number(scores, "creepScore"),
        vision_score: scores["wardScore"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n.round() as u32),
        ..Default::default()
    })
}

use crate::matchdata::{RecordedMatch, RecordingMetadata};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

struct Lcu {
    port: u16,
    password: String,
}
impl Lcu {
    fn discover() -> Option<Self> {
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:/ProgramData".into());
        let installs: Value = serde_json::from_slice(
            &std::fs::read(Path::new(&program_data).join("Riot Games/RiotClientInstalls.json"))
                .ok()?,
        )
        .ok()?;
        for root in installs["associated_client"].as_object()?.keys() {
            let Ok(raw) = std::fs::read_to_string(Path::new(root).join("lockfile")) else {
                continue;
            };
            let parts: Vec<_> = raw.trim().split(':').collect();
            if parts.len() != 5 || parts[4] != "https" {
                continue;
            }
            if let Ok(port) = parts[2].parse::<u16>() {
                if port > 0 {
                    return Some(Self {
                        port,
                        password: parts[3].into(),
                    });
                }
            }
        }
        None
    }
    async fn get(&self, client: &reqwest::Client, route: &str) -> Option<Value> {
        client
            .get(format!("https://127.0.0.1:{}{route}", self.port))
            .basic_auth("riot", Some(&self.password))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()
    }
}
async fn history(
    client: &reqwest::Client,
    names: &mut HashMap<u64, String>,
) -> Option<Vec<CompletedMatch>> {
    let lcu = Lcu::discover()?;
    let me = lcu.get(client, "/lol-summoner/v1/current-summoner").await?;
    let puuid = me["puuid"].as_str()?;
    let data = lcu
        .get(
            client,
            "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9",
        )
        .await?;
    let mut out = Vec::new();
    for game in data["games"]["games"].as_array()? {
        let Some(mut summary) = completed(game, puuid) else {
            continue;
        };
        if !names.contains_key(&summary.champion_id) {
            if let Some(champion) = lcu
                .get(
                    client,
                    &format!(
                        "/lol-game-data/assets/v1/champions/{}.json",
                        summary.champion_id
                    ),
                )
                .await
            {
                if let Some(name) = champion["name"].as_str() {
                    names.insert(summary.champion_id, name.into());
                }
            }
        }
        if let Some(stats) = &mut summary.info.player_stats {
            stats.champion = names.get(&summary.champion_id).cloned();
        }
        out.push(summary);
    }
    Some(out)
}

type DurationCache = HashMap<String, (u64, u64, f64)>;
fn clip_duration(clip: &crate::clips::ClipInfo, cache: &mut DurationCache) -> Option<f64> {
    if let Some((modified, size, duration)) = cache.get(&clip.path) {
        if *modified == clip.modified_ms && *size == clip.size_bytes {
            return Some(*duration);
        }
    }
    let duration = crate::clips::probe_clip_duration(&clip.path).ok()?;
    if !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    cache.insert(
        clip.path.clone(),
        (clip.modified_ms, clip.size_bytes, duration),
    );
    Some(duration)
}
fn stamp(name: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^LoL (?:(?:Session|ACE|[2-9]\d*K) )?(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})(?: \(\d+\))?\.(?:mp4|mkv)$").unwrap()
    });
    Some(RE.captures(name)?.get(1)?.as_str().into())
}
fn save_link(
    path: &str,
    duration: f64,
    is_session: bool,
    info: &MatchInfo,
) -> Result<bool, String> {
    let previous = crate::matchdata::read(path);
    if previous.as_ref().is_some_and(|data| data.matches.len() > 1) {
        return Ok(false);
    }
    let mut resolved = info.clone();
    if let Some(old) = previous.as_ref().and_then(|data| data.matches.first()) {
        resolved.clock_start = old.info.clock_start;
    }
    let data = RecordingMetadata {
        version: 1,
        is_session,
        matches: vec![RecordedMatch {
            start: 0.0,
            end: duration,
            info: resolved,
        }],
        rounds: Vec::new(),
    };
    if previous == Some(data.clone()) {
        return Ok(false);
    }
    let target = crate::matchdata::path(path).ok_or("invalid recording path")?;
    crate::matchdata::write_json(&target, &data)?;
    Ok(true)
}
fn repair(
    root: &str,
    games: &[CompletedMatch],
    cache: &mut DurationCache,
) -> Result<usize, String> {
    let clips = crate::clips::list_clips(root.into())?;
    let mut changed = 0;
    for game in games {
        if !valid_summary(game) {
            continue;
        }
        let target = Path::new(root)
            .join(".matches")
            .join(format!("{}.json", game.info.id));
        let previous = std::fs::read(&target)
            .ok()
            .and_then(|raw| serde_json::from_slice::<MatchInfo>(&raw).ok());
        if previous.as_ref() != Some(&game.info) {
            crate::matchdata::write_json(&target, &game.info)?;
            changed += 1;
        }
    }
    for source in &clips {
        let old = crate::matchdata::read(&source.path);
        let league_recording = stamp(&source.name).is_some()
            || old.as_ref().is_some_and(|d| {
                d.matches
                    .iter()
                    .any(|m| m.info.game.eq_ignore_ascii_case("league of legends.exe"))
            });
        if !league_recording {
            continue;
        }
        let is_session = source.name.to_ascii_lowercase().starts_with("lol session ")
            || old.as_ref().is_some_and(|d| d.is_session);
        let Some(duration) = clip_duration(source, cache) else {
            continue;
        };
        let end = source.modified_ms as f64 / 1000.0;
        let start = end - duration;
        let possible: Vec<_> = games
            .iter()
            .filter(|game| valid_summary(game) && associated(start, end, game))
            .collect();
        if possible.len() != 1 {
            continue;
        }
        let info = &possible[0].info;
        changed += usize::from(save_link(&source.path, duration, is_session, info)?);
        if let Some(family) = stamp(&source.name).filter(|_| is_session) {
            for highlight in &clips {
                if highlight.path == source.path
                    || highlight.name.to_ascii_lowercase().contains(" session ")
                    || stamp(&highlight.name).as_deref() != Some(&family)
                {
                    continue;
                }
                if let Some(length) = clip_duration(highlight, cache) {
                    changed += usize::from(save_link(&highlight.path, length, false, info)?);
                }
            }
        }
    }
    Ok(changed)
}

fn valid_summary(game: &CompletedMatch) -> bool {
    game.info.id.starts_with("league-")
        && game.info.id.len() <= 120
        && game
            .info
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && game.info.game.eq_ignore_ascii_case("league of legends.exe")
        && game.start.is_finite()
        && game.duration.is_finite()
        && game.duration > 0.0
}

pub async fn run(app: AppHandle) {
    // Both endpoints are Riot's loopback services with self-signed certificates.
    let Ok(client) = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return;
    };
    let mut tick = 0u64;
    let mut live_clock = None;
    let mut names = HashMap::new();
    let mut durations = HashMap::new();
    let mut cached_root = String::new();
    let mut summaries: Vec<CompletedMatch> = Vec::new();
    loop {
        let settings = crate::clips::load_settings_inner(&app);
        let game = app
            .state::<crate::obs::CurrentGame>()
            .0
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_default();
        if game.to_ascii_lowercase().contains("league of legends") {
            if let Ok(response) = client
                .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
                .send()
                .await
            {
                if let Ok(data) = response.json::<Value>().await {
                    let events = data["events"]["Events"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);
                    if let Some((mut update, clock)) =
                        crate::autoclip::lol_update(&data["gameData"], &events, now, live_clock)
                    {
                        update.player_stats = live_stats(&data);
                        live_clock = Some(clock);
                        crate::matchdata::ingest(&app, &game, "lol-live-client", update);
                    }
                }
            }
        } else {
            live_clock = None;
        }
        if tick % 5 == 0 {
            let root = settings.clips_dir;
            let cache_file: PathBuf = Path::new(&root).join(".matches/league-history.json");
            if root != cached_root {
                summaries = std::fs::read(&cache_file)
                    .ok()
                    .and_then(|raw| serde_json::from_slice(&raw).ok())
                    .unwrap_or_default();
                cached_root = root.clone();
                durations.clear();
            }
            if let Some(latest) = history(&client, &mut names).await {
                if !latest.is_empty() && latest != summaries {
                    // Store player stats only; no credentials or account identifiers.
                    if crate::matchdata::write_json(&cache_file, &latest).is_ok() {
                        summaries = latest;
                    }
                }
            }
            if !summaries.is_empty() {
                let snapshots = summaries.clone();
                let prior_cache = std::mem::take(&mut durations);
                let result = tokio::task::spawn_blocking(move || {
                    let mut cache = prior_cache;
                    let result = repair(&root, &snapshots, &mut cache);
                    (result, cache)
                })
                .await;
                if let Ok((result, cache)) = result {
                    durations = cache;
                    match result {
                        Ok(changed) if changed > 0 => {
                            crate::logs::line(&format!(
                                "league match data: linked {changed} recordings/highlights"
                            ));
                            let _ = app.emit("match-metadata-changed", ());
                        }
                        Err(e) => crate::logs::line(&format!(
                            "league match data: could not link recordings ({e})"
                        )),
                        _ => {}
                    }
                }
            }
        }
        tick = tick.wrapping_add(1);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn game() -> Value {
        serde_json::from_str(include_str!("../testdata/league/completed.json")).unwrap()
    }

    #[test]
    fn final_history_uses_only_the_local_participant() {
        let parsed = completed(&game(), "local-player").unwrap();
        assert_eq!(parsed.info.id, "league-local-5668632195");
        assert_eq!(parsed.info.result.as_deref(), Some("lost"));
        assert_eq!(parsed.info.mode.as_deref(), Some("ARAM: Mayhem"));
        assert_eq!(parsed.info.map.as_deref(), Some("Howling Abyss"));
        let stats = parsed.info.player_stats.unwrap();
        assert_eq!(
            (stats.kills, stats.deaths, stats.assists),
            (Some(6), Some(14), Some(18))
        );
        assert_eq!(
            (stats.cs, stats.gold, stats.champion_damage),
            (Some(39), Some(15966), Some(30186))
        );
        assert!(stats.finalized);
        assert!(completed(&game(), "another-player").is_none());
    }
    #[test]
    fn missing_result_or_identity_never_becomes_a_loss() {
        let mut value = game();
        value["participants"][0]["stats"]
            .as_object_mut()
            .unwrap()
            .remove("win");
        assert!(completed(&value, "local-player").is_none());
        assert!(completed(&game(), "").is_none());
    }
    #[test]
    fn recording_matching_allows_loading_and_remux_delay_but_rejects_other_games() {
        let g = completed(&game(), "local-player").unwrap();
        assert!(associated(g.start + 25.3, g.start + 1150.3, &g));
        assert!(!associated(g.start - 3600.0, g.start - 2400.0, &g));
        assert!(!associated(g.start + 1800.0, g.start + 2000.0, &g));
        assert!(!associated(
            g.start + g.duration + 10.0,
            g.start + g.duration + 40.0,
            &g
        ));
        assert!(!associated(g.start - 5000.0, g.start + 1150.0, &g));
    }
    #[test]
    fn live_stats_do_not_capture_an_opponents_scores() {
        let data = json!({"activePlayer":{"riotId":"Me#NA1"},"allPlayers":[
            {"riotId":"Other#NA1","championName":"Annie","scores":{"kills":99}},
            {"riotId":"Me#NA1","championName":"Lissandra","scores":{"kills":6,"deaths":13,"assists":18,"creepScore":39}}
        ]});
        let stats = live_stats(&data).unwrap();
        assert_eq!(stats.kills, Some(6));
        assert_eq!(stats.champion.as_deref(), Some("Lissandra"));
        assert!(!stats.finalized);
        assert!(live_stats(&json!({"allPlayers":[{"scores":{"kills":99}}]})).is_none());
    }
    #[test]
    fn repaired_sidecars_survive_restart_and_unchanged_data_is_not_rewritten() {
        let root = std::env::temp_dir().join(format!(
            "clipforge-league-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root
            .join("LoL Session 2026-10-28 02-26-19.mp4")
            .to_string_lossy()
            .into_owned();
        let highlight = root
            .join("LoL 2K 2026-10-28 02-26-19 (3).mp4")
            .to_string_lossy()
            .into_owned();
        let info = completed(&game(), "local-player").unwrap().info;
        assert!(save_link(&source, 1117.53, true, &info).unwrap());
        assert!(save_link(&highlight, 58.14, false, &info).unwrap());
        let parent = crate::matchdata::read(&source).unwrap();
        let child = crate::matchdata::read(&highlight).unwrap();
        assert!(parent.is_session);
        assert!(!child.is_session);
        assert_eq!(parent.matches[0].info.id, child.matches[0].info.id);
        assert_eq!(
            child.matches[0].info.player_stats.as_ref().unwrap().deaths,
            Some(14)
        );
        assert!(!save_link(&source, 1117.53, true, &info).unwrap());
        assert_eq!(
            stamp("LoL 2K 2026-10-28 02-26-19 (3).mp4"),
            stamp("LoL Session 2026-10-28 02-26-19.mp4")
        );
        assert!(stamp("LoL Session 2026-10-28 02-26-19_trim_0-5.mp4").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cached_match_identifiers_cannot_escape_the_metadata_directory() {
        let mut summary = completed(&game(), "local-player").unwrap();
        assert!(valid_summary(&summary));
        summary.info.id = "league-../../elsewhere".into();
        assert!(!valid_summary(&summary));
    }
}
