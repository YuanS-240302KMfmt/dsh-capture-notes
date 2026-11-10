param(
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$data = Join-Path $PSScriptRoot '.tmp-recent'
$pidFile = Join-Path $data 'window.pid'
$quitFile = Join-Path $data 'quit.request'

Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $data | Out-Null

$env:CAPTURE_NOTES_TEST_RECENT = '1'
$process = Start-Process -FilePath 'pwsh.exe' -ArgumentList @(
  '-NoProfile', '-STA', '-File', (Join-Path $module 'lib\window.ps1'),
  '-DataDir', $data
) -PassThru
Remove-Item Env:CAPTURE_NOTES_TEST_RECENT -ErrorAction SilentlyContinue

$result = [ordered]@{
  ok = $false
  pid = $process.Id
  menuOpened = $false
  processAlive = $false
  quitWorks = $false
}

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $pidFile)) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $pidFile)) { throw 'window did not write window.pid' }

  Start-Sleep -Seconds 3
  $process.Refresh()
  $result.menuOpened = -not $process.HasExited
  $result.processAlive = -not $process.HasExited
  if (-not $result.menuOpened) { throw 'window exited after opening the recent menu' }

  [IO.File]::WriteAllText($quitFile, (Get-Date).ToString('o'), [Text.UTF8Encoding]::new($false))
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  $result.quitWorks = $process.HasExited
  $result.ok = $result.menuOpened -and $result.processAlive -and $result.quitWorks
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { if (-not $process.HasExited) { $process.Kill() } } catch {}
  Start-Sleep -Milliseconds 300
}

$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
