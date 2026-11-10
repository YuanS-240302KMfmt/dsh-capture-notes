param(
  [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File "' +
  (Join-Path $module 'scripts\open-window.ps1') + '"'

$folders = @()
if ($StartMenu) {
  $folders += Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
} else {
  $folders += [Environment]::GetFolderPath('Desktop')
  $folders += Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
}

$shell = New-Object -ComObject WScript.Shell
$files = @()
foreach ($folder in $folders) {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $file = Join-Path $folder '录屏字幕台.lnk'
  $shortcut = $shell.CreateShortcut($file)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $module
  $shortcut.IconLocation = "$pwsh,0"
  $shortcut.Description = '打开录屏字幕台'
  $shortcut.Save()
  $files += $file
}

[pscustomobject]@{
  ok = $true
  shortcuts = $files
  target = $pwsh
  arguments = $arguments
} | ConvertTo-Json -Depth 4
