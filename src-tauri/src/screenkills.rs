//! Valorant kill detection from the screen. Valorant exposes no local kill
//! events (Medal only gets them after the match, from Riot's servers), but
//! every kill shows a banner at the bottom centre: the weapon skin's emblem
//! inside a thin circle, ringed by one coloured arc per kill this round.
//! The emblem changes with the skin; the circle doesn't. So we watch that
//! patch of the screen a few times a second and look for the circle.
//!
//! Reading the screen is the same Desktop Duplication capture OBS's display
//! capture uses: nothing touches the game process, and nothing sends input.
//! Calibrated on real clips (see `testdata/valorant`).

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const VALORANT_EXE: &str = "valorant-win64-shipping.exe";

/// Frames analysed per second while Valorant is focused.
const FPS: u64 = 5;
/// Region side, centre height above the bottom edge, at 1080p (scales with
/// the HUD: min(width/1920, height/1080)).
const REGION: f32 = 240.0;
const CENTRE_FROM_BOTTOM: f32 = 216.0;
/// Circle radius range across skins: pentagon frames ~48, the default
/// ~55-65, the largest skin frames ~80.
const RADIUS: (f32, f32) = (44.0, 88.0);
/// Banner present at or above this score; gone below `OFF` for `OFF_FRAMES`.
/// Real banners score 0.9-1.0, gameplay ~0.05 (99th percentile < 0.35).
const ON: f32 = 0.6;
const OFF: f32 = 0.35;
const OFF_FRAMES: u32 = 3;
/// Bright, saturated pixels one more kill arc adds, at 1080p (an arc is
/// ~440 px; half that rides out glow and fade-in).
const ARC_PIXELS: f32 = 220.0;
/// Arc growth this soon after a counted kill is that kill's arc fading in.
const SETTLE_ARCS: Duration = Duration::from_millis(1700);

// ---- Detection --------------------------------------------------------

/// Angles sampled around a candidate circle.
const ANGLES: usize = 96;
/// Rough-pass score below which a frame can't hold a banner. Gameplay
/// scores ~0.05, banners 0.9+.
const GATE: f32 = 0.35;

fn unit_circle() -> &'static [(f32, f32); ANGLES] {
    static TABLE: std::sync::OnceLock<[(f32, f32); ANGLES]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| std::array::from_fn(|i| (i as f32 * std::f32::consts::TAU / ANGLES as f32).sin_cos()))
}

/// Fraction of angles where the circle at radius `r` around (cx, cy) is
/// brighter than `d` pixels inside and outside it: a thin light ring.
/// `step` > 1 samples every step-th angle (rough pass).
fn ring_score(gray: &[u8], side: usize, cx: f32, cy: f32, r: f32, d: f32, step: usize) -> f32 {
    let last = side as isize - 1;
    let px = |x: f32, y: f32| -> i16 {
        let x = (x.round() as isize).clamp(0, last) as usize;
        let y = (y.round() as isize).clamp(0, last) as usize;
        gray[y * side + x] as i16
    };
    let (mut hits, mut total) = (0, 0);
    for &(sin, cos) in unit_circle().iter().step_by(step) {
        let at = |rr: f32| px(cx + rr * cos, cy + rr * sin);
        let on = at(r).max(at(r - 1.0)).max(at(r + 1.0));
        let off = at(r - d).max(at(r + d));
        hits += (on - off > 10) as u32;
        total += 1;
    }
    hits as f32 / total as f32
}

/// Best ring near the centre of a square grayscale region: (score, cx, cy,
/// r). `s` is the HUD scale (1.0 at 1080p). A rough pass (every other
/// centre, a quarter of the angles) rules out ordinary frames; only a
/// likely banner gets the full search around the rough hit.
fn find_ring(gray: &[u8], side: usize, s: f32) -> (f32, f32, f32, f32) {
    let c = side as f32 / 2.0;
    let slack = (3.0 * s).ceil() as i32;
    let d = (4.0 * s).max(3.0);
    let (r_min, r_max) = ((RADIUS.0 * s).floor() as i32, (RADIUS.1 * s).ceil() as i32);
    let search = |centres: &[(f32, f32)], radii: std::ops::RangeInclusive<i32>, step: usize| {
        let mut best = (0.0, c, c, 0.0);
        for &(cx, cy) in centres {
            for r in radii.clone() {
                let score = ring_score(gray, side, cx, cy, r as f32, d, step);
                if score > best.0 {
                    best = (score, cx, cy, r as f32);
                }
            }
        }
        best
    };
    let rough_centres: Vec<(f32, f32)> = (-slack..=slack)
        .step_by(2)
        .flat_map(|dx| (-slack..=slack).step_by(2).map(move |dy| (c + dx as f32, c + dy as f32)))
        .collect();
    let rough = search(&rough_centres, r_min..=r_max, 4);
    if rough.0 < GATE {
        return rough;
    }
    let near: Vec<(f32, f32)> = (-1..=1)
        .flat_map(|dx| (-1..=1).map(move |dy| (rough.1 + dx as f32, rough.2 + dy as f32)))
        .collect();
    let r = rough.3 as i32;
    search(&near, (r - 2).max(r_min)..=(r + 2).min(r_max), 1)
}

/// Find the banner circle in a full-resolution grayscale region. Works on
/// a box-downscaled copy near half of 1080p scale, so the cost is the same
/// at 1080p, 1440p and 4K. Returns full-resolution coordinates.
fn analyse(gray: &[u8], side: usize, s: f32) -> (f32, f32, f32, f32) {
    let k = ((s / 0.5).round() as usize).max(1);
    if k == 1 {
        return find_ring(gray, side, s);
    }
    let small_side = side / k;
    let mut small = vec![0u8; small_side * small_side];
    for y in 0..small_side {
        for x in 0..small_side {
            let mut sum = 0u32;
            for yy in 0..k {
                let row = (y * k + yy) * side + x * k;
                sum += gray[row..row + k].iter().map(|&v| v as u32).sum::<u32>();
            }
            small[y * small_side + x] = (sum / (k * k) as u32) as u8;
        }
    }
    let (score, cx, cy, r) = find_ring(&small, small_side, s / k as f32);
    let kf = k as f32;
    let back = |v: f32| v * kf + (kf - 1.0) / 2.0;
    (score, back(cx), back(cy), r * kf)
}

/// Bright, saturated pixels just outside the circle, where the per-kill
/// arcs sit. Arc colour follows the skin, so any vivid colour counts.
fn arc_pixels(bgra: &[u8], side: usize, cx: f32, cy: f32, r: f32, s: f32) -> usize {
    let (inner, outer) = ((r + 6.0 * s).powi(2), (r + 24.0 * s).powi(2));
    let mut count = 0;
    for y in 0..side {
        for x in 0..side {
            let d2 = (x as f32 - cx).powi(2) + (y as f32 - cy).powi(2);
            if d2 < inner || d2 > outer {
                continue;
            }
            let p = &bgra[(y * side + x) * 4..][..3];
            let (max, min) = (p.iter().max().copied().unwrap_or(0), p.iter().min().copied().unwrap_or(0));
            if max > 150 && max - min > 80 {
                count += 1;
            }
        }
    }
    count
}

fn to_gray(bgra: &[u8]) -> Vec<u8> {
    bgra.chunks_exact(4)
        .map(|p| ((p[2] as u32 * 77 + p[1] as u32 * 150 + p[0] as u32 * 29) >> 8) as u8)
        .collect()
}

/// Turns per-frame banner readings into kills: the banner appearing is a
/// kill, and so is a new arc while it's still up (quick multikills keep
/// one banner on screen).
#[derive(Default)]
struct Tracker {
    showing: bool,
    off_frames: u32,
    arcs_seen: usize,
    last_kill: Option<Instant>,
}

impl Tracker {
    fn update(&mut self, score: f32, arcs: usize, s: f32, now: Instant) -> bool {
        if !self.showing {
            if score >= ON {
                self.showing = true;
                self.off_frames = 0;
                self.arcs_seen = arcs;
                self.last_kill = Some(now);
                return true;
            }
            return false;
        }
        if score < OFF {
            self.off_frames += 1;
            if self.off_frames >= OFF_FRAMES {
                self.showing = false;
            }
            return false;
        }
        self.off_frames = 0;
        // The arcs keep growing for up to ~1.6 s after a kill as they fade
        // in, and read as extra kills (8 of 36 on 2026-10-26, checked against
        // Riot's match record). Only growth after that counts; a real second
        // kill sooner is rare, and the post-match check (valmatch.rs) puts it back.
        let settled = self.last_kill.is_none_or(|t| now.duration_since(t) > SETTLE_ARCS);
        if score >= ON && arcs as f32 > self.arcs_seen as f32 + ARC_PIXELS * s * s && settled {
            self.arcs_seen = arcs;
            self.last_kill = Some(now);
            return true;
        }
        self.arcs_seen = self.arcs_seen.max(arcs);
        false
    }
}

// ---- Screen capture (DXGI Desktop Duplication) --------------------------

mod capture {
    use windows::core::Interface;
    use windows::Win32::Foundation::{HMODULE, RECT};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
        D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1, IDXGIOutput5, IDXGIOutputDuplication,
        IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    };
    use windows::Win32::Graphics::Gdi::HMONITOR;

    pub struct Capture {
        pub monitor: HMONITOR,
        /// The output's rectangle on the virtual desktop.
        pub bounds: RECT,
        device: ID3D11Device,
        ctx: ID3D11DeviceContext,
        dup: IDXGIOutputDuplication,
        staging: Option<(ID3D11Texture2D, u32)>,
    }

    pub enum Grab {
        Frame(Vec<u8>),
        /// Nothing new on screen since the last frame.
        Unchanged,
        /// Duplication lost (mode change, secure desktop): reopen.
        Lost,
    }

    impl Capture {
        /// Duplicate the DXGI output showing `monitor`.
        pub fn open(monitor: HMONITOR) -> Option<Capture> {
            unsafe {
                let factory = CreateDXGIFactory1::<IDXGIFactory1>().ok()?;
                let mut a = 0;
                while let Ok(adapter) = factory.EnumAdapters1(a) {
                    a += 1;
                    let mut o = 0;
                    while let Ok(output) = adapter.EnumOutputs(o) {
                        o += 1;
                        let Ok(desc) = output.GetDesc() else { continue };
                        if desc.Monitor != monitor {
                            continue;
                        }
                        let mut device = None;
                        let mut ctx = None;
                        D3D11CreateDevice(
                            &adapter.cast::<IDXGIAdapter>().ok()?,
                            D3D_DRIVER_TYPE_UNKNOWN,
                            HMODULE::default(),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            None,
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            None,
                            Some(&mut ctx),
                        )
                        .ok()?;
                        let (device, ctx) = (device?, ctx?);
                        // DuplicateOutput1 converts HDR desktops to 8-bit;
                        // plain DuplicateOutput refuses them.
                        let dup = output
                            .cast::<IDXGIOutput5>()
                            .ok()
                            .and_then(|o5| o5.DuplicateOutput1(&device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]).ok())
                            .or_else(|| output.cast::<IDXGIOutput1>().ok()?.DuplicateOutput(&device).ok())?;
                        return Some(Capture {
                            monitor,
                            bounds: desc.DesktopCoordinates,
                            device,
                            ctx,
                            dup,
                            staging: None,
                        });
                    }
                }
                None
            }
        }

        /// BGRA pixels of the `side`×`side` square at (x, y), in output
        /// coordinates, from the newest desktop frame.
        pub fn grab(&mut self, x: u32, y: u32, side: u32) -> Grab {
            unsafe {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;
                match self.dup.AcquireNextFrame(40, &mut info, &mut resource) {
                    Ok(()) => {}
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Grab::Unchanged,
                    Err(_) => return Grab::Lost,
                }
                let pixels = resource
                    .and_then(|r| r.cast::<ID3D11Texture2D>().ok())
                    .and_then(|frame| self.copy_region(&frame, x, y, side));
                let _ = self.dup.ReleaseFrame();
                match pixels {
                    Some(p) => Grab::Frame(p),
                    None => Grab::Lost,
                }
            }
        }

        unsafe fn copy_region(&mut self, frame: &ID3D11Texture2D, x: u32, y: u32, side: u32) -> Option<Vec<u8>> {
            if self.staging.as_ref().is_none_or(|(_, s)| *s != side) {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: side,
                    Height: side,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut tex = None;
                self.device.CreateTexture2D(&desc, None, Some(&mut tex)).ok()?;
                self.staging = Some((tex?, side));
            }
            let (staging, _) = self.staging.as_ref()?;
            let region = D3D11_BOX { left: x, top: y, front: 0, right: x + side, bottom: y + side, back: 1 };
            self.ctx.CopySubresourceRegion(staging, 0, 0, 0, 0, frame, 0, Some(&region));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ok()?;
            let row = side as usize * 4;
            let mut out = Vec::with_capacity(row * side as usize);
            for line in 0..side as usize {
                let src = (mapped.pData as *const u8).add(line * mapped.RowPitch as usize);
                out.extend_from_slice(std::slice::from_raw_parts(src, row));
            }
            self.ctx.Unmap(staging, 0);
            Some(out)
        }
    }
}

// ---- Rounds -------------------------------------------------------------

/// Lines Valorant's own log writes when a round (or the match) is over.
/// `OnRoundEnded` lands as the next buy phase starts, so exit kills in the
/// post-round still count toward the round that just ended.
fn has_round_end(text: &str) -> bool {
    text.contains("OnRoundEnded for round") || text.contains("LogShooterGameState: Match Ended")
}

/// Kills shortly after a camera line still count: a round you win writes
/// one as the last enemy dies, a moment before your banner is seen.
const DEAD_GRACE_S: f64 = 1.5;
/// Camera lines this soon after a round end or map load are the game
/// settling the view, not a death.
const SETTLE_S: f64 = 12.0;

/// Map names as players know them (the log uses code names).
fn map_name(code: &str) -> &str {
    match code {
        "Ascent" => "Ascent",
        "Bonsai" => "Split",
        "Canyon" => "Fracture",
        "Duality" => "Bind",
        "Foxtrot" => "Breeze",
        "Infinity" => "Abyss",
        "Jam" => "Lotus",
        "Juliett" => "Sunset",
        "Pitt" => "Pearl",
        "Port" => "Icebox",
        "Triad" => "Haven",
        "Rook" => "Corrode",
        other => other,
    }
}

/// Seconds since the Unix epoch of a log line's "[2026.10.26-20.32.29:187]"
/// stamp (UTC).
pub fn line_time(line: &str) -> Option<f64> {
    if !line.starts_with('[') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| line.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(1..5)?, n(6..8)?, n(9..11)?);
    let (h, mi, sec, ms) = (n(12..14)?, n(15..17)?, n(18..20)?, n(21..24)?);
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some((days * 86400 + h * 3600 + mi * 60 + sec) as f64 + ms as f64 / 1000.0)
}

fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Kills this round, reset by round-end lines in ShooterGame.log, plus what
/// the log says about whether a banner on screen can be ours: none in
/// menus or agent select, and none once we're dead and spectating (the
/// spectated teammate's banners look exactly like ours).
struct Round {
    kills: u32,
    first: Option<Instant>,
    /// Log read position; None until the log is found.
    offset: Option<u64>,
    /// In a game world (not the menu or agent select).
    in_world: bool,
    /// A mode with rounds you sit out after dying (not Deathmatch or the Range).
    rounds: bool,
    /// Camera lines before this are the view settling.
    settle_until: f64,
    /// This round's start (the first camera line after the buy phase) seen.
    started: bool,
    /// When a later camera line said we died (or the round was decided).
    dead_at: Option<f64>,
    /// The match ended since the last check (its record can be fetched).
    match_ended: bool,
    /// The match being played, for the match tracker: (id, map, mode, round).
    match_id: Option<String>,
    map: Option<String>,
    mode: Option<String>,
    round_no: u32,
}

impl Default for Round {
    fn default() -> Self {
        Round {
            kills: 0,
            first: None,
            offset: None,
            in_world: true,
            rounds: true,
            settle_until: 0.0,
            started: false,
            dead_at: None,
            match_ended: false,
            match_id: None,
            map: None,
            mode: None,
            round_no: 0,
        }
    }
}

impl Round {
    fn log_path() -> Option<std::path::PathBuf> {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(std::path::Path::new(&local).join("VALORANT/Saved/Logs/ShooterGame.log"))
    }

    /// Whether a round ended since the last call. Starts at the end of the
    /// log: earlier rounds are history.
    fn poll_log(&mut self) -> bool {
        use std::io::{Read, Seek, SeekFrom};
        let Some(path) = Self::log_path() else { return false };
        let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) else {
            self.offset = None;
            return false;
        };
        let from = match self.offset {
            None => {
                self.offset = Some(size);
                return false;
            }
            Some(o) if o > size => 0, // new game session, fresh log
            Some(o) => o,
        };
        if from == size {
            return false;
        }
        let mut text = String::new();
        if let Ok(mut file) = std::fs::File::open(&path) {
            if file.seek(SeekFrom::Start(from)).is_ok() {
                let _ = file.take(4 << 20).read_to_string(&mut text);
            }
        }
        self.offset = Some(size);
        self.read(&text)
    }

    /// Follow new log lines; true when a round ended among them.
    fn read(&mut self, text: &str) -> bool {
        let mut ended = false;
        for line in text.lines() {
            let Some(t) = line_time(line) else { continue };
            if has_round_end(line) {
                ended = true;
                self.new_round(t);
                self.round_no += 1;
                if line.contains("Match Ended") {
                    self.match_ended = true;
                    self.match_id = None;
                }
            } else if let Some(i) = line.find("Match Load Times] MatchId: ") {
                let rest = &line[i + 27..];
                self.match_id = Some(rest.chars().take_while(|c| c.is_ascii_hexdigit() || *c == '-').collect());
            } else if line.contains("LogMapLoadModel: Update:") {
                let world = line.contains("[Local World: TRUE");
                if world && !self.in_world {
                    self.new_round(t);
                    self.round_no = 0;
                    let field = |m: &str| line.find(m).map(|i| line[i + m.len()..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>());
                    self.map = field("[Map Name: ").map(|m| map_name(&m).to_string());
                    self.mode = field("/GameModes/");
                }
                self.in_world = world;
                if world && line.contains("/GameModes/") {
                    self.rounds = !["Deathmatch", "ShootingRange", "HURM", "GunGame"].iter().any(|m| line.contains(m));
                }
            } else if line.contains("UpdateMapReady") {
                if t < self.settle_until {
                    self.settle_until = t + SETTLE_S;
                } else if !self.started {
                    self.started = true;
                } else if self.dead_at.is_none() {
                    self.dead_at = Some(t);
                }
            }
        }
        ended
    }

    fn new_round(&mut self, t: f64) {
        self.started = false;
        self.dead_at = None;
        self.settle_until = t + SETTLE_S;
    }

    /// What the match tracker should know right now.
    fn match_update(&self) -> crate::matchdata::Update {
        crate::matchdata::Update {
            external_id: self.match_id.clone(),
            map: self.map.clone(),
            mode: self.mode.clone(),
            round: (self.rounds && self.match_id.is_some()).then_some(self.round_no + 1),
            active: self.in_world && self.match_id.is_some(),
            ..Default::default()
        }
    }

    /// Why a banner seen at `now` can't be our kill, if it can't.
    fn not_ours(&self, now: f64) -> Option<&'static str> {
        if !self.in_world {
            Some("not in a match")
        } else if self.rounds && self.dead_at.is_some_and(|d| now - d > DEAD_GRACE_S) {
            Some("dead, spectating")
        } else {
            None
        }
    }

    fn log_found(&self) -> bool {
        self.offset.is_some()
    }
}

// ---- Loop -------------------------------------------------------------

/// Where the banner region sits for the focused Valorant window: monitor,
/// the square's top-left in that monitor's output coordinates, its side,
/// and the HUD scale. None when Valorant isn't the focused window.
fn banner_region(cap_bounds: impl FnOnce(windows::Win32::Graphics::Gdi::HMONITOR) -> Option<windows::Win32::Foundation::RECT>)
    -> Option<(windows::Win32::Graphics::Gdi::HMONITOR, u32, u32, u32, f32)> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{ClientToScreen, MonitorFromWindow, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetForegroundWindow};

    if crate::fullscreen::foreground_exe().as_deref() != Some(VALORANT_EXE) {
        return None;
    }
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client).ok()?;
        let mut origin = POINT::default();
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        let (w, h) = (client.right as f32, client.bottom as f32);
        if w < 640.0 || h < 360.0 {
            return None; // minimised or still starting
        }
        let s = (w / 1920.0).min(h / 1080.0);
        let side = (REGION * s).round() as i32;
        let cx = origin.x + (w / 2.0) as i32;
        let cy = origin.y + (h - CENTRE_FROM_BOTTOM * s) as i32;
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let bounds = cap_bounds(monitor)?;
        let (x, y) = (cx - side / 2 - bounds.left, cy - side / 2 - bounds.top);
        let fits = x >= 0 && y >= 0 && x + side <= bounds.right - bounds.left && y + side <= bounds.bottom - bounds.top;
        fits.then_some((monitor, x as u32, y as u32, side as u32, s))
    }
}

/// While Valorant is focused and auto-clip is on, watch for kill banners
/// and count kills per round. With "every kill" each kill feeds the
/// auto-clip event window; with a minimum of N kills, a round that reaches
/// N is saved as one clip when it ends.
pub fn run(app: AppHandle) {
    std::thread::spawn(move || {
        let mut capture: Option<capture::Capture> = None;
        let mut tracker = Tracker::default();
        let mut round = Round::default();
        let mut enabled = false;
        let mut game_exe = String::new();
        let mut min_kills = 1;
        let mut checked = Instant::now() - Duration::from_secs(10);
        let mut log_checked = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(1000 / FPS));
            // Settings live on disk; re-read every couple of seconds.
            if checked.elapsed() > Duration::from_secs(2) {
                checked = Instant::now();
                let game = app.state::<crate::obs::CurrentGame>().0.lock().ok().and_then(|g| g.clone());
                let settings = crate::clips::load_settings_inner(&app);
                let rule = settings.clip_rule("valorant");
                enabled = rule.enabled && game.as_ref().is_some_and(|g| g.eq_ignore_ascii_case(VALORANT_EXE));
                if let Some(g) = game {
                    game_exe = g;
                }
                min_kills = rule.min_kills;
            }
            if !enabled {
                capture = None;
                tracker = Tracker::default();
                round = Round::default();
                continue;
            }
            // Rounds end while alt-tabbed too, so the log is read first.
            if log_checked.elapsed() > Duration::from_secs(1) {
                log_checked = Instant::now();
                if round.poll_log() {
                    if let Some(first) = round.first.filter(|_| min_kills > 1 && round.kills >= min_kills) {
                        crate::autoclip::save_round(&app, first, round.kills);
                    }
                    round.kills = 0;
                    round.first = None;
                }
                if round.log_found() {
                    crate::matchdata::ingest(&app, &game_exe, "valorant-log", round.match_update());
                }
                if std::mem::take(&mut round.match_ended) {
                    crate::valmatch::match_ended(&app, game_exe.clone());
                }
            }
            let region = banner_region(|monitor| {
                if capture.as_ref().is_none_or(|c| c.monitor != monitor) {
                    capture = capture::Capture::open(monitor);
                }
                capture.as_ref().map(|c| c.bounds)
            });
            let Some((_, x, y, side, s)) = region else {
                tracker = Tracker::default(); // alt-tabbed: a banner can't carry over
                continue;
            };
            let Some(cap) = capture.as_mut() else { continue };
            let bgra = match cap.grab(x, y, side) {
                capture::Grab::Frame(p) => p,
                capture::Grab::Unchanged => continue,
                capture::Grab::Lost => {
                    capture = None;
                    continue;
                }
            };
            let gray = to_gray(&bgra);
            let (score, cx, cy, r) = analyse(&gray, side as usize, s);
            let arcs = if score >= ON { arc_pixels(&bgra, side as usize, cx, cy, r, s) } else { 0 };
            let now = Instant::now();
            if tracker.update(score, arcs, s, now) {
                if let Some(why) = round.not_ours(now_secs()) {
                    crate::logs::line(&format!("auto-clip: valorant banner ignored ({why})"));
                    continue;
                }
                round.kills += 1;
                round.first.get_or_insert(now);
                crate::logs::line(&format!(
                    "auto-clip: valorant kill {} this round (screen, ring {score:.2})",
                    round.kills
                ));
                if min_kills == 1 {
                    crate::autoclip::schedule_counted(&app, round.kills, 1);
                } else if round.log_found() {
                    crate::autoclip::record_kill(); // timeline marker; the round decides the clip
                } else {
                    // No log, so no round boundaries: fall back to kills
                    // close together, filtered by the same minimum.
                    crate::autoclip::schedule_counted(&app, round.kills, min_kills);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(name: &str) -> f32 {
        let path = format!("{}/testdata/valorant/{name}.gray", env!("CARGO_MANIFEST_DIR"));
        let gray = std::fs::read(path).unwrap();
        analyse(&gray, 200, 1.0).0
    }

    #[test]
    fn finds_banners_across_skins() {
        for name in ["banner_default", "banner_cowboy", "banner_horned", "banner_dragon", "banner_pentagon"] {
            let s = score(name);
            assert!(s >= ON, "{name} scored {s}");
        }
    }

    /// 38 skin banners from Valorant's collection screen, 76×76 each at
    /// roughly 0.38× the in-game size.
    #[test]
    fn finds_every_skin_banner_in_the_collection() {
        let path = format!("{}/testdata/valorant/skin_sheet.gray", env!("CARGO_MANIFEST_DIR"));
        let sheet = std::fs::read(path).unwrap();
        let missed: Vec<(usize, f32)> = sheet
            .chunks_exact(76 * 76)
            .map(|icon| find_ring(icon, 76, 0.38).0)
            .enumerate()
            .filter(|(_, s)| *s < ON)
            .collect();
        assert!(missed.is_empty(), "missed banners (index, score): {missed:?}");
    }

    #[test]
    fn ignores_gameplay_and_abilities() {
        for name in ["none_ability", "none_play0", "none_play1", "none_play2", "none_play3"] {
            let s = score(name);
            assert!(s < OFF, "{name} scored {s}");
        }
    }

    /// Replays raw 240×240 grayscale frames (5 fps, 1080p) from every
    /// `*.raw` in `CLIPFORGE_KILL_FRAMES` through the detector and tracker,
    /// printing the kill times.
    #[test]
    #[ignore]
    fn replay_clip_frames() {
        let Ok(dir) = std::env::var("CLIPFORGE_KILL_FRAMES") else { return };
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        for path in files.iter().filter(|p| p.extension().is_some_and(|e| e == "raw")) {
            let raw = std::fs::read(path).unwrap();
            let mut tracker = Tracker::default();
            let t0 = Instant::now();
            let mut kills = Vec::new();
            for (i, frame) in raw.chunks_exact(240 * 240).enumerate() {
                let (score, ..) = analyse(frame, 240, 1.0);
                if tracker.update(score, 0, 1.0, t0 + Duration::from_millis(i as u64 * 200)) {
                    kills.push(format!("{:.1}", i as f32 / 5.0));
                }
            }
            println!("{}: kills at {:?}", path.file_stem().unwrap().to_string_lossy(), kills);
        }
    }

    /// `cargo test --release --lib screenkills::tests::bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench() {
        for (fixture, label, s) in [("none_play0", "1080p", 1.0f32), ("none_play0", "1440p", 1.333), ("none_play0", "4K", 2.0), ("banner_default", "1080p banner", 1.0), ("banner_default", "4K banner", 2.0)] {
            let path = format!("{}/testdata/valorant/{fixture}.gray", env!("CARGO_MANIFEST_DIR"));
            let small = std::fs::read(path).unwrap();
            // Upscale the 1080p fixture to the target size (nearest neighbour).
            let src = |x: usize, y: usize| small[((y as f32 / s) as usize).min(199) * 200 + ((x as f32 / s) as usize).min(199)];
            let side = (REGION * s).round() as usize;
            let off = ((side as f32 - 200.0 * s) / 2.0).max(0.0) as usize;
            let gray: Vec<u8> = (0..side * side).map(|i| src((i % side).saturating_sub(off), (i / side).saturating_sub(off))).collect();
            let bgra: Vec<u8> = gray.iter().flat_map(|&g| [g, g, g, 255]).collect();
            let runs = 50;
            let t = Instant::now();
            let mut found = 0.0;
            for _ in 0..runs {
                found = std::hint::black_box(analyse(&to_gray(&bgra), side, s)).0;
            }
            let per = t.elapsed() / runs;
            println!("{label}: score {found:.2}");
            println!("{label}: {per:?} per frame, {:.2}% of one core at {FPS} fps", per.as_secs_f64() * FPS as f64 * 100.0);
        }
    }

    #[test]
    fn round_end_lines() {
        assert!(has_round_end("[2026.10.24-17.52.54:989][537]LogShooterGameState: Warning: AShooterGameState::OnRoundEnded for round '0'"));
        assert!(has_round_end("[2026.10.24-18.30.00:000][  1]LogShooterGameState: Match Ended: Completion State: 'Completed'"));
        assert!(!has_round_end("[2026.10.24-17.52.55:205][576]LogShooterGameState: Warning: Gameplay started at local time 0.039062"));
    }

    #[test]
    fn log_stamps_are_utc_seconds() {
        assert_eq!(line_time("[1970.01.01-00.00.01:500][  0]x"), Some(1.5));
        assert_eq!(line_time("[2026.10.26-20.32.29:187][177]x"), Some(1_793_046_749.187));
        assert_eq!(line_time("no stamp"), None);
    }

    /// Lines as a real match (2026-10-26) wrote them: agent select, map
    /// load, round 0 starting, a death, then the round end.
    #[test]
    fn log_tracks_menus_and_deaths() {
        let at = |hms: &str| line_time(&format!("[2026.10.26-{hms}:000][0]")).unwrap();
        let cam = |hms: &str| format!("[2026.10.26-{hms}:000][0]LogMapLoadModel: Display: UpdateMapReady: [PlayerCharacterLoaded: TRUE]\n");
        let map = |hms: &str, name: &str, world: &str, url: &str| {
            format!("[2026.10.26-{hms}:000][0]LogMapLoadModel: Update: [Map Name: {name} | Changed: TRUE] [Local World: {world} | Changed: TRUE] [URL: {url}]\n")
        };
        let mut r = Round::default();
        r.read(&map("20.29.41", "CharacterSelectPersistentLevel", "FALSE", ""));
        assert_eq!(r.not_ours(at("20.30.09")), Some("not in a match"));
        let load = map("20.31.23", "Juliett", "TRUE", "1.2.3.4:7000/Game/Maps/Juliett?Game=/Game/GameModes/Bomb/BombGameMode.BombGameMode_C");
        let text = [load, cam("20.31.24"), cam("20.31.32"), cam("20.31.33"), cam("20.32.17")].concat();
        assert!(!r.read(&text));
        assert_eq!(r.not_ours(at("20.32.20")), None, "round started, alive");
        r.read(&cam("20.32.29"));
        assert_eq!(r.not_ours(at("20.32.30")), None, "a winning kill lands just after the line");
        assert_eq!(r.not_ours(at("20.32.53")), Some("dead, spectating"));
        assert!(r.read("[2026.10.26-20.33.14:212][978]LogShooterGameState: Warning: AShooterGameState::OnRoundEnded for round '0'\n"));
        r.read(&cam("20.33.14"));
        assert_eq!(r.not_ours(at("20.33.20")), None, "new round, alive again");

        // Deathmatch respawns: deaths don't stop counting.
        let mut dm = Round::default();
        let text = [map("19.00.00", "Ascent", "TRUE", "x?Game=/Game/GameModes/Deathmatch/DeathmatchGameMode"), cam("19.00.30"), cam("19.01.00")].concat();
        dm.read(&text);
        assert_eq!(dm.not_ours(at("19.01.30")), None);
    }

    /// Replays a real ShooterGame.log and prints what each moment reads as.
    /// `CLIPFORGE_VALORANT_LOG=... cargo test --lib screenkills::tests::replay_log -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn replay_log() {
        let path = std::env::var("CLIPFORGE_VALORANT_LOG").expect("set CLIPFORGE_VALORANT_LOG");
        let text = String::from_utf8_lossy(&std::fs::read(path).unwrap()).into_owned();
        let times: Vec<f64> = std::env::var("CLIPFORGE_KILL_TIMES").unwrap_or_default().split(',').filter_map(|t| t.trim().parse().ok()).collect();
        let mut r = Round::default();
        let mut lines = text.lines().peekable();
        for t in times {
            let mut chunk = String::new();
            while let Some(l) = lines.peek() {
                if line_time(l).is_some_and(|lt| lt > t) {
                    break;
                }
                chunk.push_str(lines.next().unwrap());
                chunk.push('\n');
            }
            r.read(&chunk);
            println!("{t:.1} {}", r.not_ours(t).unwrap_or("ours"));
        }
    }

    #[test]
    fn tracker_counts_banners_and_new_arcs() {
        let mut t = Tracker::default();
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        assert!(t.update(0.95, 400, 1.0, at(0)), "banner appears");
        assert!(!t.update(0.95, 500, 1.0, at(200)), "same banner, arc still fading in");
        assert!(!t.update(0.3, 0, 1.0, at(400)), "animation dip isn't a new banner");
        assert!(!t.update(0.95, 500, 1.0, at(600)));
        assert!(!t.update(0.95, 950, 1.0, at(1200)), "growth 1.2 s after a kill is its own arc fading in");
        assert!(t.update(0.95, 1450, 1.0, at(2000)), "growth after that = second kill");
        for ms in [2200, 2400, 2600] {
            assert!(!t.update(0.05, 0, 1.0, at(ms)));
        }
        assert!(t.update(0.9, 400, 1.0, at(5000)), "next banner after it went away");
    }
}
