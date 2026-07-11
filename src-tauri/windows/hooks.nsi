; Custom NSIS hooks for the ClipForge installer (wired via
; bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; POSTINSTALL: if OBS Studio isn't already on the machine, silently fetch and
; install it via install-obs.ps1 (bundled as a resource) so a friend's
; machine ends up fully set up from one installer, no manual OBS download.
!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$PROGRAMFILES64\obs-studio\bin\64bit\obs64.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\obs-studio\bin\64bit\obs64.exe"
    DetailPrint "OBS Studio already installed, skipping."
  ${Else}
    DetailPrint "Installing OBS Studio (downloading, this may take a minute)..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-obs.ps1"'
    Pop $0
    DetailPrint "OBS Studio setup finished (exit code $0)."
  ${EndIf}
!macroend
