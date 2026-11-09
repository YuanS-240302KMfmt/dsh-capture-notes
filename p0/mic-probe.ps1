$ErrorActionPreference = 'Stop'
$module = Split-Path $PSScriptRoot -Parent
$out = Join-Path $module 'p0\.tmp\mic-probe.json'
$result = [ordered]@{
  user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  elevated = $false
  wasapi = ''
  waveIn = ''
  error = ''
}

try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $result.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

try {
  Add-Type -Path (Join-Path $module 'lib\NAudio.dll')
} catch {
  $result.error = "Add-Type failed: $($_.Exception.Message)"
  [IO.File]::WriteAllText($out, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  exit 1
}

try {
  $cap = [NAudio.CoreAudioApi.WasapiCapture]::new()
  $cap.StartRecording()
  Start-Sleep -Milliseconds 500
  $cap.StopRecording()
  $cap.Dispose()
  $result.wasapi = 'ok'
} catch {
  $result.wasapi = "fail: $($_.Exception.Message)"
  if ($_.Exception.InnerException) {
    $result.wasapi += " / inner: $($_.Exception.InnerException.Message) / HR=0x$('{0:X8}' -f $_.Exception.InnerException.HResult)"
  }
}

try {
  $mic = [NAudio.Wave.WaveInEvent]::new()
  $mic.WaveFormat = [NAudio.Wave.WaveFormat]::new(48000, 16, 1)
  $mic.StartRecording()
  Start-Sleep -Milliseconds 500
  $mic.StopRecording()
  $mic.Dispose()
  $result.waveIn = 'ok'
} catch {
  $result.waveIn = "fail: $($_.Exception.Message)"
}

[IO.File]::WriteAllText($out, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json
