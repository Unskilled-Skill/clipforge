//! Watches the captured picture for a frozen or black feed while a game
//! runs, so a broken capture is caught before clips come out useless
//! (Medal's stuck-frame / single-colour checks).
//!
//! Once a second, right after libobs renders a frame, the frame is drawn
//! into a 64×36 texture and staged for readback; the previous second's
//! sample is read at the same time, so the GPU never waits on us. That's
//! the pattern OBS's own NDI output uses. Cost: one tiny draw and a 9 KB
//! copy per second; the full-size frame never leaves the GPU.

use std::os::raw::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use libobs_wrapper::sys::*;

const W: u32 = 64;
const H: u32 = 36;

/// Rendered frames between samples (= fps, one sample a second).
static INTERVAL: AtomicU32 = AtomicU32::new(60);
static FRAME: AtomicU32 = AtomicU32::new(0);

/// Graphics objects, touched only on the libobs graphics thread (or with
/// the graphics context entered).
struct Gfx {
    texrender: *mut gs_texrender_t,
    stage: *mut gs_stagesurf_t,
    staged: bool,
}
// Raw pointers owned by libobs' graphics subsystem; access is serialised by
// the mutex and always happens inside the graphics context.
unsafe impl Send for Gfx {}

static GFX: Mutex<Gfx> = Mutex::new(Gfx { texrender: std::ptr::null_mut(), stage: std::ptr::null_mut(), staged: false });
static STATS: Mutex<Picture> = Mutex::new(Picture::new());

/// How long the picture has been frozen or a single colour, in samples
/// (about seconds).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PictureState {
    pub still_secs: u32,
    pub solid_secs: u32,
}

/// Running tally over the samples.
pub struct Picture {
    prev: Vec<u8>,
    state: PictureState,
}

impl Picture {
    const fn new() -> Self {
        Picture { prev: Vec::new(), state: PictureState { still_secs: 0, solid_secs: 0 } }
    }

    /// Feed one luma sample (W×H bytes).
    fn push(&mut self, luma: &[u8]) {
        let (min, max) = luma.iter().fold((255u8, 0u8), |(lo, hi), &v| (lo.min(v), hi.max(v)));
        // A single colour (black, or a solid fill) has almost no spread.
        let solid = max.saturating_sub(min) < 12;
        // A frozen feed repeats the exact same frame; live video, even a
        // quiet menu, moves somewhere.
        let still = self.prev.len() == luma.len()
            && luma.iter().zip(&self.prev).map(|(a, b)| a.abs_diff(*b) as u32).sum::<u32>() * 4 < luma.len() as u32;
        self.state.solid_secs = if solid { self.state.solid_secs + 1 } else { 0 };
        self.state.still_secs = if still { self.state.still_secs + 1 } else { 0 };
        self.prev.clear();
        self.prev.extend_from_slice(luma);
    }
}

pub fn state() -> PictureState {
    STATS.lock().map(|s| s.state).unwrap_or_default()
}

/// Forget the tally (game changed, alt-tabbed, capture retargeted).
pub fn reset() {
    if let Ok(mut s) = STATS.lock() {
        *s = Picture::new();
    }
}

/// Read a mapped RGBA stage surface into luma.
unsafe fn read_luma(data: *const u8, linesize: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((W * H) as usize);
    for y in 0..H as usize {
        let row = std::slice::from_raw_parts(data.add(y * linesize as usize), (W * 4) as usize);
        out.extend(row.chunks_exact(4).map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8));
    }
    out
}

/// libobs main-rendered callback: runs on the graphics thread after every
/// frame, with the graphics context entered.
unsafe extern "C" fn rendered(_param: *mut c_void) {
    let interval = INTERVAL.load(Ordering::Relaxed).max(1);
    if FRAME.fetch_add(1, Ordering::Relaxed) % interval != 0 {
        return;
    }
    let Ok(mut g) = GFX.try_lock() else { return };

    // Last second's sample has had a full second to arrive: no stall.
    if g.staged {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut linesize = 0u32;
        if gs_stagesurface_map(g.stage, &mut data, &mut linesize) {
            let luma = read_luma(data, linesize);
            gs_stagesurface_unmap(g.stage);
            if let Ok(mut s) = STATS.lock() {
                s.push(&luma);
            }
        }
        g.staged = false;
    }

    let tex = obs_get_main_texture();
    if tex.is_null() {
        return;
    }
    if g.texrender.is_null() {
        g.texrender = gs_texrender_create(gs_color_format_GS_RGBA, gs_zstencil_format_GS_ZS_NONE);
        g.stage = gs_stagesurface_create(W, H, gs_color_format_GS_RGBA);
    }
    if g.texrender.is_null() || g.stage.is_null() {
        return;
    }
    let (tw, th) = (gs_texture_get_width(tex), gs_texture_get_height(tex));
    gs_texrender_reset(g.texrender);
    if gs_texrender_begin(g.texrender, W, H) {
        let clear: vec4 = std::mem::zeroed();
        gs_clear(GS_CLEAR_COLOR, &clear, 0.0, 0);
        gs_ortho(0.0, tw as f32, 0.0, th as f32, -100.0, 100.0);
        gs_blend_state_push();
        gs_enable_blending(false);
        obs_render_main_texture();
        gs_blend_state_pop();
        gs_texrender_end(g.texrender);
        gs_stage_texture(g.stage, gs_texrender_get_texture(g.texrender));
        g.staged = true;
    }
}

/// Start sampling (call on the libobs thread once the engine is up).
pub unsafe fn install(fps: u32) {
    INTERVAL.store(fps.max(1), Ordering::Relaxed);
    reset();
    obs_add_main_rendered_callback(Some(rendered), std::ptr::null_mut());
}

/// Stop sampling and free the graphics objects (libobs thread, before
/// libobs shuts down).
pub unsafe fn uninstall() {
    obs_remove_main_rendered_callback(Some(rendered), std::ptr::null_mut());
    if let Ok(mut g) = GFX.lock() {
        obs_enter_graphics();
        if !g.texrender.is_null() {
            gs_texrender_destroy(g.texrender);
        }
        if !g.stage.is_null() {
            gs_stagesurface_destroy(g.stage);
        }
        obs_leave_graphics();
        *g = Gfx { texrender: std::ptr::null_mut(), stage: std::ptr::null_mut(), staged: false };
    }
}

pub fn set_fps(fps: u32) {
    INTERVAL.store(fps.max(1), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seed: u8) -> Vec<u8> {
        (0..(W * H) as usize).map(|i| (i as u8).wrapping_mul(7).wrapping_add(seed)).collect()
    }

    #[test]
    fn counts_frozen_and_solid_seconds() {
        let mut p = Picture::new();
        p.push(&frame(0));
        assert_eq!(p.state, PictureState { still_secs: 0, solid_secs: 0 });
        p.push(&frame(0));
        p.push(&frame(0));
        assert_eq!(p.state.still_secs, 2, "same frame twice more");
        p.push(&frame(9));
        assert_eq!(p.state.still_secs, 0, "the picture moved");
        let black = vec![3u8; (W * H) as usize];
        p.push(&black);
        p.push(&black);
        assert_eq!(p.state, PictureState { still_secs: 1, solid_secs: 2 });
    }

    /// End-to-end on the real engine: with no game hooked the canvas is
    /// black, so the probe must report a single-colour picture that grows
    /// once a second. libobs loads from next to the exe, so the test copies
    /// itself into target/debug and reruns there.
    /// `cargo test --lib picture::tests::live_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_probe() {
        if std::env::var("CLIPFORGE_PROBE_CHILD").is_err() {
            let me = std::env::current_exe().unwrap();
            let debug_dir = me.parent().unwrap().parent().unwrap();
            assert!(debug_dir.join("obs.dll").exists(), "run `npm run tauri dev` once to fetch the OBS runtime");
            let copy = debug_dir.join("probe-selftest.exe");
            std::fs::copy(&me, &copy).unwrap();
            let out = std::process::Command::new(&copy)
                .args(["--ignored", "--exact", "picture::tests::live_probe", "--nocapture"])
                .env("CLIPFORGE_PROBE_CHILD", "1")
                .current_dir(debug_dir)
                .output()
                .unwrap();
            let _ = std::fs::remove_file(&copy);
            println!("{}", String::from_utf8_lossy(&out.stdout));
            assert!(out.status.success(), "child failed:\n{}", String::from_utf8_lossy(&out.stderr));
            return;
        }
        let video = crate::engine::video_config(60, 0);
        crate::engine::ENGINE.ensure_started(video, &crate::engine::AudioConfig::default()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(6));
        let s = state();
        crate::engine::ENGINE.shutdown();
        println!("probe after 6s: {s:?}");
        assert!(s.solid_secs >= 3, "black canvas not seen: {s:?}");
    }

    #[test]
    fn quiet_scene_with_small_motion_is_not_frozen() {
        let mut p = Picture::new();
        let a = frame(0);
        let mut b = a.clone();
        // A small moving element: ~3% of the samples change a lot.
        for v in b.iter_mut().take(70) {
            *v = v.wrapping_add(120);
        }
        p.push(&a);
        p.push(&b);
        assert_eq!(p.state.still_secs, 0);
    }
}
