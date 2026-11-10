@echo off
setlocal
set "MODULE=%~dp0"
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  start "" /min powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%MODULE%scripts\open-window.ps1"
) else (
  start "" /min pwsh.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%MODULE%scripts\open-window.ps1"
)
