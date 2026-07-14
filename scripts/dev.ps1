# Fast iteration: kill the installed tray instance (single-instance guard and
# global-hotkey clash would block a second copy) and run the dev build.
# Frontend edits hot-reload instantly; Rust edits rebuild in debug (~30-60s)
# and relaunch automatically. Ctrl+C to stop; relaunch the installed app from
# the Start Menu afterwards if you want the tray instance back.
Get-Process clipforge -ErrorAction SilentlyContinue | Stop-Process -Force
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run tauri dev
