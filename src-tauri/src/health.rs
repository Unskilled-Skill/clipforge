//! Recording health: is OBS keeping up while a game runs?
//!
//! OBS reports cumulative frame counters. Two ways clips get choppy:
//! - render lag: the GPU is so busy with the game that OBS can't composite
//!   frames in time (`render_skipped_frames`);
//! - encoding lag: the encoder can't keep up (`output_skipped_frames`).
//! Both are invisible until you watch a stuttery clip. The supervisor feeds a
//! sample every tick; we keep a ~30s rolling window so a single hiccup (alt-
//! tab, loading screen) doesn't raise a warning, but sustained drops do.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;

/// Share of frames dropped (over the window) that counts as a problem.
const LAG_THRESHOLD_PCT: f64 = 1.0;
/// Supervisor ticks every 3s: 10 samples = 30s.
const WINDOW: usize = 10;

#[derive(Clone, Copy)]
struct Counters {
    render_skipped: u32,
    render_total: u32,
    output_skipped: u32,
    output_total: u32,
}

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct Health {
    /// % of frames OBS couldn't render in time (GPU busy), last ~30s.
    pub render_lag_pct: f64,
    /// % of frames the encoder dropped, last ~30s (only while recording).
    pub encoder_lag_pct: f64,
    pub active_fps: f64,
    pub obs_cpu_pct: f64,
}

struct Tracker {
    last: Option<Counters>,
    /// Per-tick deltas: (render_skipped, render_total, output_skipped, output_total).
    window: VecDeque<(u64, u64, u64, u64)>,
    latest: Health,
}

static TRACKER: Mutex<Tracker> = Mutex::new(Tracker {
    last: None,
    window: VecDeque::new(),
    latest: Health {
        render_lag_pct: 0.0,
        encoder_lag_pct: 0.0,
        active_fps: 0.0,
        obs_cpu_pct: 0.0,
    },
});

fn pct(skipped: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        skipped as f64 * 100.0 / total as f64
    }
}

/// Feed one stats sample (call once per supervisor tick while connected).
pub fn record(stats: &obws::responses::general::Stats) -> Health {
    let now = Counters {
        render_skipped: stats.render_skipped_frames,
        render_total: stats.render_total_frames,
        output_skipped: stats.output_skipped_frames,
        output_total: stats.output_total_frames,
    };
    let Ok(mut t) = TRACKER.lock() else {
        return Health::default();
    };
    if let Some(prev) = t.last {
        // Counters reset when OBS restarts or outputs restart: treat a
        // backwards step as a fresh start rather than a huge negative delta.
        let d = |a: u32, b: u32| a.checked_sub(b).unwrap_or(0) as u64;
        t.window.push_back((
            d(now.render_skipped, prev.render_skipped),
            d(now.render_total, prev.render_total),
            d(now.output_skipped, prev.output_skipped),
            d(now.output_total, prev.output_total),
        ));
        while t.window.len() > WINDOW {
            t.window.pop_front();
        }
    }
    t.last = Some(now);
    let sum = t.window.iter().fold((0, 0, 0, 0), |a, w| (a.0 + w.0, a.1 + w.1, a.2 + w.2, a.3 + w.3));
    t.latest = Health {
        render_lag_pct: pct(sum.0, sum.1),
        encoder_lag_pct: pct(sum.2, sum.3),
        active_fps: stats.active_fps,
        obs_cpu_pct: stats.cpu_usage,
    };
    t.latest.clone()
}

/// Forget history (OBS disconnected / restarted).
pub fn reset() {
    if let Ok(mut t) = TRACKER.lock() {
        t.last = None;
        t.window.clear();
        t.latest = Health::default();
    }
}

pub fn latest() -> Health {
    TRACKER.lock().map(|t| t.latest.clone()).unwrap_or_default()
}

pub fn is_lagging(pct: f64) -> bool {
    pct >= LAG_THRESHOLD_PCT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_and_percentages() {
        assert_eq!(pct(0, 0), 0.0);
        assert_eq!(pct(3, 300), 1.0);
        assert!(is_lagging(1.0));
        assert!(!is_lagging(0.4));
    }
}
