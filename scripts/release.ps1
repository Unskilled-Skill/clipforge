# ClipForge release: signed build + GitHub release with updater manifest.
# Usage: .\scripts\release.ps1 -Version 0.1.3 -Notes "what changed"
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "Update"
)
# Note: no $ErrorActionPreference = Stop — tauri/npm print info to stderr,
# which PowerShell 5.1 would otherwise treat as a terminating error.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

# Version must already be bumped in tauri.conf.json + Cargo.toml.
$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
if ($conf.version -ne $Version) { throw "tauri.conf.json version is $($conf.version), expected $Version" }

$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$repo\.tauri-signing\clipforge.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

cmd /c "npm run tauri build -- --bundles nsis 2>&1"
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$exe = "$repo\src-tauri\target\release\bundle\nsis\clipforge_${Version}_x64-setup.exe"
$sig = Get-Content "$exe.sig" -Raw

$manifest = [ordered]@{
    version  = $Version
    notes    = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = @{
        "windows-x86_64" = @{
            signature = $sig.Trim()
            url       = "https://github.com/Unskilled-Skill/clipforge/releases/download/v$Version/clipforge_${Version}_x64-setup.exe"
        }
    }
}
$latest = "$repo\src-tauri\target\release\bundle\nsis\latest.json"
[IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

gh release create "v$Version" $exe "$exe.sig" $latest --title "ClipForge v$Version" --notes $Notes
Write-Output "released v$Version"
