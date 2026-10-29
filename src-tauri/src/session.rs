//! Full-session recording (opt-in): while a game runs, the whole session is
//! also written to one file, with every detected kill bookmarked on its
//! timeline. Highlights can be cut afterwards in the editor instead of
//! having to be clipped in the moment.
//!
//! The session borrows the replay buffer's encoders (engine.rs), so it adds
//! disk writes, not encoding work. It records into `<clips>/.sessions` as a
//! fragmented MP4 (playable even after a crash) and, when the game ends, is
//! remuxed losslessly into a normal MP4 next to the clips, kill markers and
//! all.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::engine::ENGINE;

/// Don't start a session with less free space than this, and stop one
/// that drops below `STOP_BELOW_BYTES` (the clips themselves need room).
const START_ABOVE_BYTES: u64 = 8 << 30;
const STOP_BELOW_BYTES: u64 = 3 << 30;

/// When the running session started (bookmarks are relative to it).
static STARTED: std::sync::Mutex<Option<(Instant, String)>> = std::sync::Mutex::new(None);
/// Low-disk refusal already logged for this game run.
static REFUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn local_stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}-{:02}-{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

fn sessions_dir(clips_dir: &str) -> PathBuf {
    Path::new(clips_dir).join(".sessions")
}

/// Session clip name: "<Game> Session <date time>.mp4".
fn session_name(game: &str, stamp: &str) -> String {
    format!("{} Session {stamp}.mp4", crate::obs::pretty_game_name(game))
}

/// Supervisor hook, once per tick: start, stop and finish sessions.
pub async fn tick(app: &AppHandle, settings: &crate::clips::Settings, game: Option<&str>, buffer_active: bool) {
    let active = ENGINE.session_active();
    let free = crate::clips::disk_free(settings.clips_dir.clone()).ok();
    // Every game is recorded whole (when the drive has room; otherwise
    // kills are clipped live from the replay buffer instead).
    let want = buffer_active && game.is_some();

    if active && !want {
        crate::obs::blocking(|| Ok(ENGINE.stop_session())).await.ok();
    } else if active && free.is_some_and(|f| f < STOP_BELOW_BYTES) {
        crate::logs::line("session recording stopped: clips drive almost full");
        crate::obs::blocking(|| Ok(ENGINE.stop_session())).await.ok();
        crate::obs::notify_failure(app, "Session recording stopped", "Your clips drive is almost full.");
    } else if !active && want {
        let game = game.unwrap_or_default();
        if free.is_some_and(|f| f < START_ABOVE_BYTES) {
            if !REFUSED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                crate::logs::line("session recording not started: under 8 GB free on the clips drive");
            }
        } else {
            let dir = sessions_dir(&settings.clips_dir);
            let path = dir.join(session_name(game, &local_stamp()));
            let started = crate::obs::blocking(move || {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                ENGINE.start_session(&path)
            })
            .await;
            match started {
                Ok(()) => {
                    *STARTED.lock().unwrap() = Some((Instant::now(), game.to_string()));
                    crate::autoclip::begin_session();
                }
                Err(e) => crate::logs::line(&format!("session recording failed to start: {e}")),
            }
        }
    }
    if game.is_none() {
        REFUSED.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    for path in ENGINE.finished_sessions() {
        let started = STARTED.lock().unwrap().take();
        let kills = crate::autoclip::end_session();
        let clips_dir = settings.clips_dir.clone();
        let app=app.clone();
        tauri::async_runtime::spawn(async move {
            let markers: Vec<f64> = started
                .as_ref().map(|(s,_)| kills.iter().map(|k| k.saturating_duration_since(*s).as_secs_f64()).collect())
                .unwrap_or_default();
            let bookmarks = markers.clone();
            match crate::obs::blocking(move || finish(&path, &clips_dir, &bookmarks)).await {
                Ok(done) => {
                    if let Some((start,game))=started {
                        if let Ok(duration)=crate::clips::probe_clip_duration(&done) {
                            if duration.is_finite() && duration > 0.0 {
                                crate::matchdata::write_recording(&done,&game,start,start+Duration::from_secs_f64(duration),true);
                                // Re-muxing ends well after the game: stamp when the recording does.
                                let started_wall = std::time::SystemTime::now() - start.elapsed();
                                crate::clips::set_footage_end(&done, started_wall + Duration::from_secs_f64(duration));
                            }
                        }
                        // After the match info is written: each highlight gets its slice.
                        save_highlights(&app, &done, &game, start, &markers).await;
                    }
                    crate::logs::line(&format!("session saved: {done}"));
                    use tauri::Emitter;
                    let _=app.emit("match-metadata-changed",());
                },
                Err(e) => crate::logs::line(&format!("session finish failed (left in .sessions): {e}")),
            }
        });
    }
}

/// Cut the finished session's kills out as highlight clips (Settings ›
/// Automation › Cut highlights after each match).
async fn save_highlights(app: &AppHandle, session: &str, game: &str, start: Instant, markers: &[f64]) {
    let settings = crate::clips::load_settings_inner(app);
    let id = crate::clips::auto_clip_game_id(game);
    let rule = settings.clip_rule(&id);
    if !settings.session_highlights || !rule.enabled || markers.is_empty() {
        return;
    }
    let timing = crate::autoclip::timing(&id, settings.auto_clip_delay_s);
    let started = std::time::SystemTime::now() - start.elapsed();
    let (session, markers) = (session.to_string(), markers.to_vec());
    let written = crate::obs::blocking(move || {
        let duration = crate::clips::probe_clip_duration(&session)?;
        let plan = crate::highlights::plan(&markers, duration, timing, rule.min_kills);
        Ok(crate::highlights::cut(&session, &plan, started))
    })
    .await
    .unwrap_or_default();
    if !written.is_empty() {
        crate::logs::line(&format!("session highlights: {} clips", written.len()));
        use tauri::Emitter;
        let _ = app.emit("clips-changed", ());
        let _ = app.emit("highlights-saved", written.len());
    }
}

/// Remux the fragmented recording into a normal, quickly seekable MP4 in
/// the clips folder (stream copy: every audio track kept, no re-encode),
/// write its kill markers, and drop the fragmented original.
fn finish(path: &Path, clips_dir: &str, markers: &[f64]) -> Result<String, String> {
    let name = path.file_name().ok_or("bad session path")?;
    let target = Path::new(clips_dir).join(name);
    let ffmpeg = crate::clips::find_ffmpeg();
    let remuxed = ffmpeg.is_some_and(|ffmpeg| {
        crate::clips::ffmpeg_cmd(&ffmpeg)
            .args(["-hide_banner", "-y", "-i"])
            .arg(path)
            .args(["-map", "0", "-c", "copy", "-movflags", "+faststart"])
            .args(crate::clips::track_name_args(&crate::clips::track_roles(&ffmpeg, &path.to_string_lossy())))
            .arg(&target)
            .output()
            .is_ok_and(|o| o.status.success())
    });
    if remuxed {
        let _ = std::fs::remove_file(path);
    } else {
        // No ffmpeg (or it failed): the fragmented file plays as-is.
        let _ = std::fs::remove_file(&target);
        std::fs::rename(path, &target).map_err(|e| e.to_string())?;
    }
    let target = target.to_string_lossy().replace('\\', "/");
    if !markers.is_empty() {
        crate::clips::write_markers(&target, markers);
    }
    Ok(target)
}

/// Sessions left in `.sessions` by a crash: finish them on startup so they
/// show up in the library (markers are lost with the crash).
pub fn recover(clips_dir: &str) {
    let Ok(entries) = std::fs::read_dir(sessions_dir(clips_dir)) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_some_and(|e| e == "mp4") {
            match finish(&path, clips_dir, &[]) {
                Ok(done) => crate::logs::line(&format!("recovered session: {done}")),
                Err(e) => crate::logs::line(&format!("couldn't recover session {}: {e}", path.display())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real engine: buffer + a 5 s session sharing its encoders, then the
    /// remux. Reruns itself next to the OBS runtime like picture.rs's test.
    /// `cargo test --lib session::tests::live_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_session() {
        if std::env::var("CLIPFORGE_SESSION_CHILD").is_err() {
            let me = std::env::current_exe().unwrap();
            let debug_dir = me.parent().unwrap().parent().unwrap();
            let copy = debug_dir.join("session-selftest.exe");
            std::fs::copy(&me, &copy).unwrap();
            let out = std::process::Command::new(&copy)
                .args(["--ignored", "--exact", "session::tests::live_session", "--nocapture"])
                .env("CLIPFORGE_SESSION_CHILD", "1")
                .current_dir(debug_dir)
                .output()
                .unwrap();
            let _ = std::fs::remove_file(&copy);
            println!("{}", String::from_utf8_lossy(&out.stdout));
            assert!(out.status.success(), "child failed:\n{}", String::from_utf8_lossy(&out.stderr));
            return;
        }
        let dir = std::env::temp_dir().join("clipforge-session-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Game track switched off, other apps on: the file skips the game
        // track and names the rest.
        let settings = crate::clips::Settings {
            clips_dir: dir.to_string_lossy().replace('\\', "/"),
            other_apps: vec!["spotify.exe".into()],
            record_tracks: vec![2, 3, 4, 5],
            ..Default::default()
        };
        let video = crate::engine::video_config(30, 720);
        // Two voice apps and an other-app source, with the game-only mix.
        let audio = crate::engine::AudioConfig {
            game_only_mix: true,
            voice_apps: vec!["discord.exe".into(), "teamspeak.exe".into()],
            other_apps: vec!["spotify.exe".into()],
            ..Default::default()
        };
        ENGINE.ensure_started(video, &audio).unwrap();
        let (output, video) = crate::setup::desired_config(&settings, &ENGINE.video_encoders());
        println!("encoder: {}", output.encoder);
        ENGINE.configure(output, video).unwrap();
        ENGINE.start_buffer().unwrap();
        let path = sessions_dir(&settings.clips_dir).join(session_name("test.exe", "now"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        ENGINE.start_session(&path).unwrap();
        assert!(ENGINE.session_active());
        std::thread::sleep(std::time::Duration::from_secs(5));
        ENGINE.stop_session();
        let finished = ENGINE.finished_sessions();
        assert_eq!(finished, vec![path.clone()]);
        let raw = std::fs::metadata(&path).unwrap().len();
        let done = finish(&path, &settings.clips_dir, &[1.5, 3.0]).unwrap();
        ENGINE.shutdown();
        let duration = crate::clips::probe_clip_duration(&done).unwrap();
        println!("session file: {raw} bytes recorded, final {done}, {duration:.2}s");
        assert!(raw > 10_000, "nothing recorded");
        assert!((3.5..7.0).contains(&duration), "unexpected length {duration}");
        assert_eq!(crate::clips::read_markers(&done), vec![1.5, 3.0]);
        let roles = crate::clips::track_roles(&crate::clips::find_ffmpeg().unwrap(), &done);
        assert_eq!(roles, vec!["mix", "voice", "desktop", "mic", "other"]);
        assert!(!path.exists(), "fragmented original removed");
    }

    #[test]
    fn session_names_group_with_the_game() {
        assert_eq!(session_name("valorant-win64-shipping.exe", "2026-10-25 01-30-00"), "Valorant Session 2026-10-25 01-30-00.mp4");
        assert!(sessions_dir("D:/Clips").ends_with(".sessions"));
    }
}
