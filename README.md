# ClipForge

Outplayed-style game clipping with OBS's capture engine built in — nothing else to install. Press a hotkey, keep the last 2–3 minutes of gameplay. No accounts, no cloud, no overlay injection.

![Tauri](https://img.shields.io/badge/Tauri_2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-orange?logo=rust)
![React](https://img.shields.io/badge/React-UI-61DAFB?logo=react&logoColor=black)

## Features

- **One-hotkey clipping** — `Alt+F10` saves the replay buffer (rebindable by pressing keys, no syntax). `Shift+Alt+F10` keeps only the last 30s.
- **Game-aware** — replay buffer arms itself when a game runs, disarms when it exits. Fullscreen games are detected automatically and remembered; zero idle GPU/RAM cost on the desktop.
- **Built-in capture engine** — OBS's engine (libobs) runs inside ClipForge: game-hook capture, hardware encoding and a RAM replay buffer, with no OBS install, no websocket and nothing extra in the tray. It downloads once on first run.
- **Configurable capture** — clip length, fps, resolution, bitrate and encoder (auto/AV1/HEVC/H264) all live in Settings and apply automatically.
- **Library** — thumbnail grid, per-game filter chips, search, favorites, black-clip scanner, storage cap (oldest non-favorites auto-recycled).
- **Editor** — waveform timeline with draggable trim handles, range preview/loop, frame-step keyboard shortcuts, lossless trim, inline rename.
- **Exports** — Discord-sized (10/50/500 MB, size-budgeted bitrate, auto-copied to clipboard), audio track picker (full mix / game only / mic only), GIF, frame PNG, multi-clip montage.
- **Hardware everything** — H264 encoder auto-detected per machine (NVENC → AMF → QuickSync → CPU). Recording uses the best codec your GPU offers (AV1 → HEVC → H264).
- **Onboarding tutorial** — first launch walks through setup and how to use the app; replay it anytime from the Tutorial button in the sidebar.
- **Test my setup** — Settings → Health saves a sample from a running game and opens its last ~10 seconds in the editor. Confirm the picture and expected audio yourself; the original replay is preserved.
- **Safer keepers** — unreadable favorites stop automatic cleanup. Backup conflicts preserve the existing file and show an error; identical older backups are adopted after checking their contents.

Automatic cleanup also keeps the replay that just finished saving, even if that single clip exceeds the storage cap. It becomes eligible for cleanup on a later save unless starred.

## Install

1. Grab `clipforge_x64-setup.exe` from [Releases](../../releases) and run it (SmartScreen: *More info → Run anyway* — unsigned).
2. First launch downloads the capture engine once (~150 MB). The installer also fetches ffmpeg; if that's skipped (offline, etc.) the app offers a one-click install.
3. Play something. `Alt+F10`. Done.

## Development

```bash
npm install
npm run tauri dev     # full app (quit the installed tray instance first — hotkey clash)
npm run dev           # UI only in a browser, with mock data (src/tauri-shim.ts)
npm test              # setup workflow tests (Node 22.6+)
.\scripts\dev.ps1     # same as tauri dev, but kills the installed tray instance first
npm run tauri build -- --bundles nsis
.\scripts\install.ps1   # rebuild + silent local install + relaunch, no signing/GitHub
```

Stack: Tauri 2, React + TypeScript, Rust ([libobs-rs](https://github.com/libobs-rs/libobs-rs) for the embedded OBS engine, `sysinfo`, `notify`), ffmpeg for all media processing.

## How it works

libobs does the heavy lifting in-process: game capture hook, hardware encoding, and a RAM replay buffer. ClipForge is the brain — a supervisor loop that starts the engine, aims capture at the detected game, arms the buffer only while a game is running, names clips after the detected game, and a library/editor UI on top of the resulting files.

## License

GPL-3.0-or-later (see [LICENSE](LICENSE)), as required by the embedded OBS engine.
