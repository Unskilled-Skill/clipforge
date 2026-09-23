; Custom NSIS hooks for the ClipForge installer (wired via
; bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; POSTINSTALL: make a friend's machine fully set up from one installer.
;   - OBS Studio: if it isn't already on the machine, silently fetch and
;     install it via install-obs.ps1. "Already there" also covers custom
;     install folders (OBS records its dir in the registry) and the Steam
;     build of OBS, so those users don't end up with a second copy.
;   - ffmpeg: install via winget (install-ffmpeg.ps1) if missing.
; Both scripts are best-effort; the app offers one-click installs as backup.
!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  ; OBS's installer writes its install dir as the default value of this key;
  ; check both registry views since either bitness of installer may have run.
  SetRegView 64
  ReadRegStr $1 HKLM "SOFTWARE\OBS Studio" ""
  ${If} $1 == ""
    SetRegView 32
    ReadRegStr $1 HKLM "SOFTWARE\OBS Studio" ""
  ${EndIf}
  SetRegView default
  ReadRegStr $2 HKCU "Software\Valve\Steam" "SteamPath"

  ${If} ${FileExists} "$PROGRAMFILES64\obs-studio\bin\64bit\obs64.exe"
  ${OrIf} ${FileExists} "$PROGRAMFILES32\obs-studio\bin\64bit\obs64.exe"
  ${OrIf} ${FileExists} "$1\bin\64bit\obs64.exe"
  ${OrIf} ${FileExists} "$2\steamapps\common\OBS Studio\bin\64bit\obs64.exe"
    DetailPrint "OBS Studio already installed, skipping."
  ${Else}
    DetailPrint "Installing OBS Studio (downloading, this may take a minute)..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-obs.ps1"'
    Pop $0
    DetailPrint "OBS Studio setup finished (exit code $0)."
  ${EndIf}

  DetailPrint "Checking for ffmpeg (needed for thumbnails, trims and exports)..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-ffmpeg.ps1"'
  Pop $0
  DetailPrint "ffmpeg setup finished (exit code $0)."
!macroend
