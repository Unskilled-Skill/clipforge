# Run by the NSIS installer's POSTINSTALL hook (see windows/hooks.nsi) when OBS
# Studio isn't already present. Fetches the current OBS Windows installer from
# GitHub and runs it silently, so a friend's machine needs zero manual setup.
$ErrorActionPreference = 'Stop'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/obsproject/obs-studio/releases/latest' `
        -Headers @{ 'User-Agent' = 'ClipForge-Installer' }
    $asset = $release.assets | Where-Object { $_.name -like '*Windows-x64-Installer.exe' } | Select-Object -First 1
    if (-not $asset) { exit 1 }

    $dest = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -UseBasicParsing

    # OBS's installer is NSIS-based; /S is its silent-install switch.
    Start-Process -FilePath $dest -ArgumentList '/S' -Wait
    Remove-Item $dest -Force -ErrorAction SilentlyContinue
} catch {
    # Best-effort: no internet or GitHub unreachable shouldn't fail the ClipForge install.
    exit 1
}
