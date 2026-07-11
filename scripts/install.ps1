# ClipForge local build + install. No GitHub, no release — just rebuild the
# installer from current source and install it over the existing app.
# Usage: .\scripts\install.ps1            (build + silent install + relaunch)
#        .\scripts\install.ps1 -NoLaunch  (skip relaunch)
param(
    [switch]$NoLaunch
)
# No $ErrorActionPreference = Stop: tauri/npm write progress to stderr, which
# PowerShell 5.1 treats as terminating. We gate on $LASTEXITCODE instead.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = $conf.version
Write-Output "Building ClipForge v$version ..."

# The running app locks its own exe; close it before installing.
Get-Process clipforge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

# Local install does not need updater artifacts. Override createUpdaterArtifacts
# to false so the build never touches the signing key — a password-protected key
# would otherwise stall on an interactive prompt in a non-interactive shell.
cmd /c "npm run tauri build -- --bundles nsis -c `"{\`"bundle\`":{\`"createUpdaterArtifacts\`":false}}`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$exe = "$repo\src-tauri\target\release\bundle\nsis\clipforge_${version}_x64-setup.exe"
if (-not (Test-Path $exe)) { throw "installer not found: $exe" }

Write-Output "Installing $exe ..."
Start-Process $exe -ArgumentList '/S' -Wait

$installed = "$env:LOCALAPPDATA\ClipForge\clipforge.exe"
Write-Output "Installed v$version -> $installed"

if (-not $NoLaunch -and (Test-Path $installed)) {
    Start-Process $installed
    Write-Output "Launched ClipForge."
}
