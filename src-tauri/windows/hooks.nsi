; Custom NSIS hooks for the ClipForge installer (wired via
; bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; POSTINSTALL: install ffmpeg via winget (install-ffmpeg.ps1) if missing.
; Best-effort; the app offers a one-click install as backup. Recording needs
; no install step: the built-in capture engine downloads on first run.
!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Checking for ffmpeg (needed for thumbnails, trims and exports)..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-ffmpeg.ps1"'
  Pop $0
  DetailPrint "ffmpeg setup finished (exit code $0)."
!macroend
