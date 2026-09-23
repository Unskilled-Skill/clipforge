//! Back up favorited clips to a cloud-synced folder (Google Drive, OneDrive,
//! Dropbox…), never while a game runs.
//!
//! Recording straight into a synced folder uploads every ~450 MB clip the
//! moment it's saved, mid-match, which can spike ping in online games. So
//! clips live on a local drive and only the keepers (starred clips) are
//! copied to the backup folder, after the game has closed. The sync client
//! then uploads them while nobody is playing.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_RESULT: Mutex<(Option<u64>, Option<String>)> = Mutex::new((None, None));

/// Idle-time checks are cheap but touch the synced drive; once a minute is
/// plenty (starring a clip or "Back up now" skips the wait).
const CHECK_EVERY: Duration = Duration::from_secs(60);

#[derive(Serialize, Clone, Default)]
pub struct BackupStatus {
    pub enabled: bool,
    pub folder_ok: bool,
    pub backed_up: u32,
    pub pending: u32,
    pub running: bool,
    /// Unix ms of the last finished run.
    pub last_run_ms: Option<u64>,
    pub error: Option<String>,
}

fn backup_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::clips::load_settings_inner(app).backup_dir;
    let dir = dir.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Favorites still to copy: (source clip, destination in the backup folder).
/// A copy counts as done when a same-named file of the same size exists.
fn pending(app: &AppHandle, dir: &Path) -> (Vec<(PathBuf, PathBuf)>, u32) {
    let favorites = crate::clips::load_favorites(app.clone()).unwrap_or_default();
    let mut todo = Vec::new();
    let mut done = 0;
    for fav in favorites {
        let src = PathBuf::from(&fav);
        let (Ok(meta), Some(name)) = (std::fs::metadata(&src), src.file_name()) else {
            continue; // deleted or renamed away since it was starred
        };
        let dst = dir.join(name);
        match std::fs::metadata(&dst) {
            Ok(d) if d.len() == meta.len() => done += 1,
            _ => todo.push((src, dst)),
        }
    }
    (todo, done)
}

pub fn status(app: &AppHandle) -> BackupStatus {
    let (last_run_ms, error) = LAST_RESULT.lock().map(|r| r.clone()).unwrap_or_default();
    let mut s = BackupStatus {
        running: RUNNING.load(Ordering::Relaxed),
        last_run_ms,
        error,
        ..Default::default()
    };
    let Some(dir) = backup_dir(app) else {
        return s;
    };
    s.enabled = true;
    s.folder_ok = dir.is_dir();
    if s.folder_ok {
        let (todo, done) = pending(app, &dir);
        s.pending = todo.len() as u32;
        s.backed_up = done;
    }
    s
}

/// Copy via a `.partial` name, then rename, so the sync client never
/// uploads a half-written file as the real clip.
fn copy_one(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(".partial");
    let tmp = PathBuf::from(tmp);
    std::fs::copy(src, &tmp)?;
    if dst.exists() {
        std::fs::remove_file(dst)?; // older/incomplete copy
    }
    std::fs::rename(&tmp, dst)
}

/// Start a backup pass in the background if one is due. `force` skips the
/// once-a-minute throttle (user starred a clip or pressed "Back up now").
/// Never runs while a game is running; a pass stops early if one starts.
pub fn maybe_run(app: &AppHandle, force: bool) {
    if crate::clips::GAME_RUNNING.load(Ordering::Relaxed) {
        return;
    }
    if !force {
        let mut last = LAST_CHECK.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < CHECK_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    let Some(dir) = backup_dir(app) else {
        return;
    };
    if !dir.is_dir() || RUNNING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let (todo, _) = pending(&app, &dir);
        let mut error = None;
        let mut copied = 0;
        for (src, dst) in todo {
            if crate::clips::GAME_RUNNING.load(Ordering::Relaxed) {
                break; // resume after the game
            }
            match copy_one(&src, &dst) {
                Ok(()) => copied += 1,
                Err(e) => {
                    error = Some(format!(
                        "Couldn't back up {}: {e}",
                        src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                    ));
                    break;
                }
            }
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .ok();
        if let Ok(mut r) = LAST_RESULT.lock() {
            *r = (now_ms, error);
        }
        RUNNING.store(false, Ordering::Relaxed);
        if copied > 0 {
            let _ = app.emit("backup-done", copied);
        }
    });
}

#[tauri::command]
pub fn backup_status(app: AppHandle) -> BackupStatus {
    status(&app)
}

#[tauri::command]
pub fn backup_now(app: AppHandle) -> Result<(), String> {
    if crate::clips::GAME_RUNNING.load(Ordering::Relaxed) {
        return Err("Backups wait until your game closes.".into());
    }
    let dir = backup_dir(&app).ok_or("Pick a backup folder first.")?;
    if !dir.is_dir() {
        return Err(format!("Backup folder not found: {}", dir.display()));
    }
    maybe_run(&app, true);
    Ok(())
}

/// Heuristic: is this path inside a cloud-sync client's folder? Used to
/// warn when the *clips* folder itself is synced (upload mid-match).
pub fn cloud_synced_provider(path: &str) -> Option<&'static str> {
    let p = path.to_lowercase().replace('\\', "/");
    let by_path = [
        ("/my drive/", "Google Drive"),
        ("/google drive/", "Google Drive"),
        ("/onedrive", "OneDrive"),
        ("/dropbox/", "Dropbox"),
        ("/iclouddrive/", "iCloud Drive"),
    ];
    if let Some((_, name)) = by_path.iter().find(|(needle, _)| p.contains(needle)) {
        return Some(name);
    }
    // Google Drive for desktop mounts a whole drive letter labelled
    // "Google Drive" (e.g. F:\My Drive\...), caught above via "My Drive",
    // but also check the volume label for its shared-drives view.
    volume_label(path).filter(|l| l.eq_ignore_ascii_case("Google Drive")).map(|_| "Google Drive")
}

fn volume_label(path: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    let root = Path::new(path).components().next()?.as_os_str().to_string_lossy().to_string() + "\\";
    let mut name = [0u16; 261];
    unsafe {
        GetVolumeInformationW(&HSTRING::from(root), Some(&mut name), None, None, None, None).ok()?;
    }
    let len = name.iter().position(|&c| c == 0).unwrap_or(0);
    Some(String::from_utf16_lossy(&name[..len]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_via_partial_and_replaces_stale() {
        let dir = std::env::temp_dir().join(format!("cf-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("clip.mp4");
        let dst = dir.join("backup.mp4");
        std::fs::write(&src, vec![7u8; 4096]).unwrap();
        std::fs::write(&dst, b"half").unwrap(); // stale, incomplete copy
        copy_one(&src, &dst).unwrap();
        assert_eq!(std::fs::metadata(&dst).unwrap().len(), 4096);
        assert!(!dir.join("backup.mp4.partial").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_synced_paths() {
        assert_eq!(cloud_synced_provider(r"F:\My Drive\Media\Clips"), Some("Google Drive"));
        assert_eq!(cloud_synced_provider(r"C:\Users\x\OneDrive\Videos"), Some("OneDrive"));
        assert_eq!(cloud_synced_provider(r"C:\Users\x\Dropbox\Clips"), Some("Dropbox"));
        assert_eq!(cloud_synced_provider(r"C:\Users\x\Videos\Clips"), None);
    }
}
