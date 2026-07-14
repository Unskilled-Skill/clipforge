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
# The signer's password prompt reads the Windows console device (CONIN$)
# directly, not stdin — so an empty TAURI_SIGNING_PRIVATE_KEY_PASSWORD or a
# `< NUL` redirect can't suppress it, and every release used to hang here
# until Enter was pressed. Git Bash attaches no Windows console, so the
# prompt can't open and the signer takes the no-password path instantly.
$bash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash (needed to sign without a console prompt)" }
$keyPosix = ($repo -replace '\\', '/') + "/.tauri-signing/clipforge.key"
$exePosix = $exe -replace '\\', '/'
& $bash -lc "TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' npx tauri signer sign -f '$keyPosix' '$exePosix' </dev/null"
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
