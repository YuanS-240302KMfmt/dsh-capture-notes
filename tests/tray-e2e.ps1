param(
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$data = Join-Path $PSScriptRoot '.tmp-tray'
$pidFile = Join-Path $data 'window.pid'
$quitFile = Join-Path $data 'quit.request'

Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $data | Out-Null

$process = Start-Process -FilePath 'pwsh.exe' -ArgumentList @(
  '-NoProfile', '-STA', '-File', (Join-Path $module 'lib\window.ps1'),
  '-DataDir', $data
) -PassThru

$result = [ordered]@{
  ok = $false
  pid = $process.Id
  windowFound = $false
  hiddenToTray = $false
  quitWorks = $false
}

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $pidFile)) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $pidFile)) { throw 'window did not write window.pid' }

  Add-Type -AssemblyName UIAutomationClient
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, '录屏字幕台'
  )
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  if ($null -eq $window) { throw 'window not found via UIAutomation' }
  $result.windowFound = $true
  $handle = [IntPtr]$window.Current.NativeWindowHandle

  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TrayTestMsg {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
  # WM_CLOSE should be intercepted and turned into "hide to tray".
  [void][TrayTestMsg]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Seconds 2
  $process.Refresh()
  $result.hiddenToTray = -not $process.HasExited
  if (-not $result.hiddenToTray) { throw 'window exited instead of hiding to tray' }

  [IO.File]::WriteAllText($quitFile, (Get-Date).ToString('o'), [Text.UTF8Encoding]::new($false))
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  $result.quitWorks = $process.HasExited
  $result.ok = $result.windowFound -and $result.hiddenToTray -and $result.quitWorks
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { if (-not $process.HasExited) { $process.Kill() } } catch {}
  Start-Sleep -Milliseconds 300
}

$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
