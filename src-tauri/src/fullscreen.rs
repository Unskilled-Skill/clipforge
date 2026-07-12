//! Heuristic game detection: the foreground window covers an entire
//! monitor and its process is not a known non-game. Catches games that
//! are missing from the user's exe list.

use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible,
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

struct WindowSearch {
    target_pid: u32,
    found: Option<(String, String)>,
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam.0 as *mut WindowSearch);

    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != search.target_pid {
        return true.into();
    }

    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    if title_len == 0 {
        // Same process can own several windows (invisible helper windows,
        // tooltips); keep looking for one with an actual title.
        return true.into();
    }
    let mut class_buf = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_buf);

    search.found = Some((
        String::from_utf16_lossy(&title_buf[..title_len as usize]),
        String::from_utf16_lossy(&class_buf[..class_len.max(0) as usize]),
    ));
    false.into()
}

struct AppList {
    /// (hwnd pid, window title) for every visible titled top-level window.
    windows: Vec<(u32, String)>,
}

unsafe extern "system" fn enum_all_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut AppList);
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    if title_len == 0 {
        return true.into();
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return true.into();
    }
    list.windows.push((
        pid,
        String::from_utf16_lossy(&title_buf[..title_len as usize]),
    ));
    true.into()
}

/// A running app the user could pick as a game to watch.
pub struct RunningApp {
    pub exe: String,
    pub title: String,
}

/// Every currently-running app that owns a visible, titled window — for a
/// "pick from what's running" list, so the user doesn't have to hunt down an
/// exe in Program Files. Deduped by exe, obvious non-games filtered out.
pub fn running_windowed_apps() -> Vec<RunningApp> {
    let mut list = AppList { windows: Vec::new() };
    unsafe {
        let _ = EnumWindows(
            Some(enum_all_windows_proc),
            LPARAM(&mut list as *mut AppList as isize),
        );
    }

    let mut system = sysinfo::System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut out: Vec<RunningApp> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (pid, title) in list.windows {
        let Some(proc) = system.process(sysinfo::Pid::from_u32(pid)) else {
            continue;
        };
        let exe = proc.name().to_string_lossy().to_lowercase();
        if BLOCKLIST.contains(&exe.as_str()) || exe == "clipforge.exe" {
            continue;
        }
        if !seen.insert(exe.clone()) {
            continue;
        }
        out.push(RunningApp { exe, title });
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    out
}

/// Find the main visible window of a running process, for OBS's
/// `"title:class:executable"` window-capture selector format. Requires the
/// process to actually be running (needs a live window to point OBS at).
pub fn find_window_for_exe(exe: &str) -> Option<(String, String)> {
    let target = exe.to_lowercase();
    let mut system = sysinfo::System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let pid = system
        .processes()
        .values()
        .find(|p| p.name().to_string_lossy().to_lowercase() == target)?
        .pid()
        .as_u32();

    let mut search = WindowSearch {
        target_pid: pid,
        found: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut search as *mut WindowSearch as isize),
        );
    }
    search.found
}
