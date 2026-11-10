param(
  [string]$DataDir = '',
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $module 'runtime-data'
}
$ffmpeg = Join-Path $module 'runtime\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

$arguments = @(
  '-NoProfile', '-STA', '-File', (Join-Path $module 'lib\window.ps1'),
  '-DataDir', $DataDir,
  '-FfmpegPath', $ffmpeg
)
if ($ParentPid -gt 0) {
  $arguments += @('-ParentPid', [string]$ParentPid)
}

$process = Start-Process -FilePath $pwsh -ArgumentList $arguments -WindowStyle Hidden -PassThru
[pscustomobject]@{
  ok = $true
  pid = $process.Id
  dataDir = $DataDir
  parentPid = $ParentPid
} | ConvertTo-Json -Compress
