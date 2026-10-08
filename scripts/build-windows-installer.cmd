@echo off
rem Double-click to build the Autobot Terminal installer. Output: release\<version>\Autobot-Terminal-Setup-<version>.exe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows-installer.ps1"
echo.
pause
