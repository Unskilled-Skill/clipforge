//! Optional "run with admin rights": libobs gets GPU priority (fewer dropped
//! frames when the game maxes the GPU) and can hook games whose anti-cheat
//! blocks a non-elevated capture.
//!
//! A per-user scheduled task with "highest privileges" starts ClipForge
//! elevated without a UAC prompt. Creating or deleting it needs one prompt.
//! Every normal launch (Start menu, login autostart, updater restart) hands
//! off to the task when the setting is on, passing its arguments through a
//! file because a task's arguments are fixed.

use std::path::PathBuf;

const TASK: &str = "ClipForge (admin)";
/// Marks a launch that came from the task, so it never hands off again.
const FROM_TASK: &str = "--from-task";

fn config_dir() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("com.roche.clipforge"))
}

fn handoff_args_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("elevated-launch-args.txt"))
}

pub fn is_elevated() -> bool {
    unsafe { windows::Win32::UI::Shell::IsUserAnAdmin().as_bool() }
}

fn hidden(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn task_exists() -> bool {
    hidden("schtasks")
        .args(["/query", "/tn", TASK])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// The `run_elevated` setting, read straight from settings.json: this runs
/// before Tauri (and its app handle) exists.
#[cfg_attr(debug_assertions, allow(dead_code))] // hand-off is release-only
fn setting_on() -> bool {
    config_dir()
        .and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["run_elevated"].as_bool())
        .unwrap_or(false)
}

/// Called first thing at startup. Returns true when this process should exit
/// because an elevated instance is being started in its place.
#[cfg_attr(debug_assertions, allow(dead_code))] // hand-off is release-only
pub fn hand_off_if_wanted() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == FROM_TASK) || is_elevated() || !setting_on() || !task_exists() {
        return false;
    }
    if let Some(path) = handoff_args_path() {
        let _ = std::fs::write(path, args.join("\n"));
    }
    // Start the task a moment after we exit: the elevated instance would
    // otherwise find us still running and quit as a duplicate instance.
    let started = hidden("cmd")
        .args(["/c", &format!("ping -n 2 127.0.0.1 >nul & schtasks /run /tn \"{TASK}\"")])
        .spawn()
        .is_ok();
    started
}

/// Arguments of the launch that handed off to the task (e.g. `--hidden`
/// from login autostart), consumed once.
pub fn handed_off_args() -> Vec<String> {
    if !std::env::args().any(|a| a == FROM_TASK) {
        return Vec::new();
    }
    let Some(path) = handoff_args_path() else { return Vec::new() };
    let args = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(path);
    args.lines().filter(|l| !l.is_empty()).map(String::from).collect()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn task_xml(exe: &std::path::Path) -> String {
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_default()
    );
    let dir = exe.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    // No trigger: login autostart and every other launch hand off to it.
    // Priority 4 = normal (the default 7 runs below normal); no time limit
    // (the default stops the task after 72h); keep running on battery.
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts ClipForge with admin rights without a UAC prompt.</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{exe}"</Command>
      <Arguments>{FROM_TASK}</Arguments>
      <WorkingDirectory>{dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
        user = xml_escape(&user),
        exe = xml_escape(&exe.to_string_lossy()),
        dir = xml_escape(&dir),
    )
}

/// Run `schtasks` with these arguments as administrator (one UAC prompt,
/// none if we're already elevated) and wait for it.
fn schtasks_elevated(args: &str) -> Result<(), String> {
    if is_elevated() {
        let status = hidden("schtasks")
            .args(split_args(args))
            .status()
            .map_err(|e| e.to_string())?;
        return if status.success() { Ok(()) } else { Err(format!("schtasks failed ({status})")) };
    }
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let verb = HSTRING::from("runas");
    let file = HSTRING::from("schtasks.exe");
    let params = HSTRING::from(args);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            return Err(if e.code() == ERROR_CANCELLED.to_hresult() {
                "Cancelled: Windows needs your OK on the admin prompt.".into()
            } else {
                format!("couldn't run schtasks: {e}")
            });
        }
        if info.hProcess.is_invalid() {
            return Err("couldn't run schtasks".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        let got = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        got.map_err(|e| e.to_string())?;
        if code == 0 { Ok(()) } else { Err(format!("schtasks failed (exit code {code})")) }
    }
}

/// Split a schtasks argument string on spaces outside double quotes.
fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in args.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn create_task() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let xml_path = std::env::temp_dir().join("clipforge-admin-task.xml");
    // schtasks expects the XML as UTF-16 (LE, with BOM) to match its declaration.
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(task_xml(&exe).encode_utf16().flat_map(|u| u.to_le_bytes()));
    std::fs::write(&xml_path, bytes).map_err(|e| e.to_string())?;
    let result = schtasks_elevated(&format!("/create /tn \"{TASK}\" /xml \"{}\" /f", xml_path.display()));
    let _ = std::fs::remove_file(xml_path);
    result
}

/// Turn "run with admin rights" on or off: creates/removes the task (one
/// UAC prompt), then saves the setting. Turning it on takes effect on the
/// next launch; `restart_elevated` applies it right away.
#[tauri::command]
pub async fn set_run_elevated(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::clips::blocking(move || {
        if enabled {
            create_task()?;
        } else if task_exists() {
            schtasks_elevated(&format!("/delete /tn \"{TASK}\" /f"))?;
        }
        let mut settings = crate::clips::load_settings_inner(&app);
        settings.run_elevated = enabled;
        crate::clips::save_settings(app, settings)
    })
    .await
}

#[tauri::command]
pub fn is_running_elevated() -> bool {
    is_elevated()
}

/// Restart into the elevated task now (after turning the setting on).
#[tauri::command]
pub fn restart_elevated(app: tauri::AppHandle) -> Result<(), String> {
    if !task_exists() {
        return Err("The admin task is missing. Turn the setting off and on again.".into());
    }
    hidden("cmd")
        .args(["/c", &format!("ping -n 3 127.0.0.1 >nul & schtasks /run /tn \"{TASK}\"")])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_runs_elevated_without_limits() {
        let xml = task_xml(std::path::Path::new(r"C:\Users\A & B\AppData\Local\clipforge\clipforge.exe"));
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<Priority>4</Priority>"));
        assert!(xml.contains("A &amp; B"));
        assert!(xml.contains("<Arguments>--from-task</Arguments>"));
    }

    #[test]
    fn splits_quoted_args() {
        assert_eq!(
            split_args(r#"/create /tn "ClipForge (admin)" /xml "C:\a b.xml" /f"#),
            ["/create", "/tn", "ClipForge (admin)", "/xml", r"C:\a b.xml", "/f"]
        );
    }
}
