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

; POSTUNINSTALL: remove the capture engine (OBS runtime, ~180 MB) that the
; app downloaded next to its exe on first run. Skipped for updates: the
; updater runs this uninstaller too, and the runtime must survive it.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\obs-plugins"
    RMDir /r "$INSTDIR\iconengines"
    RMDir /r "$INSTDIR\platforms"
    RMDir /r "$INSTDIR\styles"
    RMDir /r "$INSTDIR\.libobs-bootstrap-cache"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\obs-amf-test.exe"
    Delete "$INSTDIR\obs-ffmpeg-mux.exe"
    Delete "$INSTDIR\obs-nvenc-test.exe"
    Delete "$INSTDIR\obs-qsv-test.exe"
    RMDir "$INSTDIR\windows"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
