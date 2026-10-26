//! Per-game event sources beyond CS2/League, after Medal's per-game
//! handlers: there is no generic kill detector, so each game is read
//! through whatever it exposes — a log file, a local stats socket, or a
//! config-file push (Dota 2 GSI, in `autoclip.rs`).
//!
//! Log rules and paths are the ones Medal's recorder ships with.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::autoclip::LogTrigger;

/// Steam library roots: the install from the registry (Steam may live on
/// any drive), the default folders, and every library in
/// `libraryfolders.vdf`.
pub fn steam_library_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(path) = registry_string(r"Software\Valve\Steam", "SteamPath") {
        roots.push(PathBuf::from(path));
    }
    roots.push(PathBuf::from("C:/Program Files (x86)/Steam"));
    roots.push(PathBuf::from("C:/Program Files/Steam"));
    for root in roots.clone() {
        let Ok(raw) = std::fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) else {
            continue;
        };
        for line in raw.lines() {
            let line = line.trim();
            if line.starts_with("\"path\"") {
                if let Some(path) = line.split('"').nth(3) {
                    roots.push(PathBuf::from(path.replace("\\\\", "/")));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    roots.retain(|r| r.exists() && seen.insert(r.to_string_lossy().to_lowercase().replace('\\', "/")));
    roots
}

/// A Steam game's install folder (`steamapps/common/<folder>`).
pub fn steam_game_dir(folder: &str) -> Option<PathBuf> {
    steam_library_roots()
        .into_iter()
        .map(|r| r.join("steamapps/common").join(folder))
        .find(|p| p.exists())
}

fn registry_string(subkey: &str, value: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(subkey),
            &HSTRING::from(value),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
        .ok()
        .ok()?;
    }
    let chars = (len as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..chars]))
}

// ---- Log-file games ---------------------------------------------------

/// Built-in log trigger for `game` (lowercase exe), if ClipForge knows one.
/// User entries in log_triggers.json take precedence.
pub fn builtin_log_trigger(game: &str) -> Option<LogTrigger> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let (log_path, pattern) = match game {
        // Arena Breakout: Infinite logs every kill the local player makes.
        // The save folder differs per launcher; use the newest log.
        "uagame.exe" => (
            newest(["Saved", "Saved_Steam", "Saved_Epic"].map(|s| {
                Path::new(&local).join("ABInfinite").join(s).join("Logs/ABInfinite.log")
            }))?,
            r"Parse KillEnemyEvent gid:-?\d+, name:[^,]+, timeStamp:\d+, enemyIdentity:\d+",
        ),
        // Valheim: a boss trophy unlock means the boss just died.
        "valheim.exe" => (
            Path::new(&std::env::var("USERPROFILE").ok()?)
                .join("AppData/LocalLow/IronGate/Valheim/Player.log"),
            r"Queue unlock msg:\$msg_newtrophy:\$item_trophy_(eikthyr|elder|bonemass|dragonqueen|goblinking|seekerqueen|fader)",
        ),
        _ => return None,
    };
    Some(LogTrigger {
        game_exe: game.to_string(),
        log_path: log_path.to_string_lossy().replace('\\', "/"),
        pattern: pattern.to_string(),
    })
}

fn newest<const N: usize>(paths: [PathBuf; N]) -> Option<PathBuf> {
    paths
        .into_iter()
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

// ---- Rocket League Stats API ------------------------------------------

/// Statfeed events worth a clip when the local player is the one scoring.
fn rl_highlight(event: &str) -> bool {
    (event.contains("Goal") && event != "OwnGoal") || matches!(event, "EpicSave" | "Demolish" | "HatTrick")
}

fn rocket_league_dir() -> Option<PathBuf> {
    if let Some(dir) = steam_game_dir("rocketleague") {
        return Some(dir);
    }
    // Epic: one JSON manifest per installed game.
    let manifests = std::fs::read_dir("C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests").ok()?;
    manifests.flatten().find_map(|entry| {
        let raw = std::fs::read_to_string(entry.path()).ok()?;
        let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
        if !json["MandatoryAppFolderName"].as_str()?.eq_ignore_ascii_case("rocketleague") {
            return None;
        }
        Some(PathBuf::from(json["InstallLocation"].as_str()?)).filter(|p| p.exists())
    })
}

/// Port of the Stats API, turning it on if it's off (`PacketSendRate=0`
/// disables the socket). The game reads the file at launch, so this runs
/// at app start, like Medal's StatsApiUtils.
fn enable_rl_stats_api() -> Option<u16> {
    let ini = rocket_league_dir()?.join("TAGame/Config/DefaultStatsAPI.ini");
    let raw = std::fs::read_to_string(&ini).ok()?;
    let (patched, port) = patch_stats_ini(&raw);
    if patched != raw {
        match std::fs::write(&ini, &patched) {
            Ok(()) => crate::logs::line("rocket league: enabled the Stats API (applies next launch)"),
            Err(e) => crate::logs::line(&format!("rocket league: can't enable the Stats API: {e}")),
        }
    }
    Some(port)
}

/// Returns the ini with `PacketSendRate` at least 1, and the port.
fn patch_stats_ini(raw: &str) -> (String, u16) {
    let mut port = 49123;
    let lines: Vec<String> = raw
        .lines()
        .map(|line| {
            let (key, value) = line.split_once('=').unwrap_or((line, ""));
            match key.trim() {
                "Port" => {
                    port = value.trim().parse().unwrap_or(port);
                    line.to_string()
                }
                "PacketSendRate" if value.trim().parse::<f64>().map_or(true, |r| r <= 0.0) => {
                    "PacketSendRate=1".to_string()
                }
                _ => line.to_string(),
            }
        })
        .collect();
    let mut out = lines.join("\r\n");
    if raw.ends_with('\n') {
        out.push_str("\r\n");
    }
    (out, port)
}

/// `Data` is a JSON string in some game versions and an object in others.
fn message_data(msg: &serde_json::Value) -> serde_json::Value {
    match &msg["Data"] {
        serde_json::Value::String(s) => serde_json::from_str(s).unwrap_or_default(),
        other => other.clone(),
    }
}

/// Tracks who the camera follows (the local player while alive) and
/// reports statfeed events by them.
#[derive(Default)]
struct RlState {
    me: Option<String>,
}

impl RlState {
    fn handle(&mut self, msg: &serde_json::Value) -> bool {
        let data = message_data(msg);
        match msg["Event"].as_str() {
            Some("UpdateState") => {
                if let Some(name) = data["Game"]["Target"]["Name"].as_str().filter(|n| !n.is_empty()) {
                    self.me = Some(name.to_string());
                }
                false
            }
            Some("StatfeedEvent") => {
                let event = data["EventName"].as_str().unwrap_or_default();
                let by = data["MainTarget"]["Name"].as_str();
                rl_highlight(event) && by.is_some() && by == self.me.as_deref()
            }
            Some("MatchDestroyed") => {
                self.me = None;
                false
            }
            _ => false,
        }
    }
}

/// While Rocket League runs, read its Stats API socket and auto-clip the
/// local player's goals, epic saves and demos.
pub async fn rocket_league(app: AppHandle) {
    use tokio::io::AsyncReadExt;

    let Some(port) = tauri::async_runtime::spawn_blocking(enable_rl_stats_api).await.ok().flatten() else {
        return; // not installed
    };
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if !current_game_is(&app, "rocketleague.exe") {
            continue;
        }
        let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
            continue; // menu still loading, or the API is off this launch
        };
        crate::logs::line("rocket league: connected to the Stats API");
        let mut state = RlState::default();
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            let n = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await {
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(n)) => n,
                Err(_) if current_game_is(&app, "rocketleague.exe") => continue,
                Err(_) => break,
            };
            buf.extend_from_slice(&chunk[..n]);
            // Messages are back-to-back JSON objects with no framing.
            let mut stream_de = serde_json::Deserializer::from_slice(&buf).into_iter::<serde_json::Value>();
            let mut consumed = 0;
            while let Some(Ok(msg)) = stream_de.next() {
                consumed = stream_de.byte_offset();
                if state.handle(&msg) && crate::clips::load_settings_inner(&app).clip_rule("rocketleague").enabled {
                    crate::logs::line("auto-clip: rocket league highlight");
                    crate::autoclip::schedule(&app);
                }
            }
            buf.drain(..consumed);
            if buf.len() > 4 << 20 {
                buf.clear(); // not JSON we understand; resync
            }
        }
    }
}

fn current_game_is(app: &AppHandle, exe: &str) -> bool {
    app.state::<crate::obs::CurrentGame>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_some_and(|g| g.eq_ignore_ascii_case(exe))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stats_ini_is_enabled_and_port_read() {
        let raw = "[TAGame.MatchStatsExporter_TA]\r\nPort=49200\r\nPacketSendRate=0\r\n";
        let (patched, port) = patch_stats_ini(raw);
        assert_eq!(port, 49200);
        assert!(patched.contains("PacketSendRate=1\r\n"));
        let (same, _) = patch_stats_ini("[X]\r\nPacketSendRate=30\r\n");
        assert_eq!(same, "[X]\r\nPacketSendRate=30\r\n");
    }

    #[test]
    fn rl_clips_only_own_highlights() {
        let mut s = RlState::default();
        assert!(!s.handle(&json!({"Event": "UpdateState", "Data": {"Game": {"Target": {"Name": "Me"}}}})));
        let feed = |event: &str, by: &str| json!({"Event": "StatfeedEvent", "Data": {"EventName": event, "MainTarget": {"Name": by}}});
        assert!(s.handle(&feed("Goal", "Me")));
        assert!(s.handle(&feed("AerialGoal", "Me")));
        assert!(!s.handle(&feed("Goal", "Them")));
        assert!(!s.handle(&feed("Shot", "Me")));
        // Data as an encoded string.
        let encoded = json!({"Event": "StatfeedEvent", "Data": "{\"EventName\":\"Demolish\",\"MainTarget\":{\"Name\":\"Me\"}}"});
        assert!(s.handle(&encoded));
    }

    #[test]
    fn builtin_patterns_match_medal_log_lines() {
        let abi = regex::Regex::new(r"Parse KillEnemyEvent gid:-?\d+, name:[^,]+, timeStamp:\d+, enemyIdentity:\d+").unwrap();
        assert!(abi.is_match("[2026.10.24-12.00.00:000][  0]LogTemp: Parse KillEnemyEvent gid:123, name:Bob, timeStamp:1729800000, enemyIdentity:2"));
        let valheim = regex::Regex::new(r"Queue unlock msg:\$msg_newtrophy:\$item_trophy_(eikthyr|elder|bonemass|dragonqueen|goblinking|seekerqueen|fader)").unwrap();
        assert!(valheim.is_match("10/24/2026 12:00:00: Queue unlock msg:$msg_newtrophy:$item_trophy_eikthyr"));
        assert!(!valheim.is_match("10/24/2026 12:00:00: Queue unlock msg:$msg_newtrophy:$item_trophy_deer"));
    }
}
