//! Highlights from full-session recordings: when a session ends, the kills
//! bookmarked on its timeline are grouped into moments and each moment is
//! cut out as its own clip (stream copy, every audio track kept). Cutting
//! after the match sees the whole fight, so a burst of kills is one clip with
//! the play leading up to it, never a clip that stops mid-fight.

use std::path::Path;

use crate::autoclip::Timing;

/// One moment to cut: seconds into the session, and the kills inside it.
#[derive(Debug, Clone, PartialEq)]
pub struct Highlight {
    pub start: f64,
    pub end: f64,
    pub kills: Vec<f64>,
}

/// Group kill times into highlights. Kills chain while each is within
/// `window` of the previous one; a chain becomes `[first - pre, last + post]`
/// (clamped to the recording), chains whose ranges then overlap merge, and a
/// moment longer than `max` keeps its end (where the kills finish).
/// Moments with fewer than `min_kills` kills are dropped.
pub fn plan(markers: &[f64], duration: f64, t: Timing, min_kills: u32) -> Vec<Highlight> {
    let mut kills: Vec<f64> = markers.iter().copied().filter(|k| k.is_finite() && *k >= 0.0 && *k <= duration).collect();
    kills.sort_by(|a, b| a.total_cmp(b));

    let mut chains: Vec<Vec<f64>> = Vec::new();
    for k in kills {
        match chains.last_mut() {
            Some(chain) if k - chain[chain.len() - 1] <= t.window => chain.push(k),
            _ => chains.push(vec![k]),
        }
    }

    let mut out: Vec<Highlight> = Vec::new();
    for chain in chains {
        let start = (chain[0] - t.pre).max(0.0);
        let end = (chain[chain.len() - 1] + t.post).min(duration);
        match out.last_mut() {
            Some(prev) if start <= prev.end => {
                prev.end = prev.end.max(end);
                prev.kills.extend(chain);
            }
            _ => out.push(Highlight { start, end, kills: chain }),
        }
    }
    out.retain(|h| h.kills.len() as u32 >= min_kills.max(1));
    for h in &mut out {
        if h.end - h.start > t.max {
            h.start = h.end - t.max;
            let start = h.start;
            h.kills.retain(|k| *k >= start);
        }
    }
    out.retain(|h| h.end - h.start >= 1.0);
    out
}

/// Highlight file name, next to the session it came from:
/// "Valorant Session 2026-10-26 14-08-41.mp4" → "Valorant 3K 2026-10-26 14-08-41 (2).mp4".
/// The recorder's own naming, so the library titles and groups it like any clip.
pub fn clip_name(session_file: &str, label: Option<&str>, index: usize) -> Option<String> {
    let stem = session_file.strip_suffix(".mp4")?;
    let (game, stamp) = stem.split_once(" Session ")?;
    let label = label.map(|l| format!(" {l}")).unwrap_or_default();
    Some(format!("{game}{label} {stamp} ({index}).mp4"))
}

/// Cut every planned highlight out of the finished session at `session`.
/// `started` is the session's wall-clock start, so each clip's modified time
/// is when its moment ends (like a clip saved live) and the library lists
/// them in play order.
/// Returns the clips written.
pub fn cut(session: &str, highlights: &[Highlight], started: std::time::SystemTime) -> Vec<String> {
    let Some(ffmpeg) = crate::clips::find_ffmpeg() else { return Vec::new() };
    let path = Path::new(session);
    let Some(file) = path.file_name().map(|f| f.to_string_lossy().into_owned()) else { return Vec::new() };
    let names = crate::clips::track_name_args(&crate::clips::track_roles(&ffmpeg, session));
    let mut written = Vec::new();
    for (i, h) in highlights.iter().enumerate() {
        let n = h.kills.len() as u32;
        let label = crate::autoclip::kill_label(n, n);
        let Some(name) = clip_name(&file, label.as_deref(), i + 1) else { continue };
        let Ok(out) = crate::clips::reserve_output(path.with_file_name(name)) else { continue };
        let ok = crate::clips::ffmpeg_cmd(&ffmpeg)
            .args(["-hide_banner", "-y", "-ss", &format!("{:.3}", h.start), "-to", &format!("{:.3}", h.end), "-i"])
            .arg(path)
            .args(["-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart"])
            .args(&names)
            .arg(&out)
            .output()
            .is_ok_and(|o| o.status.success());
        if !ok {
            let _ = std::fs::remove_file(&out);
            crate::logs::line(&format!("highlight {} of {session} failed to cut", i + 1));
            continue;
        }
        let out = out.to_string_lossy().replace('\\', "/");
        let markers: Vec<f64> = h.kills.iter().map(|k| k - h.start).collect();
        crate::clips::write_markers(&out, &markers);
        crate::matchdata::copy_selection(session, &out, h.start, h.end);
        crate::clips::set_footage_end(&out, started + std::time::Duration::from_secs_f64(h.end));
        written.push(out);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Timing = Timing { window: 10.0, pre: 10.0, post: 10.0, max: 120.0 };

    #[test]
    fn kills_close_together_share_one_highlight() {
        // 0, 6, 14 chain (gaps 6 and 8); 40 is its own moment.
        let h = plan(&[40.0, 6.0, 0.0, 14.0], 100.0, T, 1);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].start, h[0].end, h[0].kills.len()), (0.0, 24.0, 3));
        assert_eq!((h[1].start, h[1].end), (30.0, 50.0));
    }

    #[test]
    fn overlapping_moments_merge_and_minimum_drops_singles() {
        // Gap 20 > window, but [0, 20] and [20, 40] touch: one moment.
        let h = plan(&[10.0, 30.0], 100.0, T, 1);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kills, vec![10.0, 30.0]);
        assert!(plan(&[10.0, 60.0], 100.0, T, 2).is_empty());
    }

    #[test]
    fn long_moments_keep_their_end_and_stay_in_the_recording() {
        let kills: Vec<f64> = (0..30).map(|i| 20.0 + i as f64 * 8.0).collect(); // 20..252
        let h = plan(&kills, 300.0, T, 1);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].end, 262.0);
        assert_eq!(h[0].start, 142.0);
        assert!(h[0].kills.iter().all(|k| *k >= 142.0));
        let edge = plan(&[2.0, 299.0], 300.0, T, 1);
        assert_eq!((edge[0].start, edge[1].end), (0.0, 300.0));
    }

    #[test]
    fn names_follow_the_recorder() {
        assert_eq!(
            clip_name("Valorant Session 2026-10-26 14-08-41.mp4", Some("3K"), 2).as_deref(),
            Some("Valorant 3K 2026-10-26 14-08-41 (2).mp4")
        );
        assert_eq!(clip_name("Cs2 Session 2026-10-26 14-08-41.mp4", None, 1).as_deref(), Some("Cs2 2026-10-26 14-08-41 (1).mp4"));
    }
}

#[cfg(test)]
mod live_tests {
    /// Cuts a real recording as if it were a session. Point
    /// CLIPFORGE_TEST_CLIP at any clip; it is copied, never changed.
    /// `cargo test --lib highlights::live_tests -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cuts_real_highlights() {
        let src = std::env::var("CLIPFORGE_TEST_CLIP").expect("set CLIPFORGE_TEST_CLIP");
        let dir = std::env::temp_dir().join("clipforge-highlights-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("Apex Session 2026-10-26 14-08-41.mp4");
        std::fs::copy(&src, &session).unwrap();
        let session = session.to_string_lossy().replace('\\', "/");
        let duration = crate::clips::probe_clip_duration(&session).unwrap();
        let t = crate::autoclip::timing("valorant", 8.0);
        let plan = super::plan(&[10.0, 15.0, 40.0], duration, t, 1);
        assert_eq!(plan.len(), 2);
        let started = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let out = super::cut(&session, &plan, started);
        assert_eq!(out.len(), 2, "both highlights cut");
        let ffmpeg = crate::clips::find_ffmpeg().unwrap();
        for (path, h) in out.iter().zip(&plan) {
            let d = crate::clips::probe_clip_duration(path).unwrap();
            let roles = crate::clips::track_roles(&ffmpeg, path);
            println!("{path}: {d:.2}s (planned {:.1}s), tracks {roles:?}, markers {:?}", h.end - h.start, crate::clips::read_markers(path));
            assert!((d - (h.end - h.start)).abs() < 1.5, "length close to plan");
            assert_eq!(roles, crate::clips::track_roles(&ffmpeg, &session), "every track kept, named");
        }
        assert!(out[0].ends_with("Apex 2K 2026-10-26 14-08-41 (1).mp4"));
    }
}
