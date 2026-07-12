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

# Build with createUpdaterArtifacts off, then sign separately below via the
# `tauri signer sign` CLI. Letting `tauri build` sign inline reads the empty
# password differently than the CLI's `-p ""` does and hangs on a prompt
# that never reaches this non-interactive shell.
$override = "$repo\tauri-override.json"
# Windows PowerShell 5.1 has no utf8NoBOM encoding, and a BOM breaks the JSON
# parser tauri uses for --config, so write the file via .NET without a BOM.
[IO.File]::WriteAllText($override, '{"bundle":{"createUpdaterArtifacts":false}}', (New-Object System.Text.UTF8Encoding($false)))
cmd /c "npm run tauri build -- --bundles nsis --config `"$override`" 2>&1"
$buildExit = $LASTEXITCODE
Remove-Item $override -Force -ErrorAction SilentlyContinue
if ($buildExit -ne 0) { throw "build failed" }

$exe = "$repo\src-tauri\target\release\bundle\nsis\clipforge_${Version}_x64-setup.exe"
# Pass the (empty) key password via env var, NOT `-p ""`: PowerShell drops an
# empty-string argument to a native command, which makes the signer prompt
# interactively and fail in this non-interactive shell.
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri signer sign -f "$repo\.tauri-signing\clipforge.key" "$exe"
if ($LASTEXITCODE -ne 0) { throw "signing failed" }
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
