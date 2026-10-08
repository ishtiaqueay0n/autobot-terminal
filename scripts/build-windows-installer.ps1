# Builds the Windows installer (and portable exe) from source.
# Usage: double-click scripts\build-windows-installer.cmd, or run this file from PowerShell.
#        -NoOpen skips opening Explorer at the end (for unattended builds).
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($message) {
    Write-Host ''
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

Write-Host '== Autobot Terminal: Windows installer build ==' -ForegroundColor Cyan

# 1. Node.js 22 or newer.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Node.js is not installed. Install the LTS version, then run this again:`n  winget install OpenJS.NodeJS.LTS`n  (or download it from https://nodejs.org)"
}
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js $(& node -v) is too old; version 22 or newer is needed. Run: winget upgrade OpenJS.NodeJS.LTS" }
Write-Host "Node.js $(& node -v), npm $(& npm -v)"

# 2. An inherited ELECTRON_RUN_AS_NODE (e.g. from an editor) breaks Electron tooling.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 3. Dependencies (exact versions from package-lock.json).
Write-Host ''
Write-Host '-- Installing dependencies (first run downloads ~300 MB) --' -ForegroundColor Cyan
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed. Check your internet connection and try again.' }

# 4. Bundle and package.
Write-Host ''
Write-Host '-- Building installer --' -ForegroundColor Cyan
& npm run dist:win
if ($LASTEXITCODE -ne 0) { Fail 'The build failed; see the messages above.' }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$out = Join-Path $root "release\$version"
$setup = Join-Path $out "Autobot-Terminal-Setup-$version.exe"
if (-not (Test-Path $setup)) { Fail "Expected installer not found: $setup" }

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Installer: $setup"
Write-Host "  Portable:  $(Join-Path $out "Autobot-Terminal-$version-portable.exe")"
Write-Host 'Double-click the installer to install. It is the only file you need to copy to another PC.'
if (-not $NoOpen) { Start-Process explorer.exe -ArgumentList "/select,`"$setup`"" }
