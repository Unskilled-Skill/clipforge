# Run by the NSIS installer's POSTINSTALL hook (see windows/hooks.nsi).
# Thumbnails, trims and every export need ffmpeg; without this a new user's
# library shows no thumbnails until they find the in-app install button.
# Installs via winget into %LOCALAPPDATA%\Microsoft\WinGet\Packages, which the
# app searches directly (PATH only updates after the next sign-in).
$ErrorActionPreference = 'Stop'
try {
    if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { exit 0 }
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Get-ChildItem $packages -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue) { exit 0 }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { exit 1 }

    winget install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    exit $LASTEXITCODE
} catch {
    # Best-effort: offline or no winget shouldn't fail the ClipForge install;
    # the app still offers a one-click ffmpeg install on first launch.
    exit 1
}
