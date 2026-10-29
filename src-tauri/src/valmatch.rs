//! Valorant's own record of each match, checked after it ends. The screen
//! reader (screenkills.rs) clips kills live but can be fooled; Riot's match
//! details list every kill with its time, so once a match is over the auto
//! clips are checked against them: clips without a kill of ours go to the
//! Recycle Bin, the rest get exact kill markers and labels, a running
//! session gets exact bookmarks, and the match gets its score and result.
//!
//! The details come from the Riot Client's local API (credentials from its
//! lockfile) and Riot's match-details endpoint, using the player's own
//! session. Nothing touches the game process. Times come from
//! ShooterGame.log, whose stamps are UTC wall time.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::screenkills::line_time;

/// The fixed platform header Riot's own clients send (base64 JSON: PC,
/// Windows).
const CLIENT_PLATFORM: &str = "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";
/// A kill counts for a clip this far outside its ends (save timing and the
/// banner's own delay).
const SLACK_S: f64 = 1.0;

/// One finished match as ShooterGame.log describes it. Times are Unix
/// seconds (UTC).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoggedMatch {
    pub id: String,
    pub map: Option<String>,
    pub mode: Option<String>,
    /// Round number (0-based, as Riot numbers them) → when its buy phase
    /// ended and play began.
    pub round_starts: BTreeMap<u32, f64>,
    pub start: f64,
    pub end: f64,
    pub puuid: Option<String>,
    pub version: Option<String>,
    pub region: Option<String>,
}

impl LoggedMatch {
    /// Modes with rounds, where match details carry per-round kill times.
    pub fn has_rounds(&self) -> bool {
        self.mode.as_deref().is_none_or(|m| m.contains("Bomb"))
    }
}

fn after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.find(marker).map(|i| &line[i + marker.len()..])
}

fn word(s: &str) -> String {
    s.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect()
}

/// The last match in the log that ended.
pub fn last_match(text: &str) -> Option<LoggedMatch> {
    let (mut puuid, mut version, mut region) = (None, None, None);
    let mut current: Option<LoggedMatch> = None;
    let mut ended_rounds = 0u32;
    let mut last = None;
    for line in text.lines() {
        if let Some(rest) = after(line, "Logged in user changed: ") {
            puuid = Some(word(rest)).filter(|w| w.len() == 36);
        } else if let Some(rest) = after(line, "CI server version: ") {
            version = Some(word(rest)).filter(|w| !w.is_empty());
        } else if let Some(rest) = after(line, "/regions/") {
            region = Some(word(rest)).filter(|w| !w.is_empty());
        }
        let Some(t) = line_time(line) else { continue };
        if line.contains("LogMapLoadModel: Update:") && line.contains("[Local World: TRUE | Changed: TRUE]") {
            let map = after(line, "[Map Name: ").map(word);
            let mode = after(line, "/GameModes/").map(word);
            current = Some(LoggedMatch { map, mode, start: t, ..Default::default() });
            ended_rounds = 0;
        }
        let Some(m) = current.as_mut() else { continue };
        if let Some(rest) = after(line, "Match Load Times] MatchId: ") {
            m.id = word(rest);
        } else if let Some(rest) = after(line, "Gameplay started at local time ") {
            // Twice a round: as the buy phase starts (local time ~0) and as
            // it ends (30 s, 45 s in the first round). Play starts at the second.
            let local: f64 = rest.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            if local > 1.0 {
                m.round_starts.entry(ended_rounds).or_insert(t);
            }
        } else if line.contains("OnRoundEnded for round") {
            ended_rounds += 1;
        } else if line.contains("LogShooterGameState: Match Ended") {
            m.end = t;
            if !m.id.is_empty() {
                last = current.take();
            }
        }
    }
    last.map(|m| LoggedMatch { puuid, version, region, ..m })
}

/// What the match details say about us.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    /// Our kills, in wall time, with the round each was in.
    pub kills: Vec<(f64, u32)>,
    pub score: Option<(u32, u32)>,
    pub result: Option<String>,
    /// 1-based round → "won"/"lost" (how the match tracker numbers rounds).
    pub round_results: BTreeMap<u32, String>,
}

/// Read our kills and the result out of a match-details response.
pub fn outcome(details: &Value, puuid: &str, round_starts: &BTreeMap<u32, f64>) -> Outcome {
    let team = details["players"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["subject"] == puuid))
        .and_then(|p| p["teamId"].as_str())
        .map(String::from);
    let mut out = Outcome::default();
    if let Some(team) = &team {
        let teams = details["teams"].as_array().cloned().unwrap_or_default();
        let won = |t: &Value| t["roundsWon"].as_u64().unwrap_or(0) as u32;
        let ours = teams.iter().find(|t| t["teamId"] == team.as_str());
        let theirs = teams.iter().find(|t| t["teamId"] != team.as_str());
        if let (Some(a), Some(b)) = (ours, theirs) {
            let (w, l) = (won(a), won(b));
            out.score = Some((w, l));
            out.result = Some(if a["won"] == true { "won" } else if w == l { "draw" } else { "lost" }.into());
        }
    }

    let mut raw: Vec<(f64, f64, u32)> = Vec::new(); // (gameTime s, roundTime s, round)
    for r in details["roundResults"].as_array().into_iter().flatten() {
        let Some(round) = r["roundNum"].as_u64().map(|n| n as u32) else { continue };
        if let (Some(team), Some(winner)) = (&team, r["winningTeam"].as_str()) {
            out.round_results.insert(round + 1, if winner == team { "won" } else { "lost" }.into());
        }
        for ps in r["playerStats"].as_array().into_iter().flatten() {
            for k in ps["kills"].as_array().into_iter().flatten() {
                if k["killer"] != puuid {
                    continue;
                }
                let (Some(game), Some(round_t)) = (k["gameTime"].as_f64(), k["roundTime"].as_f64()) else { continue };
                if !raw.iter().any(|(g, ..)| (g - game / 1000.0).abs() < 0.001) {
                    raw.push((game / 1000.0, round_t / 1000.0, round));
                }
            }
        }
    }
    raw.sort_by(|a, b| a.0.total_cmp(&b.0));

    // Rounds whose start the log saw give exact times; the others are
    // placed by match time, anchored on the rounds that were seen.
    let mut anchors: Vec<f64> = raw
        .iter()
        .filter_map(|(game, round_t, round)| round_starts.get(round).map(|s| s + round_t - game))
        .collect();
    anchors.sort_by(|a, b| a.total_cmp(b));
    let anchor = anchors.get(anchors.len() / 2).copied();
    out.kills = raw
        .iter()
        .filter_map(|(game, round_t, round)| {
            let at = round_starts.get(round).map(|s| s + round_t).or_else(|| anchor.map(|a| a + game))?;
            Some((at, *round))
        })
        .collect();
    out
}

/// Clip name with its multikill label replaced:
/// "Valorant 3K 2026-10-26 21-24-01.mp4" → "Valorant 2K 2026-10-26 21-24-01".
pub fn relabel(stem: &str, label: Option<&str>) -> Option<String> {
    let (game, rest) = stem.split_once(' ')?;
    let rest = match rest.split_once(' ') {
        Some((first, tail)) if first == "ACE" || (first.ends_with('K') && first[..first.len() - 1].parse::<u32>().is_ok()) => tail,
        _ => rest,
    };
    Some(match label {
        Some(l) => format!("{game} {l} {rest}"),
        None => format!("{game} {rest}"),
    })
}

fn shard(region: &str) -> &str {
    match region {
        "na" | "latam" | "br" => "na",
        "eu" | "ap" | "kr" | "pbe" => region,
        _ => "eu",
    }
}

async fn tokens(client: &reqwest::Client) -> Result<(String, String), String> {
    let path = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())? + r"\Riot Games\Riot Client\Config\lockfile";
    let raw = std::fs::read_to_string(&path).map_err(|_| "Riot Client isn't running".to_string())?;
    let parts: Vec<&str> = raw.trim().split(':').collect();
    let [_, _, port, password, proto] = parts[..] else { return Err("unexpected lockfile".into()) };
    let r: Value = client
        .get(format!("{proto}://127.0.0.1:{port}/entitlements/v1/token"))
        .basic_auth("riot", Some(password))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    match (r["accessToken"].as_str(), r["token"].as_str()) {
        (Some(a), Some(t)) => Ok((a.into(), t.into())),
        _ => Err("Riot Client isn't signed in".into()),
    }
}

async fn details(m: &LoggedMatch) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // the local Riot Client API uses a self-signed cert
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let (access, entitlement) = tokens(&client).await?;
    // The certificate exception is only for the loopback API.
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let shard = shard(m.region.as_deref().unwrap_or("eu"));
    let res = client
        .get(format!("https://pd.{shard}.a.pvp.net/match-details/v1/matches/{}", m.id))
        .bearer_auth(access)
        .header("X-Riot-Entitlements-JWT", entitlement)
        .header("X-Riot-ClientPlatform", CLIENT_PLATFORM)
        .header("X-Riot-ClientVersion", m.version.as_deref().unwrap_or(""))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("match details: HTTP {}", res.status().as_u16()));
    }
    res.json().await.map_err(|e| e.to_string())
}

/// Fetch the match details, waiting while Riot hasn't published them yet.
async fn details_with_retry(m: &LoggedMatch) -> Result<Value, String> {
    let mut last = String::new();
    for attempt in 0..8 {
        tokio::time::sleep(std::time::Duration::from_secs(if attempt == 0 { 15 } else { 30 })).await;
        match details(m).await {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn log_path() -> Option<std::path::PathBuf> {
    Some(std::path::Path::new(&std::env::var("LOCALAPPDATA").ok()?).join("VALORANT/Saved/Logs/ShooterGame.log"))
}

/// A match just ended (ShooterGame.log said so): check its auto clips.
pub fn match_ended(app: &AppHandle, game: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !crate::clips::load_settings_inner(&app).valorant_match_check {
            return;
        }
        let Some(m) = log_path().and_then(|p| std::fs::read(p).ok()).and_then(|raw| last_match(&String::from_utf8_lossy(&raw))) else {
            crate::logs::line("valorant match check: match not found in the log");
            return;
        };
        if !m.has_rounds() {
            return;
        }
        let Some(puuid) = m.puuid.clone() else {
            crate::logs::line("valorant match check: player id not in the log");
            return;
        };
        let details = match details_with_retry(&m).await {
            Ok(d) => d,
            Err(e) => {
                crate::logs::line(&format!("valorant match check: no match details ({e})"));
                return;
            }
        };
        let outcome = outcome(&details, &puuid, &m.round_starts);
        apply(&app, &game, &m, &outcome).await;
    });
}

async fn apply(app: &AppHandle, game: &str, m: &LoggedMatch, o: &Outcome) {
    let (mut removed, mut relabeled) = (0, 0);
    let mut covered = 0;
    for clip in crate::autoclip::auto_clips_between(m.start - 5.0, m.end + 120.0) {
        let inside: Vec<&(f64, u32)> = o.kills.iter().filter(|(k, _)| *k >= clip.start - SLACK_S && *k <= clip.end + SLACK_S).collect();
        if !std::path::Path::new(&clip.path).exists() {
            continue;
        }
        if inside.is_empty() {
            if crate::clips::load_favorites(app.clone()).map_or(true, |favorites| favorites.contains(&clip.path)) { continue; }
            let (a, p) = (app.clone(), clip.path.clone());
            if crate::obs::blocking(move || crate::clips::delete_clip(a, p)).await.is_ok() {
                crate::autoclip::forget_auto_clip(&clip.path);
                crate::logs::line(&format!("valorant match check: removed {} (no kill of yours in it)", clip.path));
                removed += 1;
            }
            continue;
        }
        // The slack keeps a clip whose kill sits right at an edge; only kills
        // the clip actually shows get a marker and count toward its label.
        let shown: Vec<&(f64, u32)> = inside.iter().copied().filter(|(k, _)| *k >= clip.start - 0.5 && *k <= clip.end).collect();
        let inside = if shown.is_empty() { inside } else { shown };
        covered += inside.len();
        let markers: Vec<f64> = inside.iter().map(|(k, _)| (k - clip.start).clamp(0.0, clip.end - clip.start)).collect();
        crate::clips::write_markers(&clip.path, &markers);
        // Label by the most kills of one round in the clip (ACE = 5).
        let n = inside.len() as u32;
        let round_best = inside.iter().map(|(_, r)| o.kills.iter().filter(|(_, x)| x == r).count() as u32).max().unwrap_or(0);
        let label = crate::autoclip::kill_label(n, round_best);
        let p = std::path::Path::new(&clip.path);
        let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        if let Some(name) = relabel(&stem, label.as_deref()).filter(|n| *n != stem) {
            match crate::clips::rename_clip(clip.path.clone(), name) {
                Ok(new) => {
                    crate::autoclip::rename_auto_clip(&clip.path, &new);
                    let _ = app.emit("clip-replaced", serde_json::json!({ "old": clip.path, "new": new }));
                    relabeled += 1;
                }
                Err(e) => crate::logs::line(&format!("valorant match check: couldn't relabel {}: {e}", clip.path)),
            }
        }
    }
    crate::autoclip::replace_session_kills(m.start, m.end, &o.kills.iter().map(|(k, _)| *k).collect::<Vec<_>>());
    if let (Some((won, lost)), Some(result)) = (o.score, o.result.clone()) {
        crate::matchdata::complete(app, game, &m.id, crate::matchdata::Score { won, lost }, result, o.round_results.clone());
    }
    let missed = o.kills.len().saturating_sub(covered);
    crate::logs::line(&format!(
        "valorant match check: {} kills, {removed} clips removed, {relabeled} relabeled, {missed} kills not in a clip",
        o.kills.len()
    ));
    let _ = app.emit("clips-changed", ());
    let _ = app.emit("valorant-checked", serde_json::json!({ "removed": removed, "relabeled": relabeled, "result": o.result }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ME: &str = "a2c858fe-da5a-53e6-b9fd-e6c9dc0aa1aa";

    #[test]
    fn reads_the_last_match_from_the_log() {
        let log = "\
[2026.10.26-19.31.51:083][  0]LogShooter: Display: CI server version: release-13.08-shipping-22-5760300
[2026.10.26-19.31.54:564][ 18]LogShooterGameUserSettings: Logged in user changed: a2c858fe-da5a-53e6-b9fd-e6c9dc0aa1aa
[2026.10.26-19.31.56:807][ 37]LogPlatformCommon: Platform HTTP Query End. QueryName: [LoginQueue_FetchToken], URL [POST https://euc1.pp.sgp.pvp.net/login-queue/v2/login/products/valorant/regions/eu], x
[2026.10.26-20.31.23:803][977]LogMapLoadModel: Update: [Map Name: Juliett | Changed: FALSE] [Local World: TRUE | Changed: TRUE] [URL: 1.2.3.4:7000/Game/Maps/Juliett/Juliett?Game=/Game/GameModes/Bomb/BombGameMode.BombGameMode_C]
[2026.10.26-20.31.40:165][555]LogLoadTimeMetrics: Display: [Match Load Times] MatchId: 5c433b30-66e9-4fce-8a42-cdf36926f44a, LoadingScreenTime: 17.36
[2026.10.26-20.31.33:000][0]LogShooterGameState: Warning: Gameplay started at local time 0.007812 (server time 0.000000)
[2026.10.26-20.32.17:581][0]LogShooterGameState: Warning: Gameplay started at local time 45.078125 (server time 45.292187)
[2026.10.26-20.33.14:212][978]LogShooterGameState: Warning: AShooterGameState::OnRoundEnded for round '0'
[2026.10.26-20.33.14:300][0]LogShooterGameState: Warning: Gameplay started at local time 0.007812 (server time 0.000000)
[2026.10.26-20.33.44:300][0]LogShooterGameState: Warning: Gameplay started at local time 30.046875 (server time 30.292187)
[2026.10.26-21.17.00:000][0]LogShooterGameState: Match Ended: Completion State: 'Completed'. Winning Team: 'Red' (Defender)
";
        let m = last_match(log).unwrap();
        assert_eq!(m.id, "5c433b30-66e9-4fce-8a42-cdf36926f44a");
        assert_eq!((m.map.as_deref(), m.mode.as_deref()), (Some("Juliett"), Some("Bomb")));
        assert_eq!((m.puuid.as_deref(), m.region.as_deref()), (Some(ME), Some("eu")));
        assert_eq!(m.version.as_deref(), Some("release-13.08-shipping-22-5760300"));
        assert_eq!(m.round_starts.len(), 2);
        assert!((m.round_starts[&1] - m.round_starts[&0] - 86.719).abs() < 1e-6);
        assert!(m.has_rounds());
        assert!(last_match("[2026.10.26-19.31.51:083][  0]nothing").is_none());
    }

    #[test]
    fn places_our_kills_and_reads_the_result() {
        let details = json!({
            "players": [{ "subject": ME, "teamId": "Blue" }, { "subject": "x", "teamId": "Red" }],
            "teams": [{ "teamId": "Blue", "won": false, "roundsWon": 9 }, { "teamId": "Red", "won": true, "roundsWon": 13 }],
            "roundResults": [
                { "roundNum": 0, "winningTeam": "Blue", "playerStats": [
                    { "subject": ME, "kills": [
                        { "killer": ME, "victim": "x", "gameTime": 50000, "roundTime": 5000 },
                        { "killer": ME, "victim": "y", "gameTime": 52000, "roundTime": 7000 } ] },
                    { "subject": "x", "kills": [ { "killer": "x", "victim": ME, "gameTime": 60000, "roundTime": 15000 } ] } ] },
                { "roundNum": 1, "winningTeam": "Red", "playerStats": [
                    { "subject": ME, "kills": [ { "killer": ME, "victim": "z", "gameTime": 150000, "roundTime": 20000 } ] } ] }
            ]
        });
        // Round 1's start wasn't seen: placed by match time from round 0's.
        let starts = BTreeMap::from([(0, 1000.0)]);
        let o = outcome(&details, ME, &starts);
        assert_eq!(o.kills, vec![(1005.0, 0), (1007.0, 0), (1105.0, 1)]);
        assert_eq!((o.score, o.result.as_deref()), (Some((9, 13)), Some("lost")));
        assert_eq!(o.round_results, BTreeMap::from([(1, "won".to_string()), (2, "lost".to_string())]));
    }

    /// Parse a real ShooterGame.log and, with the Riot Client open and
    /// signed in, fetch that match's details and print our kills in wall time.
    /// `CLIPFORGE_VALORANT_LOG=... cargo test --lib valmatch::tests::live_match -- --ignored --nocapture`
    /// Set CLIPFORGE_SAVE_DETAILS=<file> to keep the response as a fixture.
    #[test]
    #[ignore]
    fn live_match() {
        let path = std::env::var("CLIPFORGE_VALORANT_LOG").expect("set CLIPFORGE_VALORANT_LOG");
        let m = last_match(&String::from_utf8_lossy(&std::fs::read(path).unwrap())).expect("a finished match");
        println!("match {} on {:?} ({:?}), {} round starts, {:.0}..{:.0}", m.id, m.map, m.mode, m.round_starts.len(), m.start, m.end);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let d = rt.block_on(details(&m)).expect("match details");
        if let Ok(out) = std::env::var("CLIPFORGE_SAVE_DETAILS") {
            std::fs::write(out, serde_json::to_vec_pretty(&d).unwrap()).unwrap();
        }
        let o = outcome(&d, m.puuid.as_deref().unwrap(), &m.round_starts);
        println!("score {:?} {:?}", o.score, o.result);
        for (k, r) in &o.kills {
            println!("kill {k:.3} round {r}");
        }
    }

    /// A real match-details response (2026-10-26, Haven), trimmed to the
    /// fields read here and with every player id replaced.
    #[test]
    fn reads_a_real_match() {
        let path = format!("{}/testdata/valorant/match_details.json", env!("CARGO_MANIFEST_DIR"));
        let details: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        // Only round 0's start known: every other kill is placed by match time.
        let o = outcome(&details, "me", &BTreeMap::from([(0, 1000.0)]));
        assert_eq!((o.score, o.result.as_deref()), (Some((12, 14)), Some("lost")));
        assert_eq!(o.kills.len(), 26);
        assert_eq!(o.round_results.len(), 26);
        assert!(o.kills.windows(2).all(|w| w[0].0 <= w[1].0), "in play order");
        assert!(o.kills.iter().all(|(k, _)| *k > 1000.0 && *k < 1000.0 + 3600.0));
    }

    #[test]
    fn labels_follow_the_real_kills() {
        assert_eq!(relabel("Valorant 3K 2026-10-26 21-24-01", Some("2K")).as_deref(), Some("Valorant 2K 2026-10-26 21-24-01"));
        assert_eq!(relabel("Valorant ACE 2026-10-26 21-33-03", None).as_deref(), Some("Valorant 2026-10-26 21-33-03"));
        assert_eq!(relabel("Valorant 2026-10-26 21-08-09", Some("2K")).as_deref(), Some("Valorant 2K 2026-10-26 21-08-09"));
    }
}
