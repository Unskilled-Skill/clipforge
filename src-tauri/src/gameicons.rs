//! Game icons taken from each game's own .exe, cached as PNGs under the
//! app config dir. Keyed by the same label clip files start with
//! ("Valorant", "Apex"), so the library can match a clip to its icon.
//!
//! Icons come from the running game (supervisor) and, once per launch, from
//! a shallow search of the usual store install folders for watched games.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Labels already extracted or attempted this run.
static TRIED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn icon_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?.join("game-icons");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Let the window load cached icons (the asset scope only covers clips).
pub fn allow_assets(app: &AppHandle) {
    if let Some(dir) = icon_dir(app) {
        let _ = app.asset_protocol_scope().allow_directory(dir, false);
    }
}

fn label_key(exe_name: &str) -> String {
    crate::obs::pretty_game_name(exe_name).to_lowercase()
}

/// Cache the icon of the game at `exe_path` unless it's cached or tried.
/// Extraction runs on its own thread; failures are silent (the UI falls
/// back to a dot).
pub fn remember(app: &AppHandle, exe_path: &Path) {
    let Some(name) = exe_path.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    let key = label_key(&name);
    {
        let mut tried = TRIED.lock().unwrap_or_else(|e| e.into_inner());
        if !tried.get_or_insert_with(HashSet::new).insert(key.clone()) {
            return;
        }
    }
    let Some(dir) = icon_dir(app) else { return };
    let out = dir.join(format!("{key}.png"));
    if out.exists() {
        return;
    }
    let exe = exe_path.to_path_buf();
    std::thread::spawn(move || {
        if let Err(error) = extract(&exe, &out) {
            crate::logs::line(&format!("Could not read the icon of {}: {error}", exe.display()));
        }
    });
}

/// System.Drawing's associated icon, saved as PNG. PowerShell keeps this
/// free of image crates; it runs once per game.
fn extract(exe: &Path, out: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Paths go in through the environment: -Command joins trailing args
    // into the script, which splits paths with spaces.
    let script = "Add-Type -AssemblyName System.Drawing; \
        $i = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CF_ICON_EXE); \
        if ($i) { $i.ToBitmap().Save($env:CF_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png) }";
    let native = |p: &Path| p.to_string_lossy().replace('/', "\\");
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CF_ICON_EXE", native(exe))
        .env("CF_ICON_OUT", native(out))
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() && out.exists() {
        Ok(())
    } else {
        Err(format!("powershell exited with {status}"))
    }
}

/// Where stores install games. Shallow on purpose: this runs at startup.
fn install_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = crate::gamesources::steam_library_roots()
        .into_iter()
        .map(|r| r.join("steamapps/common"))
        .collect();
    for extra in [
        "C:/Riot Games",
        "C:/Program Files/Epic Games",
        "C:/Program Files (x86)/Overwatch",
        "C:/Program Files (x86)/Battle.net",
        "C:/XboxGames",
    ] {
        roots.push(PathBuf::from(extra));
    }
    roots.retain(|r| r.exists());
    roots
}

/// Installed programs from the Windows uninstall list: (install folder,
/// icon file). Many games name their own .exe as the icon.
fn uninstall_entries() -> Vec<(Option<PathBuf>, Option<PathBuf>)> {
    use std::os::windows::process::CommandExt;
    let script = r#"Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | ForEach-Object { "$($_.InstallLocation)|$($_.DisplayIcon)" }"#;
    let Ok(output) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (location, icon) = line.split_once('|')?;
            let clean = |s: &str| {
                let s = s.trim().trim_matches('"');
                // DisplayIcon may carry ",0" (icon index).
                let s = s.rsplit_once(',').filter(|(_, i)| i.trim().parse::<i32>().is_ok()).map_or(s, |(p, _)| p);
                (!s.is_empty()).then(|| PathBuf::from(s))
            };
            Some((clean(location).filter(|p| p.is_dir()), clean(icon)))
        })
        .collect()
}

/// Folders a startup search may open, so a game that's no longer
/// installed can't make every launch walk whole drives.
const DIR_BUDGET: usize = 40_000;

/// Find each watched game's exe and cache its icon: first exes the uninstall
/// list names directly, then a search (up to six folders deep) of store
/// folders and install locations.
pub fn seed(app: AppHandle, game_exes: Vec<String>) {
    std::thread::spawn(move || {
        let Some(dir) = icon_dir(&app) else { return };
        let mut wanted: HashSet<String> = game_exes
            .iter()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| e.ends_with(".exe") && !dir.join(format!("{}.png", label_key(e))).exists())
            .collect();
        if wanted.is_empty() {
            return;
        }
        let entries = uninstall_entries();
        for icon in entries.iter().filter_map(|(_, icon)| icon.as_ref()) {
            let name = icon.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if wanted.remove(&name) && icon.is_file() {
                remember(&app, icon);
            }
        }
        let mut roots = install_roots();
        roots.extend(entries.into_iter().filter_map(|(location, _)| location));
        let mut stack: Vec<(PathBuf, u8)> = roots.into_iter().map(|r| (r, 0)).collect();
        let mut opened = 0;
        while let Some((folder, depth)) = stack.pop() {
            opened += 1;
            if wanted.is_empty() || opened > DIR_BUDGET {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&folder) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() && depth < 6 {
                    stack.push((path, depth + 1));
                } else if kind.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if wanted.remove(&name) {
                        remember(&app, &path);
                    }
                }
            }
        }
    });
}

/// Cached icons as label → PNG path, for the library.
#[tauri::command]
pub fn list_game_icons(app: AppHandle) -> HashMap<String, String> {
    let Some(dir) = icon_dir(&app) else { return HashMap::new() };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()? != "png" {
                return None;
            }
            Some((path.file_stem()?.to_string_lossy().into_owned(), path.to_string_lossy().into_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::label_key;

    #[test]
    fn icons_key_on_the_clip_label() {
        assert_eq!(label_key("VALORANT-Win64-Shipping.exe"), crate::obs::pretty_game_name("VALORANT-Win64-Shipping.exe").to_lowercase());
        assert_eq!(label_key("cs2.exe"), crate::obs::pretty_game_name("cs2.exe").to_lowercase());
    }
}
