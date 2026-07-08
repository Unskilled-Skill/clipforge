//! Heuristic game detection: the foreground window covers an entire
//! monitor and its process is not a known non-game. Catches games that
//! are missing from the user's exe list.

use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
};

/// Processes that go fullscreen but are never games.
const BLOCKLIST: &[&str] = &[
    "explorer.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vlc.exe",
    "mpc-hc64.exe",
    "obs64.exe",
    "clipforge.exe",
    "code.exe",
    "devenv.exe",
    "powerpnt.exe",
    "vrmonitor.exe",
    "searchhost.exe",
    "lockapp.exe",
    // launchers/storefronts that go fullscreen but are not games
    "steamwebhelper.exe",
    "steam.exe",
    "epicgameslauncher.exe",
    "battle.net.exe",
    "riotclientux.exe",
    "playnite.fullscreenapp.exe",
    "gamingservicesui.exe",
    "xboxpcapp.exe",
];

/// Returns the exe name of the foreground app if it looks like a game.
pub fn fullscreen_game() -> Option<String> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }

        let mut win_rect = RECT::default();
        GetWindowRect(hwnd, &mut win_rect).ok()?;

        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let mon = info.rcMonitor;

        // Window must cover the whole monitor (fullscreen or borderless).
        if win_rect.left > mon.left
            || win_rect.top > mon.top
            || win_rect.right < mon.right
            || win_rect.bottom < mon.bottom
        {
            return None;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let len = GetModuleBaseNameW(handle, None, &mut buf) as usize;
        let _ = CloseHandle(handle);
        if len == 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&buf[..len]).to_lowercase();

        if BLOCKLIST.contains(&name.as_str()) {
            return None;
        }
        Some(name)
    }
}
