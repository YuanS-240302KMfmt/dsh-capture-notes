param(
  [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$arguments = '"' + (Join-Path $module 'scripts\launch-window.vbs') + '"'

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
  $shortcut.TargetPath = $wscript
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
  target = $wscript
  arguments = $arguments
} | ConvertTo-Json -Depth 4
