# ClipForge

Outplayed-style game clipping, powered by your own OBS. Press a hotkey, keep the last 2–3 minutes of gameplay. No accounts, no cloud, no overlay injection.

![Tauri](https://img.shields.io/badge/Tauri_2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-orange?logo=rust)
![React](https://img.shields.io/badge/React-UI-61DAFB?logo=react&logoColor=black)

## Features

- **One-hotkey clipping** — `Alt+F10` saves the replay buffer (rebindable by pressing keys, no syntax). `Shift+Alt+F10` keeps only the last 30s.
- **Game-aware** — replay buffer arms itself when a game runs, disarms when it exits. Fullscreen games are detected automatically and remembered; zero idle GPU/RAM cost on the desktop.
- **Self-managing OBS** — launches OBS hidden, enables the websocket server, reads the password, configures the replay buffer, reconnects after crashes. Zero manual OBS setup.
- **Configurable capture** — clip length, fps, resolution, bitrate and encoder (auto/AV1/HEVC/H264) all live in Settings and apply to OBS automatically.
- **Library** — thumbnail grid, per-game filter chips, search, favorites, black-clip scanner, storage cap (oldest non-favorites auto-recycled).
- **Editor** — waveform timeline with draggable trim handles, range preview/loop, frame-step keyboard shortcuts, lossless trim, inline rename.
- **Exports** — Discord-sized (10/50/500 MB, size-budgeted bitrate, auto-copied to clipboard), audio track picker (full mix / game only / mic only), GIF, frame PNG, multi-clip montage.
- **Hardware everything** — H264 encoder auto-detected per machine (NVENC → AMF → QuickSync → CPU). Recording stays AV1/whatever your OBS profile uses.
- **Onboarding tutorial** — first launch walks through setup and how to use the app; replay it anytime from the Tutorial button in the sidebar.

## Install

1. Grab `clipforge_x64-setup.exe` from [Releases](../../releases) and run it (SmartScreen: *More info → Run anyway* — unsigned).
2. The installer silently installs OBS Studio during setup if it isn't already on the machine. If that step gets skipped (offline, etc.) or ffmpeg is still missing, the app offers one-click installs on first launch.
3. Play something. `Alt+F10`. Done.

## Development

```bash
npm install
npm run tauri dev     # full app (quit the installed tray instance first — hotkey clash)
npm run dev           # UI only in a browser, with mock data (src/tauri-shim.ts)
.\scripts\dev.ps1     # same as tauri dev, but kills the installed tray instance first
npm run tauri build -- --bundles nsis
.\scripts\install.ps1   # rebuild + silent local install + relaunch, no signing/GitHub
```

Stack: Tauri 2, React + TypeScript, Rust (`obws` for obs-websocket v5, `sysinfo`, `notify`), ffmpeg for all media processing.

## How it works

OBS does the heavy lifting: game capture hook, hardware encoding, and a RAM replay buffer. ClipForge is the brain — a supervisor loop that keeps OBS alive and connected, arms the buffer only while a game is running, names clips after the detected game, and a library/editor UI on top of the resulting files.
