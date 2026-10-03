//! Log file: capture-engine output plus ClipForge's own events, so a broken
//! setup on someone's PC can be diagnosed from "Open logs" in Health.
//! `%APPDATA%\com.roche.clipforge\logs\clipforge.log`, rotated to
//! `clipforge.old.log` past 5 MB.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use libobs_wrapper::{enums::ObsLogLevel, logger::ObsLogger};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn dir() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|a| PathBuf::from(a).join("com.roche.clipforge").join("logs"))
}

/// Open the log file (rotating an oversized one) and log panics into it.
pub fn init() {
    let Some(dir) = dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("clipforge.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("clipforge.old.log"));
    }
    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        *FILE.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        line(&format!("PANIC: {info}"));
        default_hook(info);
    }));
    line(&format!("--- ClipForge {} starting ---", env!("CARGO_PKG_VERSION")));
}

/// UTC time of day; good enough to line events up within one session.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{:02}:{:02}:{:02}Z", secs / 3600 % 24, secs / 60 % 60, secs % 60)
}

/// Append one line (also echoed to stderr for dev runs).
pub fn line(msg: &str) {
    eprintln!("{msg}");
    if let Some(file) = FILE.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        let _ = writeln!(file, "{} {msg}", timestamp());
    }
}

/// Routes libobs' log into the file. Debug-level chatter is dropped.
#[derive(Debug)]
pub struct EngineLogger;

impl ObsLogger for EngineLogger {
    fn log(&mut self, level: ObsLogLevel, msg: String) {
        if !matches!(level, ObsLogLevel::Debug) {
            line(&format!("[obs {level}] {msg}"));
        }
    }
}

/// Open the logs folder in Explorer.
#[tauri::command]
pub fn open_logs() -> Result<(), String> {
    let dir = dir().ok_or("no APPDATA folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
