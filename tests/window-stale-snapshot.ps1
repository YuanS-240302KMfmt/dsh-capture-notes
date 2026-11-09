param(
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$data = Join-Path $PSScriptRoot '.tmp-stale-snapshot'
$live = Join-Path $data 'live.json'
$startJson = Join-Path $data 'native\start.json'
$stopRequest = Join-Path $data 'native\stop.request'

function New-Snapshot([string]$status, [string]$id) {
  [pscustomobject]@{
    status = $status
    sessionId = $id
    mode = 'live'
    video = $null
    videoError = ''
    post = $null
    language = 'auto'
    target = 'zh-CN'
    error = ''
    elapsedMs = 0
    lanes = [pscustomobject]@{
      system = [pscustomobject]@{ active = $true; ready = $true; partial = ''; error = $null }
    }
    segments = @()
    savedFiles = @()
    updatedAt = (Get-Date).ToString('o')
  }
}

Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $data 'native') | Out-Null

# Seed the "previous session already stopped" snapshot: this is exactly the
# state that used to stop a freshly started capture after ~200 ms.
[IO.File]::WriteAllText($live, ((New-Snapshot 'stopped' 'old-session') | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))

$env:CAPTURE_NOTES_AUTOSTART = '1'
$process = Start-Process -FilePath 'pwsh.exe' -ArgumentList @(
  '-NoProfile', '-STA', '-File', (Join-Path $module 'lib\window.ps1'),
  '-DataDir', $data, '-AutoCloseMs', '30000'
) -PassThru

$result = [ordered]@{
  ok = $false
  windowPid = $process.Id
  startJson = $false
  staleStoppedIgnored = $false
  realStopWorks = $false
}

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $startJson)) {
    Start-Sleep -Milliseconds 200
  }
  $result.startJson = Test-Path -LiteralPath $startJson
  if (-not $result.startJson) { throw 'window never wrote start.json' }

  # The host's first snapshot for the new session.
  [IO.File]::WriteAllText($live, ((New-Snapshot 'starting' 'race-new') | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  Start-Sleep -Milliseconds 500
  [IO.File]::WriteAllText($live, ((New-Snapshot 'listening' 'race-new') | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 2
  $result.staleStoppedIgnored = -not (Test-Path -LiteralPath $stopRequest)

  # The same session really stops: the window must flush and request a stop.
  [IO.File]::WriteAllText($live, ((New-Snapshot 'stopped' 'race-new') | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 1
  $result.realStopWorks = Test-Path -LiteralPath $stopRequest

  $result.ok = $result.staleStoppedIgnored -and $result.realStopWorks
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { if (-not $process.HasExited) { $process.Kill() } } catch {}
  Remove-Item Env:CAPTURE_NOTES_AUTOSTART -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
}

$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
