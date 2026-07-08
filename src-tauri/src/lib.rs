mod clips;
mod fullscreen;
mod obs;
mod setup;
mod supervisor;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use obs::ObsState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Milliseconds since app start of the last accepted hotkey press.
/// Used by `should_accept_press` to throttle hotkey spam.
static LAST_SAVE_MS: AtomicU64 = AtomicU64::new(0);

/// Set by the short-clip hotkey; the next saved replay gets trimmed
/// down to the last N seconds.
pub static PENDING_SHORT: AtomicBool = AtomicBool::new(false);

/// Currently registered hotkeys: (full save, short save).
struct Hotkeys(Mutex<(Shortcut, Shortcut)>);

/// Decide whether a hotkey press should trigger a replay save.
///
/// OBS rejects a SaveReplayBuffer request while the previous flush is
/// still writing, and mashing the hotkey mid-fight would otherwise
/// produce a burst of overlapping clips of the same moment.
///
/// `now_ms` is milliseconds since app start; `LAST_SAVE_MS` holds the
/// value of the last accepted press (0 = never).
fn should_accept_press(now_ms: u64) -> bool {
    // 3s cooldown, presses inside it are dropped (not sliding — a held
    // key must not postpone the next allowed save indefinitely).
    const COOLDOWN_MS: u64 = 3000;
    let last = LAST_SAVE_MS.load(Ordering::Relaxed);
    if last != 0 && now_ms.saturating_sub(last) < COOLDOWN_MS {
        return false;
    }
    LAST_SAVE_MS.store(now_ms.max(1), Ordering::Relaxed);
    true
}

fn normalize_hotkey(raw: &str) -> String {
    raw.split('+')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn parse_hotkeys(save: &str, short: &str) -> Result<(Shortcut, Shortcut), String> {
    let save_n = normalize_hotkey(save);
    let short_n = normalize_hotkey(short);
    let save: Shortcut = save_n
        .parse()
        .map_err(|_| format!("'{save_n}' is not a valid hotkey"))?;
    let short: Shortcut = short_n
        .parse()
        .map_err(|_| format!("'{short_n}' is not a valid hotkey"))?;
    if save == short {
        return Err("hotkeys must differ".into());
    }
    Ok((save, short))
}

/// Swap registered hotkeys atomically: if the new pair cannot be
/// registered (conflict with another app), the old pair is restored.
fn register_hotkeys(app: &AppHandle, save: Shortcut, short: Shortcut) -> Result<(), String> {
    let gs = app.global_shortcut();
    let old = app.try_state::<Hotkeys>().map(|s| *s.0.lock().unwrap());

    let _ = gs.unregister_all();
    let result = gs
        .register(save)
        .and_then(|()| gs.register(short))
        .map_err(|e| e.to_string());

    if result.is_err() {
        let _ = gs.unregister_all();
        if let Some((old_save, old_short)) = old {
            let _ = gs.register(old_save);
            let _ = gs.register(old_short);
        }
        return result.map(|_| ()).map_err(|e| format!("could not register (in use by another app?): {e}"));
    }

    if let Some(state) = app.try_state::<Hotkeys>() {
        *state.0.lock().unwrap() = (save, short);
    }
    Ok(())
}

/// Rebind hotkeys live and persist them to settings.
#[tauri::command]
fn set_hotkeys(app: AppHandle, save: String, short: String) -> Result<(), String> {
    let (save_sc, short_sc) = parse_hotkeys(&save, &short)?;
    register_hotkeys(&app, save_sc, short_sc)?;
    let mut settings = clips::load_settings_inner(&app);
    settings.hotkey_save = normalize_hotkey(&save);
    settings.hotkey_short = normalize_hotkey(&short);
    clips::save_settings(app, settings)
}

/// Watch the clips folder and tell the frontend when files change.
/// Self-healing: re-targets when `clips_dir` changes (first-run relocation,
/// user edits in Settings) and retries when the folder doesn't exist yet.
fn spawn_dir_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecursiveMode, Watcher};
        loop {
            let dir = clips::load_settings_inner(&app).clips_dir;
            if !std::path::Path::new(&dir).exists() {
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }

            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let mut watcher = match notify::recommended_watcher(
                move |event: Result<notify::Event, notify::Error>| {
                    if let Ok(event) = event {
                        // Thumbnail writes would loop refresh -> gen -> refresh.
                        let relevant = event
                            .paths
                            .iter()
                            .any(|p| !p.to_string_lossy().contains(".thumbs"));
                        if relevant {
                            let _ = tx.send(());
                        }
                    }
                },
            ) {
                Ok(w) => w,
                Err(_) => return,
            };
            if watcher
                .watch(std::path::Path::new(&dir), RecursiveMode::NonRecursive)
                .is_err()
            {
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }

            loop {
                match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(()) => {
                        // Debounce: a save/trim touches the file many times.
                        while rx
                            .recv_timeout(std::time::Duration::from_millis(700))
                            .is_ok()
                        {}
                        let _ = app.emit("clips-changed", ());
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Periodically check whether the folder moved.
                        if clips::load_settings_inner(&app).clips_dir != dir {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            // Drop this watcher and re-create it against the new folder.
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_start = std::time::Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch just brings the existing window forward.
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ObsState::default())
        .manage(obs::CurrentGame::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let (save, short) = match app.try_state::<Hotkeys>() {
                        Some(state) => *state.0.lock().unwrap(),
                        None => return,
                    };
                    let is_short = *shortcut == short;
                    if !is_short && *shortcut != save {
                        return;
                    }
                    let now_ms = app_start.elapsed().as_millis() as u64;
                    if !should_accept_press(now_ms) {
                        return;
                    }
                    PENDING_SHORT.store(is_short, Ordering::Relaxed);
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<ObsState>();
                        match obs::save_replay(state.inner()).await {
                            Ok(()) => {}
                            Err(e) => {
                                let _ = app.emit("clip-error", e);
                            }
                        }
                    });
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(supervisor::run(handle));

            let settings = clips::load_settings_inner(app.handle());
            let (save, short) =
                parse_hotkeys(&settings.hotkey_save, &settings.hotkey_short)
                    .unwrap_or_else(|_| parse_hotkeys("alt+f10", "shift+alt+f10").unwrap());
            app.manage(Hotkeys(Mutex::new((save, short))));
            let _ = register_hotkeys(app.handle(), save, short);

            let _ = app
                .asset_protocol_scope()
                .allow_directory(&settings.clips_dir, true);
            spawn_dir_watcher(app.handle().clone());

            // Autostart at login — only for the installed build, so the
            // registry never points at a dev target/debug exe.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // Tray icon: left-click shows the window, menu has show/quit.
            let show = MenuItem::with_id(app, "show", "Show ClipForge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ClipForge")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray; supervisor and hotkey
            // keep running. Quit lives in the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            obs::obs_connect,
            obs::obs_status,
            obs::start_replay_buffer,
            obs::save_replay_cmd,
            clips::load_settings,
            clips::save_settings,
            clips::list_clips,
            clips::trim_clip,
            clips::delete_clip,
            clips::analyze_black,
            clips::gen_thumbnails,
            clips::export_discord,
            clips::load_favorites,
            clips::toggle_favorite,
            clips::run_storage_cleanup,
            clips::list_audio_tracks,
            clips::gen_waveform,
            clips::export_montage,
            clips::export_gif,
            clips::export_frame,
            clips::rename_clip,
            setup::setup_status,
            setup::winget_install,
            set_hotkeys,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
