<#
.SYNOPSIS
  Builds the Linux packages (.rpm, .deb, .AppImage) from Windows, inside a Rocky Linux 8 WSL distro.

.DESCRIPTION
  The packages must be built on the oldest system they should run on: node-pty is compiled during the build and
  keeps that machine's glibc. Rocky Linux 8 (a RHEL 8 rebuild, glibc 2.28) gives packages that run on RHEL 8 and 9
  and on Ubuntu 22.04 and 24.04.

  First run: downloads the official Rocky 8 container image (about 46 MB, checked against Rocky's published SHA-256),
  imports it as the WSL distro "rocky8" and installs the compilers (needs internet, takes a few minutes).
  Later runs only build. The packages end up in release\<version>\ next to the Windows installer.
  Remove the distro any time with:  wsl --unregister rocky8

.PARAMETER Distro
  Name of the WSL distro to use or create. An existing RHEL 8-family distro works too.
#>
param([string]$Distro = 'rocky8')

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 draws a progress bar for downloads, which makes Invoke-WebRequest many times slower.
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot

function Convert-ToWslPath([string]$path) {
  $full = (Resolve-Path $path).Path
  $drive = $full.Substring(0, 1).ToLower()
  return '/mnt/' + $drive + ($full.Substring(2) -replace '\\', '/')
}

function Get-WslDistros {
  # wsl.exe prints UTF-16, which shows up as NUL characters here.
  return @(& wsl.exe -l -q | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

Write-Host '== Autobot Terminal: Linux packages (built in WSL) =='
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw 'WSL is not installed. Install it from an administrator PowerShell with: wsl --install --no-distribution'
}

if ((Get-WslDistros) -notcontains $Distro) {
  Write-Host "-- Creating the WSL distro '$Distro' from the official Rocky Linux 8 image --"
  $base = 'https://dl.rockylinux.org/pub/rocky/8/images/x86_64'
  $file = 'Rocky-8-Container-Base.latest.x86_64.tar.xz'
  $cache = Join-Path $env:LOCALAPPDATA 'Autobot\wsl'
  New-Item -ItemType Directory -Force $cache | Out-Null
  $image = Join-Path $cache $file
  Invoke-WebRequest -Uri "$base/$file" -OutFile $image -UseBasicParsing
  $sums = (Invoke-WebRequest -Uri "$base/$file.CHECKSUM" -UseBasicParsing).Content
  # The server sends it as application/octet-stream, so PowerShell 5.1 hands back bytes.
  if ($sums -is [byte[]]) { $sums = [System.Text.Encoding]::ASCII.GetString($sums) }
  $want = [regex]::Match($sums, '=\s*([0-9a-fA-F]{64})').Groups[1].Value.ToLower()
  $got = (Get-FileHash -Algorithm SHA256 $image).Hash.ToLower()
  if (-not $want -or $want -ne $got) { Remove-Item $image -ErrorAction SilentlyContinue; throw "The downloaded image does not match Rocky's published checksum." }
  $dir = Join-Path $cache $Distro
  New-Item -ItemType Directory -Force $dir | Out-Null
  & wsl.exe --import $Distro $dir $image --version 2
  if ($LASTEXITCODE -ne 0) { throw "wsl --import failed (exit $LASTEXITCODE)" }
}

$src = Convert-ToWslPath $root
Write-Host '-- Installing the build tools (once; quick when already installed) --'
& wsl.exe -d $Distro -u root -e bash "$src/scripts/setup-rhel-build-host.sh" dev
if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit $LASTEXITCODE)" }

Write-Host '-- Building (compiles node-pty, packages rpm, deb and AppImage; takes a few minutes) --'
& wsl.exe -d $Distro -u dev -e env "AUTOBOT_SRC=$src" bash "$src/scripts/build-linux-wsl.sh"
if ($LASTEXITCODE -ne 0) { throw "The build failed (exit $LASTEXITCODE). See the output above." }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host ''
Write-Host 'Done. Packages:'
Get-ChildItem (Join-Path $root "release\$version") -Include *.rpm, *.deb, *.AppImage -Recurse |
  ForEach-Object { '  {0,6:N0} MB  {1}' -f ($_.Length / 1MB), $_.FullName }
