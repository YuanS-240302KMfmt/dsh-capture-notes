param(
  [string]$DataDir = '',
  [int]$ParentPid = 0,
  [string]$FfmpegPath = '',
  [switch]$Diagnose,
  [string]$PreviewPath = '',
  [string]$PreviewMode = 'live',
  [switch]$PreviewPost,
  [int]$AutoCloseMs = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime-data'
}
$script:dataDir = $DataDir
$script:moduleRoot = Split-Path $PSScriptRoot -Parent
$script:nativeDir = Join-Path $DataDir 'native'
$script:chunksDir = Join-Path $script:nativeDir 'chunks'
$script:audioDir = Join-Path $script:nativeDir 'audio'
$script:startFile = Join-Path $script:nativeDir 'start.json'
$script:stopFile = Join-Path $script:nativeDir 'stop.request'
$script:liveFile = Join-Path $DataDir 'live.json'
$script:quitFile = Join-Path $DataDir 'quit.request'
$script:showFile = Join-Path $DataDir 'show.request'
$script:aliveFile = Join-Path $DataDir 'alive.txt'
$script:pidFile = Join-Path $DataDir 'window.pid'
$script:dataDirError = ''
try {
  New-Item -ItemType Directory -Force -Path $script:nativeDir, $script:chunksDir, $script:audioDir | Out-Null
} catch {
  $script:dataDirError = $_.Exception.Message
}

$script:videoDir = Join-Path $script:nativeDir 'video'
$script:recordFile = Join-Path $script:nativeDir 'record.json'
$script:postRequestFile = Join-Path $script:nativeDir 'post.request'
$script:postResultFile = Join-Path $script:nativeDir 'post.json'
$script:fileRequestFile = Join-Path $script:nativeDir 'file.request'
$script:fileCancelFile = Join-Path $script:nativeDir 'file.cancel'
$script:fileResultFile = Join-Path $script:nativeDir 'file.json'
$script:fileInput = ''
$script:fileProcessing = $false
$script:fileOutDir = ''
$script:fileSubtitleModes = @('soft', 'burn', 'both', 'none')
$script:fileSubtitleLabels = @('软字幕', '硬字幕', '软+硬', '仅字幕')
$script:fileSubtitleIndex = 0
$script:ffmpegPath = $FfmpegPath
$script:ffmpegAvailable = ($FfmpegPath -ne '' -and (Test-Path -LiteralPath $FfmpegPath))
$script:mode = 'live'
$script:ffmpegProc = $null
$script:activeSessionId = ''
$script:captureStartedAt = Get-Date
$script:localWarning = ''
$script:trayEnabled = ($AutoCloseMs -le 0) -and [string]::IsNullOrWhiteSpace($PreviewPath) -and (-not $Diagnose)
$script:allowClose = $false
$script:exitAfterStop = $false
$script:tray = $null
$script:postWaiting = $false
$script:postPromptedFor = ''
$script:lastSessionId = ''

# ---------------------------------------------------------------- NAudio ----
$script:naudioAvailable = $false
$script:naudioError = ''
$naudioPath = Join-Path $PSScriptRoot 'NAudio.dll'
if (Test-Path -LiteralPath $naudioPath) {
  try {
    Add-Type -Path $naudioPath
    $captureCode = @'
using System;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

public sealed class CapturePipeline : IDisposable
{
    public readonly BufferedWaveProvider Buffer;
    public readonly IWaveProvider Pcm;
    public readonly string SourceFormat;
    private readonly WaveFileWriter writer;

    public CapturePipeline(IWaveIn source, string archivePath)
    {
        SourceFormat = source.WaveFormat.ToString();
        Buffer = new BufferedWaveProvider(source.WaveFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(8),
            DiscardOnBufferOverflow = true
        };
        ISampleProvider samples = Buffer.ToSampleProvider();
        if (source.WaveFormat.Channels == 2)
        {
            samples = new StereoToMonoSampleProvider(samples) { LeftVolume = 0.5f, RightVolume = 0.5f };
        }
        if (source.WaveFormat.SampleRate != 16000)
        {
            samples = new WdlResamplingSampleProvider(samples, 16000);
        }
        Pcm = new SampleToWaveProvider16(samples);
        if (!String.IsNullOrEmpty(archivePath))
        {
            writer = new WaveFileWriter(archivePath, source.WaveFormat);
        }
        source.DataAvailable += (sender, args) =>
        {
            try
            {
                Buffer.AddSamples(args.Buffer, 0, args.BytesRecorded);
                if (writer != null) writer.Write(args.Buffer, 0, args.BytesRecorded);
            }
            catch
            {
            }
        };
    }

    public long BufferedBytes { get { return Buffer.BufferedBytes; } }

    public void Dispose()
    {
        try
        {
            if (writer != null)
            {
                writer.Flush();
                writer.Dispose();
            }
        }
        catch
        {
        }
    }
}
'@
    $references = @($naudioPath)
    foreach ($assemblyName in @('netstandard.dll', 'System.Collections.dll', 'System.Threading.dll')) {
      $assemblyPath = Join-Path $PSHOME $assemblyName
      if (Test-Path -LiteralPath $assemblyPath) { $references += $assemblyPath }
    }
    Add-Type -TypeDefinition $captureCode -ReferencedAssemblies $references
    $script:naudioAvailable = $true
  } catch {
    $script:naudioError = $_.Exception.Message
  }
} else {
  $script:naudioError = "NAudio.dll not found at $naudioPath"
}

if ($Diagnose) {
  $devices = @()
  try {
    if ($script:naudioAvailable) {
      for ($i = 0; $i -lt [NAudio.Wave.WaveInEvent]::DeviceCount; $i++) {
        $devices += [NAudio.Wave.WaveInEvent]::GetCapabilities($i).ProductName
      }
    }
  } catch {}
  [pscustomobject]@{
    naudio = $script:naudioAvailable
    error = $script:naudioError
    psVersion = $PSVersionTable.PSVersion.ToString()
    dataDir = $script:dataDir
    dataDirError = $script:dataDirError
    microphoneDevices = $devices
  } | ConvertTo-Json -Compress
  exit 0
}

# ---------------------------------------------------------------- helpers ---
function New-Brush([string]$hex) {
  return [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
}

function Format-Clock([double]$seconds) {
  if ($seconds -lt 0) { $seconds = 0 }
  $total = [int][math]::Round($seconds)
  return ('{0:00}:{1:00}' -f [math]::Floor($total / 60), ($total % 60))
}

function Format-Stamp([double]$seconds) {
  $total = [int][math]::Max(0, [math]::Round($seconds))
  return ('[{0:00}:{1:00}]' -f [math]::Floor($total / 60), ($total % 60))
}

function Set-Status([string]$text, [string]$color = '#8FA6C8') {
  $script:statusText.Text = $text
  $script:statusDot.Fill = New-Brush $color
  if ($null -ne $script:tray) {
    $label = '录屏字幕台 · ' + $text
    if ($label.Length -gt 63) { $label = $label.Substring(0, 63) }
    try { $script:tray.Text = $label } catch {}
  }
}

function Show-CaptureWindow {
  try {
    $script:window.Show()
    if ($script:window.WindowState -eq 'Minimized') { $script:window.WindowState = 'Normal' }
    $script:window.Activate()
  } catch {}
}

function Hide-CaptureWindow {
  try { $script:window.Hide() } catch {}
}

function Exit-CaptureNotes {
  if ($script:capturing) {
    Stop-Session
    $script:exitAfterStop = $true
    Hide-CaptureWindow
    return
  }
  $script:allowClose = $true
  if ($null -ne $script:tray) {
    try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
    $script:tray = $null
  }
  try { $script:window.Close() } catch {}
}

function Show-Error([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { Clear-Error; return }
  $script:errorText.Text = $text
  $script:errorBar.Visibility = 'Visible'
  if ($null -ne $script:micSettingsButton) {
    $isMicError = $text -match '麦克风|waveInOpen|E_ACCESSDENIED|音频设备'
    $script:micSettingsButton.Visibility = $(if ($isMicError) { 'Visible' } else { 'Collapsed' })
  }
}

function Clear-Error {
  $script:errorBar.Visibility = 'Collapsed'
  $script:errorText.Text = ''
  if ($null -ne $script:micSettingsButton) {
    $script:micSettingsButton.Visibility = 'Collapsed'
  }
}

function Set-CapturingUi([bool]$on) {
  $script:systemCheck.IsEnabled = -not $on
  $script:micCheck.IsEnabled = -not $on
  $script:sourceButton.IsEnabled = -not $on
  $script:targetButton.IsEnabled = -not $on
  $script:tabRecord.IsEnabled = -not $on
  $script:startButton.IsEnabled = $true
  if ($on) {
    $script:startButton.Content = '■ 停止'
    $script:startButton.Background = New-Brush '#2A3342'
    $script:startButton.Foreground = New-Brush '#E8EEF9'
  } else {
    $script:startButton.Content = $(if ($script:mode -eq 'record') { '● 录制' } else { '● 开始' })
    $script:startButton.Background = New-Brush '#E5484D'
    $script:startButton.Foreground = New-Brush '#FFFFFF'
  }
}

function Reset-Native {
  foreach ($dir in @($script:chunksDir, $script:audioDir)) {
    if (Test-Path -LiteralPath $dir) {
      Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $script:startFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $script:stopFile -Force -ErrorAction SilentlyContinue
}

function Write-JsonFile([string]$path, $value) {
  $json = $value | ConvertTo-Json -Compress -Depth 6
  [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

# ---------------------------------------------------------------- capture ---
$script:lanes = [ordered]@{}
$script:capturing = $false
$script:waitingStop = $false
$script:readBuffer = New-Object byte[] 6400

function Open-LaneCapture([string]$lane) {
  if ($lane -eq 'mic') {
    $capture = [NAudio.Wave.WaveInEvent]::new()
    try { $capture.WaveFormat = [NAudio.Wave.WaveFormat]::new(48000, 16, 1) } catch {}
    return $capture
  }
  return [NAudio.Wave.WasapiLoopbackCapture]::new()
}

function Flush-Chunks([string]$lane) {
  $state = $script:lanes[$lane]
  if ($null -eq $state) { return }
  while ($state.Pending.Length -ge 16000) {
    $all = $state.Pending.ToArray()
    $chunk = New-Object byte[] 16000
    [System.Array]::Copy($all, 0, $chunk, 0, 16000)
    $state.Seq++
    $dir = Join-Path $script:chunksDir $lane
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $name = 'chunk-{0:D6}.pcm' -f $state.Seq
    $temporary = Join-Path $dir ($name + '.tmp')
    [System.IO.File]::WriteAllBytes($temporary, $chunk)
    Move-Item -LiteralPath $temporary -Destination (Join-Path $dir $name) -Force
    $rest = $all.Length - 16000
    $state.Pending.SetLength(0)
    if ($rest -gt 0) { $state.Pending.Write($all, 16000, $rest) }
  }
}

function Pump-Audio {
  if (-not $script:capturing) { return }
  foreach ($lane in @($script:lanes.Keys)) {
    $state = $script:lanes[$lane]
    try {
      $ratio = [double]$state.Pipeline.Buffer.WaveFormat.AverageBytesPerSecond / 32000.0
      $available = [int][math]::Floor($state.Pipeline.BufferedBytes / $ratio)
      if ($available -ge 2) {
        $count = [math]::Min($script:readBuffer.Length, $available)
        $count -= $count % 2
        $read = $state.Pipeline.Pcm.Read($script:readBuffer, 0, $count)
        if ($read -gt 0) { $state.Pending.Write($script:readBuffer, 0, $read) }
      }
      Flush-Chunks $lane
    } catch {}
  }
}

function Start-Recording {
  New-Item -ItemType Directory -Force -Path $script:videoDir | Out-Null
  Get-ChildItem -LiteralPath $script:videoDir -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $script:recordFile, $script:postResultFile, $script:postRequestFile -Force -ErrorAction SilentlyContinue
  $monitor = $script:monitors[$script:monitorIndex]
  if ($null -eq $monitor) { throw '没有可用的显示器' }
  $bounds = $monitor.Bounds
  $output = Join-Path $script:videoDir 'part-%03d.ts'
  $arguments = @(
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0',
    '-offset_x', [string]$bounds.X, '-offset_y', [string]$bounds.Y,
    '-video_size', ('{0}x{1}' -f $bounds.Width, $bounds.Height),
    '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-an',
    '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', '-reset_timestamps', '1',
    '-y', ('"' + $output + '"')
  )
  $log = Join-Path $script:dataDir 'record.log'
  $script:ffmpegProc = Start-Process -FilePath $script:ffmpegPath -ArgumentList $arguments -RedirectStandardError $log -WindowStyle Hidden -PassThru
  $videoStartedAt = (Get-Date).ToString('o')
  Write-JsonFile $script:recordFile ([pscustomobject]@{
    audioStartedAt = $script:audioStartedAt
    videoStartedAt = $videoStartedAt
  })
  Start-Sleep -Milliseconds 500
  if ($script:ffmpegProc.HasExited) { throw "ffmpeg 已退出，详见 $log" }
}

function Close-AudioLanes {
  foreach ($lane in @($script:lanes.Keys)) {
    $state = $script:lanes[$lane]
    try { $state.Capture.StopRecording() } catch {}
    try { $state.Pipeline.Dispose() } catch {}
    try { $state.Capture.Dispose() } catch {}
  }
  $script:lanes = [ordered]@{}
}

function Start-Session {
  if (-not $script:naudioAvailable) {
    Show-Error "音频组件不可用：$($script:naudioError)"
    return
  }
  if ($script:mode -eq 'record') {
    if (-not $script:ffmpegAvailable) {
      Show-Error "找不到 ffmpeg，无法录制。路径：$($script:ffmpegPath)"
      return
    }
    if (-not (Test-DiskSpace)) { return }
  }
  $requested = @()
  if ($script:systemCheck.IsChecked) { $requested += 'system' }
  if ($script:micCheck.IsChecked) { $requested += 'mic' }
  if ($requested.Count -eq 0) {
    Show-Error '至少选择一路音频（系统音频或麦克风）。'
    return
  }

  Clear-Error
  $script:localWarning = ''
  Reset-Native
  $script:postPanel.Visibility = 'Collapsed'
  $script:lanes = [ordered]@{}
  $failed = @()
  $formats = [ordered]@{}

  foreach ($lane in $requested) {
    $capture = $null
    $pipeline = $null
    try {
      $capture = Open-LaneCapture $lane
      $wav = Join-Path $script:audioDir "$lane.wav"
      $pipeline = [CapturePipeline]::new($capture, $wav)
      $capture.StartRecording()
      $script:lanes[$lane] = [pscustomobject]@{
        Capture = $capture
        Pipeline = $pipeline
        Pending = [System.IO.MemoryStream]::new()
        Seq = 0
      }
      $formats[$lane] = $pipeline.SourceFormat
    } catch {
      $failed += "${lane}: $($_.Exception.Message)"
      if ($null -ne $capture) { try { $capture.Dispose() } catch {} }
    }
  }

  if ($script:lanes.Count -eq 0) {
    $script:localWarning = "无法打开音频设备：" + ($failed -join ' / ') + "。`n请在 Windows「设置 → 隐私和安全性 → 麦克风」中允许桌面应用访问，或关闭占用麦克风的应用。"
    Show-Error $script:localWarning
    $script:systemCheck.IsChecked = $false
    $script:micCheck.IsChecked = $false
    return
  }

  if (-not $script:lanes.Contains('system')) { $script:systemCheck.IsChecked = $false }
  if (-not $script:lanes.Contains('mic')) { $script:micCheck.IsChecked = $false }
  if ($failed.Count -gt 0) {
    $script:localWarning = "部分音频不可用：" + ($failed -join ' / ') + "。已用可用的一路继续；请检查 Windows 麦克风权限后重试。"
    Show-Error $script:localWarning
  }

  $script:audioStartedAt = (Get-Date).ToString('o')
  if ($script:mode -eq 'record') {
    try {
      Start-Recording
    } catch {
      Close-AudioLanes
      Show-Error "录屏启动失败：$($_.Exception.Message)"
      return
    }
  }

  $request = [pscustomobject]@{
    version = 1
    mode = $script:mode
    lanes = @($script:lanes.Keys)
    language = $script:sourceCodes[$script:sourceIndex]
    target = $script:targetCodes[$script:targetIndex]
    provider = 'auto'
    formats = $formats
    startedAt = $script:audioStartedAt
  }
  Write-JsonFile $script:startFile $request

  $script:activeSessionId = ''
  $script:captureStartedAt = Get-Date
  $script:capturing = $true
  $script:waitingStop = $false
  $script:flushTimer.Start()
  Set-CapturingUi $true
  if ($script:mode -eq 'record') {
    Set-Status '录制中 · 画面 + 音频' '#E5484D'
  } else {
    Set-Status '正在聆听…' '#6FCF97'
  }
}

function Stop-Session {
  if (-not $script:capturing) { return }
  $script:capturing = $false
  $script:waitingStop = $true
  $script:flushTimer.Stop()

  if ($null -ne $script:ffmpegProc) {
    try {
      if (-not $script:ffmpegProc.HasExited) { $script:ffmpegProc.Kill() }
      $script:ffmpegProc.WaitForExit(5000) | Out-Null
    } catch {}
    $script:ffmpegProc = $null
  }

  foreach ($lane in @($script:lanes.Keys)) {
    try { $script:lanes[$lane].Capture.StopRecording() } catch {}
  }
  Start-Sleep -Milliseconds 250
  foreach ($lane in @($script:lanes.Keys)) {
    $state = $script:lanes[$lane]
    try { $state.Pipeline.Dispose() } catch {}
    try { $state.Capture.Dispose() } catch {}
    if ($state.Pending.Length -ge 3200) {
      $bytes = $state.Pending.ToArray()
      $state.Seq++
      $dir = Join-Path $script:chunksDir $lane
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      [System.IO.File]::WriteAllBytes((Join-Path $dir ('chunk-{0:D6}.pcm' -f $state.Seq)), $bytes)
    }
    $state.Pending.SetLength(0)
  }
  [System.IO.File]::WriteAllText($script:stopFile, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
  Set-CapturingUi $true
  $script:startButton.Content = '收尾中…'
  $script:startButton.IsEnabled = $false
  Set-Status '收尾中…' '#F2C94C'
}

# ---------------------------------------------------------------- snapshot --
$script:lastSignature = ''
$script:sourceCodes = @('auto', 'zh', 'en', 'ja', 'ko', 'yue')
$script:sourceLabels = @('自动', '中文', 'English', '日本語', '한국어', '粤语')
$script:targetCodes = @('zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru')
$script:targetLabels = @('简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский')
$script:sourceIndex = 0
$script:targetIndex = 0

function New-Badge([string]$lane) {
  $badge = [System.Windows.Controls.Border]::new()
  $badge.CornerRadius = [System.Windows.CornerRadius]::new(4)
  $badge.Padding = [System.Windows.Thickness]::new(6, 1, 6, 1)
  $badge.Margin = [System.Windows.Thickness]::new(0, 0, 8, 0)
  $badge.VerticalAlignment = 'Center'
  if ($lane -eq 'mic') {
    $badge.Background = New-Brush '#4A3320'
    $text = [System.Windows.Controls.TextBlock]::new()
    $text.Text = '麦克风'
    $text.Foreground = New-Brush '#F0A35E'
  } else {
    $badge.Background = New-Brush '#1E3A5F'
    $text = [System.Windows.Controls.TextBlock]::new()
    $text.Text = '系统'
    $text.Foreground = New-Brush '#6EA8FE'
  }
  $text.FontSize = 10.5
  $badge.Child = $text
  return $badge
}

function New-SegmentRow($segment) {
  $row = [System.Windows.Controls.Border]::new()
  $row.Background = New-Brush '#1A2230'
  $row.CornerRadius = [System.Windows.CornerRadius]::new(8)
  $row.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
  $row.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)

  $stack = [System.Windows.Controls.StackPanel]::new()
  $head = [System.Windows.Controls.StackPanel]::new()
  $head.Orientation = 'Horizontal'
  [void]$head.Children.Add((New-Badge $segment.lane))

  $stamp = [System.Windows.Controls.TextBlock]::new()
  $stamp.Text = (Format-Stamp ([double]$segment.start))
  $stamp.Foreground = New-Brush '#5B6B8C'
  $stamp.FontSize = 10.5
  $stamp.VerticalAlignment = 'Center'
  [void]$head.Children.Add($stamp)

  $body = [System.Windows.Controls.TextBlock]::new()
  $body.Text = [string]$segment.text
  $body.Foreground = New-Brush '#E8EEF9'
  $body.FontSize = 13
  $body.TextWrapping = 'Wrap'
  $body.Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)

  [void]$stack.Children.Add($head)
  [void]$stack.Children.Add($body)

  $translation = [string]$segment.translation
  $state = [string]$segment.state
  if ($translation -ne '' -and $translation -ne [string]$segment.text) {
    $trans = [System.Windows.Controls.TextBlock]::new()
    $trans.Text = $translation
    $trans.Foreground = New-Brush '#8FA6C8'
    $trans.FontSize = 12
    $trans.TextWrapping = 'Wrap'
    $trans.Margin = [System.Windows.Thickness]::new(0, 2, 0, 0)
    [void]$stack.Children.Add($trans)
  } elseif ($state -eq 'pending') {
    $trans = [System.Windows.Controls.TextBlock]::new()
    $trans.Text = '翻译中…'
    $trans.Foreground = New-Brush '#5B6B8C'
    $trans.FontSize = 12
    $trans.Margin = [System.Windows.Thickness]::new(0, 2, 0, 0)
    [void]$stack.Children.Add($trans)
  } elseif ($state -eq 'error') {
    $trans = [System.Windows.Controls.TextBlock]::new()
    $trans.Text = '翻译失败（保留原文）'
    $trans.Foreground = New-Brush '#C97A7A'
    $trans.FontSize = 12
    $trans.Margin = [System.Windows.Thickness]::new(0, 2, 0, 0)
    [void]$stack.Children.Add($trans)
  }

  $row.Child = $stack
  return $row
}

function New-PartialRow([string]$lane, [string]$text) {
  $row = [System.Windows.Controls.Border]::new()
  $row.Background = New-Brush '#151C28'
  $row.CornerRadius = [System.Windows.CornerRadius]::new(8)
  $row.Padding = [System.Windows.Thickness]::new(10, 6, 10, 6)
  $row.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
  $row.Opacity = 0.9
  $stack = [System.Windows.Controls.StackPanel]::new()
  $head = [System.Windows.Controls.StackPanel]::new()
  $head.Orientation = 'Horizontal'
  [void]$head.Children.Add((New-Badge $lane))
  $body = [System.Windows.Controls.TextBlock]::new()
  $body.Text = $text
  $body.Foreground = New-Brush '#7C8AA5'
  $body.FontSize = 12.5
  $body.FontStyle = [System.Windows.FontStyles]::Italic
  $body.TextWrapping = 'Wrap'
  $body.Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)
  [void]$stack.Children.Add($head)
  [void]$stack.Children.Add($body)
  $row.Child = $stack
  return $row
}

function Render-Snapshot($snapshot) {
  if ($script:mode -eq 'file') { return }
  $parts = @()
  foreach ($segment in @($snapshot.segments)) {
    $parts += "$($segment.id):$($segment.state):$($segment.translation)"
  }
  if ($null -ne $snapshot.lanes) {
    foreach ($property in $snapshot.lanes.PSObject.Properties) {
      if ($property.Value.partial) { $parts += "p:$($property.Name):$($property.Value.partial)" }
    }
  }
  $signature = "$($snapshot.status)|" + ($parts -join '|')
  if ($signature -eq $script:lastSignature) { return }
  $script:lastSignature = $signature

  $panel = $script:subtitlePanel
  $panel.Children.Clear()

  $segments = @($snapshot.segments)
  if ($segments.Count -eq 0) {
    $hint = [System.Windows.Controls.TextBlock]::new()
    $hint.Text = '点「开始」，字幕会出现在这里。'
    $hint.Foreground = New-Brush '#4E5B73'
    $hint.FontSize = 12.5
    $hint.Margin = [System.Windows.Thickness]::new(4, 12, 0, 0)
    [void]$panel.Children.Add($hint)
  } else {
    foreach ($segment in $segments) { [void]$panel.Children.Add((New-SegmentRow $segment)) }
  }

  if ($null -ne $snapshot.lanes) {
    foreach ($property in $snapshot.lanes.PSObject.Properties) {
      if ($property.Value.partial) {
        [void]$panel.Children.Add((New-PartialRow $property.Name ([string]$property.Value.partial)))
      }
    }
  }

  $script:subtitleScroll.ScrollToEnd()
}

function Update-FromSnapshot {
  if ($script:mode -eq 'file') { return }
  if (-not (Test-Path -LiteralPath $script:liveFile)) { return }
  $snapshot = $null
  try { $snapshot = Get-Content -LiteralPath $script:liveFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return }
  if ($null -eq $snapshot) { return }

  $status = [string]$snapshot.status
  $snapshotId = [string]$snapshot.sessionId
  if ($script:capturing -and ($status -eq 'starting' -or $status -eq 'listening') -and -not [string]::IsNullOrWhiteSpace($snapshotId)) {
    $script:activeSessionId = $snapshotId
  }
  if (-not [string]::IsNullOrWhiteSpace($snapshotId)) {
    $script:lastSessionId = $snapshotId
  }
  if (($status -eq 'stopped' -or $status -eq 'error') -and $script:capturing) {
    $age = ((Get-Date) - $script:captureStartedAt).TotalSeconds
    $stale = $false
    if (-not [string]::IsNullOrWhiteSpace($script:activeSessionId) -and -not [string]::IsNullOrWhiteSpace($snapshotId)) {
      $stale = ($snapshotId -ne $script:activeSessionId)
    }
    $grace = ([string]::IsNullOrWhiteSpace($script:activeSessionId) -and $age -lt 5)
    if (-not $stale -and -not $grace) {
      Stop-Session
    }
  }
  $laneNames = @()
  if ($null -ne $snapshot.lanes) {
    foreach ($property in $snapshot.lanes.PSObject.Properties) {
      if ($property.Value.active) {
        $laneNames += $(if ($property.Name -eq 'mic') { '麦克风' } else { '系统' })
      }
    }
  }

  switch ($status) {
    'idle' { Set-Status '等待开始' '#5B6B8C' }
    'starting' { Set-Status '正在加载识别模型…' '#F2C94C' }
    'listening' {
      if ([string]$snapshot.mode -eq 'record') {
        Set-Status ("录制中 · 画面 + " + ($laneNames -join ' + ')) '#E5484D'
      } else {
        Set-Status ("正在聆听 · " + ($laneNames -join ' + ')) '#6FCF97'
      }
    }
    'stopping' { Set-Status '收尾中…' '#F2C94C' }
    'stopped' {
      Set-Status ("已保存 · " + [string]$snapshot.sessionId) '#6FCF97'
      if ($script:waitingStop) {
        $script:waitingStop = $false
        Set-CapturingUi $false
      }
      if ([string]$snapshot.mode -eq 'record') {
        if ($snapshot.video -and $script:postPromptedFor -ne [string]$snapshot.sessionId) {
          $script:postPromptedFor = [string]$snapshot.sessionId
          $autoPost = [string]$env:CAPTURE_NOTES_AUTOPOST
          if ($autoPost -in @('soft', 'burn', 'srt')) { Request-Post $autoPost } else { Show-PostPrompt }
        } elseif (-not $snapshot.video) {
          Show-Error ('录屏封装失败：' + [string]$snapshot.videoError)
        }
      }
    }
    'error' { Set-Status '出错了' '#EB5757' }
    default { Set-Status '等待 Host…' '#5B6B8C' }
  }

  if ($status -eq 'error') {
    Show-Error ([string]$snapshot.error)
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$snapshot.videoError)) {
    Show-Error ('录屏封装失败：' + [string]$snapshot.videoError)
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$snapshot.error)) {
    Show-Error ([string]$snapshot.error)
  } elseif (-not [string]::IsNullOrWhiteSpace($script:localWarning)) {
    Show-Error $script:localWarning
  } else {
    Clear-Error
  }

  $script:elapsedText.Text = Format-Clock ([double]$snapshot.elapsedMs / 1000)
  Render-Snapshot $snapshot
}

# --------------------------------------------------------------------- UI ---
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="录屏字幕台" Width="660" Height="480"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        WindowStartupLocation="CenterScreen" ResizeMode="CanResizeWithGrip"
        MinWidth="620" MinHeight="420" SnapsToDevicePixels="True" UseLayoutRounding="True">
  <Border CornerRadius="12" Background="#151A23" BorderBrush="#2A3342" BorderThickness="1">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="46"/>
        <RowDefinition Height="1"/>
        <RowDefinition Height="44"/>
        <RowDefinition Height="56"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="30"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <Grid x:Name="Header" Grid.Row="0" Background="Transparent">
        <StackPanel Orientation="Horizontal" Margin="16,0,0,0" VerticalAlignment="Center">
          <Ellipse Width="9" Height="9" Fill="#E5484D" Margin="0,0,8,0" VerticalAlignment="Center"/>
          <TextBlock Text="录屏字幕台" Foreground="#E8EEF9" FontSize="15" FontWeight="SemiBold" VerticalAlignment="Center"/>
          <Border Background="#1F2938" CornerRadius="9" Padding="8,2" Margin="10,0,0,0" VerticalAlignment="Center">
            <TextBlock x:Name="ModeHint" Text="实时" Foreground="#8FA6C8" FontSize="11"/>
          </Border>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,0,10,0" VerticalAlignment="Center">
          <Button x:Name="PinButton" Content="📌" FontSize="12" Padding="8,3" Background="Transparent" Foreground="#7C8AA5" BorderThickness="0" Cursor="Hand" ToolTip="置顶"/>
          <Button x:Name="CloseButton" Content="✕" FontSize="13" Padding="10,3" Background="Transparent" Foreground="#7C8AA5" BorderThickness="0" Cursor="Hand" ToolTip="关闭"/>
        </StackPanel>
      </Grid>

      <Border Grid.Row="1" Background="#232C3B"/>

      <StackPanel Grid.Row="2" Orientation="Horizontal" Margin="16,0,0,0" VerticalAlignment="Center">
        <Button x:Name="TabLive" Content="实时" Background="#222B3A" Foreground="#E8EEF9" BorderThickness="0" Padding="14,6" Cursor="Hand"/>
        <Button x:Name="TabRecord" Content="录屏" Background="Transparent" Foreground="#8FA6C8" BorderThickness="0" Padding="14,6" Cursor="Hand"/>
        <Button x:Name="TabFile" Content="文件" Background="Transparent" Foreground="#8FA6C8" BorderThickness="0" Padding="14,6" Cursor="Hand"/>
      </StackPanel>

      <Grid Grid.Row="3" Margin="16,4,16,8">
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <CheckBox x:Name="SystemCheck" Content="系统音频" IsChecked="True" Foreground="#C9D6EA" VerticalContentAlignment="Center"/>
          <CheckBox x:Name="MicCheck" Content="麦克风" Margin="14,0,0,0" Foreground="#C9D6EA" VerticalContentAlignment="Center"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <Button x:Name="FileButton" Content="选择文件" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Visibility="Collapsed" Cursor="Hand" ToolTip="选择本地视频或音频"/>
          <Button x:Name="SubtitleButton" Content="软字幕" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Visibility="Collapsed" Cursor="Hand" ToolTip="字幕形态"/>
          <Button x:Name="RecentButton" Content="最近" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Visibility="Collapsed" Cursor="Hand" ToolTip="最近会话"/>
          <Button x:Name="MonitorButton" Content="显示器 1" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Visibility="Collapsed" Cursor="Hand" ToolTip="录制哪个显示器"/>
          <Button x:Name="SourceButton" Content="自动" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Cursor="Hand" ToolTip="源语言"/>
          <Button x:Name="TargetButton" Content="简体中文" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Cursor="Hand" ToolTip="目标语言"/>
          <Button x:Name="FileOpen" Content="打开目录" Background="#2A3342" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" Margin="0,0,8,0" Visibility="Collapsed" Cursor="Hand" ToolTip="打开输出目录"/>
          <Button x:Name="StartButton" Content="● 开始" Background="#E5484D" Foreground="#FFFFFF" BorderThickness="0" Padding="16,6" FontWeight="SemiBold" Cursor="Hand"/>
        </StackPanel>
      </Grid>

      <Border Grid.Row="4" Margin="16,0,16,8" Background="#10151D" BorderBrush="#232C3B" BorderThickness="1" CornerRadius="10">
        <ScrollViewer x:Name="SubtitleScroll" VerticalScrollBarVisibility="Auto" Padding="12,10">
          <StackPanel x:Name="SubtitlePanel"/>
        </ScrollViewer>
      </Border>

      <Border x:Name="PostPanel" Grid.Row="4" Margin="16,0,16,8" Background="#FF0E131B" BorderBrush="#33405A" BorderThickness="1" CornerRadius="10" Visibility="Collapsed">
        <StackPanel VerticalAlignment="Center" Margin="24,18">
          <TextBlock x:Name="PostTitle" Text="这段录屏要加字幕吗？" Foreground="#E8EEF9" FontSize="15" FontWeight="SemiBold"/>
          <TextBlock x:Name="PostHint" Text="基于本次会话的逐字稿生成，默认双语。软字幕几秒完成；硬字幕需要重编码。" Foreground="#8FA6C8" FontSize="11.5" TextWrapping="Wrap" Margin="0,6,0,0"/>
          <StackPanel x:Name="PostButtons" Orientation="Horizontal" Margin="0,14,0,0">
            <Button x:Name="PostSoft" Content="软字幕" Background="#2A3342" Foreground="#E8EEF9" BorderThickness="0" Padding="14,6" Margin="0,0,8,0" Cursor="Hand"/>
            <Button x:Name="PostBurn" Content="硬字幕" Background="#2A3342" Foreground="#E8EEF9" BorderThickness="0" Padding="14,6" Margin="0,0,8,0" Cursor="Hand"/>
            <Button x:Name="PostSrt" Content="仅字幕文件" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="14,6" Margin="0,0,8,0" Cursor="Hand"/>
            <Button x:Name="PostNone" Content="不用了" Background="Transparent" Foreground="#7C8AA5" BorderThickness="0" Padding="14,6" Cursor="Hand"/>
          </StackPanel>
          <TextBlock x:Name="PostProgress" Foreground="#F2C94C" FontSize="11.5" Margin="0,10,0,0" TextWrapping="Wrap" Visibility="Collapsed"/>
          <Button x:Name="PostOpen" Content="打开文件夹" Background="#222B3A" Foreground="#C9D6EA" BorderThickness="0" Padding="12,6" HorizontalAlignment="Left" Margin="0,10,0,0" Cursor="Hand" Visibility="Collapsed"/>
        </StackPanel>
      </Border>

      <Grid Grid.Row="5" Margin="16,0,16,6">
        <StackPanel Orientation="Horizontal">
          <Ellipse x:Name="StatusDot" Width="7" Height="7" Fill="#5B6B8C" Margin="0,0,8,0" VerticalAlignment="Center"/>
          <TextBlock x:Name="StatusText" Text="等待开始" Foreground="#8FA6C8" FontSize="12"/>
        </StackPanel>
        <TextBlock x:Name="ElapsedText" Text="00:00" HorizontalAlignment="Right" Foreground="#5B6B8C" FontSize="12"/>
      </Grid>

      <Border x:Name="ErrorBar" Grid.Row="6" Background="#3A1D22" Padding="16,6" Visibility="Collapsed">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="ErrorText" Foreground="#FF9AA2" FontSize="11" TextWrapping="Wrap"/>
          <Button x:Name="MicSettingsButton" Grid.Column="1" Content="打开麦克风设置" Background="#4A2630" Foreground="#FFD1D6" BorderThickness="0" Padding="8,2" Margin="8,0,0,0" FontSize="11" Cursor="Hand" Visibility="Collapsed"/>
        </Grid>
      </Border>
    </Grid>
  </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$window.FontFamily = [System.Windows.Media.FontFamily]::new('Microsoft YaHei UI')
$script:window = $window

$script:header = $window.FindName('Header')
$script:pinButton = $window.FindName('PinButton')
$script:closeButton = $window.FindName('CloseButton')
$script:tabLive = $window.FindName('TabLive')
$script:tabRecord = $window.FindName('TabRecord')
$script:tabFile = $window.FindName('TabFile')
$script:systemCheck = $window.FindName('SystemCheck')
$script:micCheck = $window.FindName('MicCheck')
$script:sourceButton = $window.FindName('SourceButton')
$script:targetButton = $window.FindName('TargetButton')
$script:startButton = $window.FindName('StartButton')
$script:subtitleScroll = $window.FindName('SubtitleScroll')
$script:subtitlePanel = $window.FindName('SubtitlePanel')
$script:statusDot = $window.FindName('StatusDot')
$script:statusText = $window.FindName('StatusText')
$script:elapsedText = $window.FindName('ElapsedText')
$script:errorBar = $window.FindName('ErrorBar')
$script:errorText = $window.FindName('ErrorText')
$script:micSettingsButton = $window.FindName('MicSettingsButton')
$script:modeHint = $window.FindName('ModeHint')
$script:monitorButton = $window.FindName('MonitorButton')
$script:fileButton = $window.FindName('FileButton')
$script:subtitleButton = $window.FindName('SubtitleButton')
$script:recentButton = $window.FindName('RecentButton')
$script:fileOpen = $window.FindName('FileOpen')
$script:postPanel = $window.FindName('PostPanel')
$script:postTitle = $window.FindName('PostTitle')
$script:postHint = $window.FindName('PostHint')
$script:postButtons = $window.FindName('PostButtons')
$script:postSoft = $window.FindName('PostSoft')
$script:postBurn = $window.FindName('PostBurn')
$script:postSrt = $window.FindName('PostSrt')
$script:postNone = $window.FindName('PostNone')
$script:postProgress = $window.FindName('PostProgress')
$script:postOpen = $window.FindName('PostOpen')

if ($script:trayEnabled) {
  try {
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = [System.Drawing.SystemIcons]::Application
    $tray.Text = '录屏字幕台'
    $tray.Visible = $true
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $showItem = New-Object System.Windows.Forms.ToolStripMenuItem('显示窗口')
    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
    $showItem.Add_Click({ Show-CaptureWindow })
    $exitItem.Add_Click({ Exit-CaptureNotes })
    [void]$menu.Items.Add($showItem)
    [void]$menu.Items.Add($exitItem)
    $tray.ContextMenuStrip = $menu
    $tray.add_DoubleClick({ Show-CaptureWindow })
    $script:tray = $tray
  } catch {
    $script:tray = $null
    Show-Error ("托盘初始化失败：" + $_.Exception.Message)
  }
}

$script:monitors = @()
$script:monitorLabels = @()
$script:monitorIndex = 0
try {
  $monitorNumber = 1
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $script:monitors += $screen
    $script:monitorLabels += ('显示器 {0} · {1}×{2}' -f $monitorNumber, $screen.Bounds.Width, $screen.Bounds.Height)
    $monitorNumber++
  }
  $primaryIndex = 0
  for ($i = 0; $i -lt $script:monitors.Count; $i++) {
    if ($script:monitors[$i].Primary) { $primaryIndex = $i; break }
  }
  if ($script:monitors.Count -gt 0) {
    $script:monitorIndex = $primaryIndex
    $script:monitorButton.Content = $script:monitorLabels[$script:monitorIndex]
  }
} catch {
  Show-Error "无法枚举显示器：$($_.Exception.Message)"
}

function Get-ModeLabel {
  switch ($script:mode) {
    'record' { return '录屏' }
    'file' { return '文件' }
    default { return '实时' }
  }
}

function Set-FileUi([bool]$on) {
  if ($on) {
    $script:startButton.Content = '取消'
    $script:startButton.Background = New-Brush '#2A3342'
    $script:startButton.Foreground = New-Brush '#E8EEF9'
  } else {
    $script:startButton.Content = '● 开始处理'
    $script:startButton.Background = New-Brush '#E5484D'
    $script:startButton.Foreground = New-Brush '#FFFFFF'
  }
  $script:fileButton.IsHitTestVisible = -not $on
  $script:subtitleButton.IsHitTestVisible = -not $on
  $script:sourceButton.IsHitTestVisible = -not $on
  $script:fileButton.Opacity = $(if ($on) { 0.6 } else { 1 })
  $script:subtitleButton.Opacity = $(if ($on) { 0.6 } else { 1 })
  $script:tabLive.IsEnabled = -not $on
  $script:tabRecord.IsEnabled = -not $on
}

function Get-TranslationState([string]$dir) {
  if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { return '未生成' }
  try {
    $manifest = Get-Content -LiteralPath (Join-Path $dir 'session.json') -Raw | ConvertFrom-Json
    $applied = @($manifest.artifacts.translations | Where-Object { $_.state -eq 'applied' }).Count
    if ($applied -gt 0) { return '已应用' }
  } catch {}
  $files = @(Get-ChildItem -LiteralPath $dir -File -Filter 'translation.*.json' -ErrorAction SilentlyContinue)
  if ($files.Count -gt 0) { return '已生成' }
  return '未生成'
}

function Get-RecentSessions {
  $items = @()
  foreach ($root in @((Join-Path $script:moduleRoot 'sessions'), (Join-Path $script:moduleRoot 'out'))) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($dir in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
      $manifestPath = Join-Path $dir.FullName 'session.json'
      if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
      try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { continue }
      $modeLabel = switch ([string]$manifest.mode) { 'live' { '实时' } 'record' { '录屏' } 'file' { '文件' } default { [string]$manifest.mode } }
      $name = $dir.Name
      if ($name.Length -gt 42) { $name = $name.Substring(0, 42) + '…' }
      $items += [pscustomobject]@{
        Path = $dir.FullName
        Mode = [string]$manifest.mode
        Id = [string]$manifest.id
        Label = ('{0} · {1} · {2}' -f $modeLabel, $dir.LastWriteTime.ToString('MM-dd HH:mm'), $name)
        Time = $dir.LastWriteTime
      }
    }
  }
  return @($items | Sort-Object Time -Descending | Select-Object -First 10)
}

function Show-RecentMenu {
  $items = @(Get-RecentSessions)
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  if ($items.Count -eq 0) {
    $empty = New-Object System.Windows.Forms.ToolStripMenuItem('暂无会话')
    $empty.Enabled = $false
    [void]$menu.Items.Add($empty)
  } else {
    foreach ($item in $items) {
      $entry = New-Object System.Windows.Forms.ToolStripMenuItem($item.Label)
      $entry.Tag = $item
      $entry.Add_Click({
        param($sender, $eventArgs)
        try { Start-Process explorer.exe -ArgumentList ('"' + [string]$sender.Tag.Path + '"') } catch {}
      })
      if ($item.Mode -eq 'record') {
        foreach ($mode in @(
          @{ Label = '重跑软字幕'; Value = 'soft' },
          @{ Label = '重跑硬字幕'; Value = 'burn' },
          @{ Label = '仅字幕文件'; Value = 'srt' }
        )) {
          $child = New-Object System.Windows.Forms.ToolStripMenuItem($mode.Label)
          $child.Tag = [pscustomobject]@{ Id = $item.Id; Mode = $mode.Value }
          $child.Add_Click({
            param($sender, $eventArgs)
            $tag = $sender.Tag
            $request = [pscustomobject]@{ sessionId = $tag.Id; mode = $tag.Mode }
            Write-JsonFile $script:postRequestFile $request
            Set-Status '已请求后处理…' '#F2C94C'
          })
          [void]$entry.DropDownItems.Add($child)
        }
      }
      [void]$menu.Items.Add($entry)
    }
  }
  $menu.Show($script:recentButton, 0, $script:recentButton.ActualHeight)
}

function Format-FileName([string]$name) {
  if ($name.Length -le 22) { return $name }
  return $name.Substring(0, 20) + '…'
}

function Show-FileHint {
  $panel = $script:subtitlePanel
  $panel.Children.Clear()
  $hint = [System.Windows.Controls.TextBlock]::new()
  $hint.Text = '选择文件后点「开始处理」；逐字稿、字幕与成片会写到 out\<slug>\。'
  $hint.Foreground = New-Brush '#4E5B73'
  $hint.FontSize = 12.5
  $hint.TextWrapping = 'Wrap'
  $hint.Margin = [System.Windows.Thickness]::new(4, 12, 0, 0)
  [void]$panel.Children.Add($hint)
  $script:lastSignature = 'file'
}

function Switch-Mode([string]$mode) {
  if ($script:capturing -or $script:waitingStop -or $script:fileProcessing) { return }
  $script:mode = $mode
  $liveActive = $mode -eq 'live'
  $recordActive = $mode -eq 'record'
  $fileActive = $mode -eq 'file'
  $script:tabLive.Background = New-Brush $(if ($liveActive) { '#222B3A' } else { 'Transparent' })
  $script:tabLive.Foreground = New-Brush $(if ($liveActive) { '#E8EEF9' } else { '#8FA6C8' })
  $script:tabRecord.Background = New-Brush $(if ($recordActive) { '#222B3A' } else { 'Transparent' })
  $script:tabRecord.Foreground = New-Brush $(if ($recordActive) { '#E8EEF9' } else { '#8FA6C8' })
  $script:tabFile.Background = New-Brush $(if ($fileActive) { '#222B3A' } else { 'Transparent' })
  $script:tabFile.Foreground = New-Brush $(if ($fileActive) { '#E8EEF9' } else { '#8FA6C8' })
  $script:monitorButton.Visibility = $(if ($recordActive) { 'Visible' } else { 'Collapsed' })
  $script:fileButton.Visibility = $(if ($fileActive) { 'Visible' } else { 'Collapsed' })
  $script:subtitleButton.Visibility = $(if ($fileActive) { 'Visible' } else { 'Collapsed' })
  $script:recentButton.Visibility = $(if ($fileActive) { 'Visible' } else { 'Collapsed' })
  $script:systemCheck.Visibility = $(if ($fileActive) { 'Collapsed' } else { 'Visible' })
  $script:micCheck.Visibility = $(if ($fileActive) { 'Collapsed' } else { 'Visible' })
  $script:fileOpen.Visibility = 'Collapsed'
  $script:startButton.Background = New-Brush '#E5484D'
  $script:startButton.Foreground = New-Brush '#FFFFFF'
  if ($fileActive) {
    $script:startButton.Content = '● 开始处理'
    $script:subtitleButton.Content = $script:fileSubtitleLabels[$script:fileSubtitleIndex]
    $script:elapsedText.Text = ''
    Show-FileHint
  } else {
    $script:elapsedText.Text = '00:00'
    $script:startButton.Content = $(if ($recordActive) { '● 录制' } else { '● 开始' })
  }
  $script:modeHint.Text = (Get-ModeLabel) + ' · ' + $script:sourceLabels[$script:sourceIndex] + ' → ' + $script:targetLabels[$script:targetIndex]
  $script:postPanel.Visibility = 'Collapsed'
  Set-Status '等待开始' '#5B6B8C'
}

function Test-DiskSpace {
  try {
    $root = [System.IO.Path]::GetPathRoot($script:dataDir)
    $drive = [System.IO.DriveInfo]::new($root)
    if ($drive.AvailableFreeSpace -lt 2GB) {
      Show-Error ('磁盘剩余空间不足：{0:N1} GB，录制至少需要 2 GB。' -f ($drive.AvailableFreeSpace / 1GB))
      return $false
    }
  } catch {}
  return $true
}

function Select-File {
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = '选择视频或音频'
  $dialog.Filter = '媒体文件|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.mp3;*.wav;*.m4a;*.flac|所有文件|*.*'
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
  $script:fileInput = $dialog.FileName
  $script:fileButton.Content = Format-FileName ([System.IO.Path]::GetFileName($dialog.FileName))
  $script:fileOutDir = ''
  $script:fileOpen.Visibility = 'Collapsed'
  Clear-Error
  Set-Status ('已选择 · ' + [System.IO.Path]::GetFileName($dialog.FileName)) '#8FA6C8'
}

function Start-FileJob {
  if ($script:fileProcessing) {
    [System.IO.File]::WriteAllText($script:fileCancelFile, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
    Set-Status '正在取消…' '#F2C94C'
    return
  }
  if ([string]::IsNullOrWhiteSpace($script:fileInput)) {
    Select-File
    if ([string]::IsNullOrWhiteSpace($script:fileInput)) { return }
  }
  Clear-Error
  Remove-Item -LiteralPath $script:fileResultFile, $script:fileRequestFile, $script:fileCancelFile -Force -ErrorAction SilentlyContinue
  $request = [pscustomobject]@{
    input = $script:fileInput
    language = $script:sourceCodes[$script:sourceIndex]
    subtitle = $script:fileSubtitleModes[$script:fileSubtitleIndex]
    font = 'Microsoft YaHei'
    margin = 5
  }
  Write-JsonFile $script:fileRequestFile $request
  $script:fileProcessing = $true
  $script:fileOutDir = ''
  Set-FileUi $true
  Set-Status '正在处理文件…' '#F2C94C'
}

function Update-FileState {
  if (-not $script:fileProcessing) { return }
  if (-not (Test-Path -LiteralPath $script:fileResultFile)) { return }
  $state = $null
  try { $state = Get-Content -LiteralPath $script:fileResultFile -Raw | ConvertFrom-Json } catch { return }
  if ($null -eq $state) { return }
  if ($state.status -eq 'running') {
    $percent = 0
    [void][int]::TryParse([string]$state.percent, [ref]$percent)
    Set-Status (([string]$state.stage) + ' · ' + $percent + '%') '#F2C94C'
    return
  }
  $script:fileProcessing = $false
  if ($state.status -eq 'done') {
    $script:fileOutDir = [string]$state.outDir
    Set-FileUi $false
    $translationState = Get-TranslationState $script:fileOutDir
    $kind = [string]$state.result.mediaKind
    $kindText = $(if ($kind -eq 'audio') { ' · 音频（无视频）' } else { '' })
    Set-Status ('完成 · ' + [System.IO.Path]::GetFileName($script:fileOutDir) + $kindText + ' · 译文' + $translationState) '#6FCF97'
    $script:fileOpen.Visibility = 'Visible'
    $script:fileOpen.Tag = $script:fileOutDir
  } elseif ($state.status -eq 'cancelled') {
    Set-FileUi $false
    Set-Status '已取消' '#8FA6C8'
  } else {
    Set-FileUi $false
    Set-Status '文件处理失败' '#EB5757'
    Show-Error ([string]$state.error)
  }
}

function Show-PostPrompt {
  $script:postPanel.Visibility = 'Visible'
  $script:postTitle.Text = '这段录屏要加字幕吗？'
  $script:postHint.Text = '基于本次会话的逐字稿生成，默认双语。软字幕几秒完成；硬字幕需要重编码。'
  $script:postButtons.Visibility = 'Visible'
  $script:postProgress.Visibility = 'Collapsed'
  $script:postOpen.Visibility = 'Collapsed'
}

function Request-Post([string]$postMode) {
  if ([string]::IsNullOrWhiteSpace($script:lastSessionId)) {
    Show-Error '找不到本次会话，无法生成字幕。'
    return
  }
  $script:postWaiting = $true
  $script:postPanel.Visibility = 'Collapsed'
  Set-Status '正在生成字幕…' '#F2C94C'
  Write-JsonFile $script:postRequestFile ([pscustomobject]@{ sessionId = $script:lastSessionId; mode = $postMode })
}

function Update-PostState {
  if (-not $script:postWaiting) { return }
  if (-not (Test-Path -LiteralPath $script:postResultFile)) { return }
  $post = $null
  try { $post = Get-Content -LiteralPath $script:postResultFile -Raw | ConvertFrom-Json } catch { return }
  if ($null -eq $post) { return }
  if ($post.status -eq 'running') {
    Set-Status ('正在生成字幕…（' + [string]$post.mode + '）') '#F2C94C'
    return
  }
  $script:postWaiting = $false
  if ($post.status -eq 'done') {
    Set-Status ('字幕完成 · ' + [string]$post.outputName) '#6FCF97'
    $script:postPanel.Visibility = 'Visible'
    $script:postTitle.Text = '字幕已生成'
    $script:postHint.Text = [string]$post.output
    $script:postButtons.Visibility = 'Collapsed'
    $script:postProgress.Visibility = 'Collapsed'
    $script:postOpen.Visibility = 'Visible'
    $script:postOpen.Tag = [string]$post.output
  } elseif ($post.status -eq 'error') {
    Set-Status '字幕生成失败' '#EB5757'
    Show-Error ([string]$post.error)
    $script:postPanel.Visibility = 'Visible'
    $script:postTitle.Text = '字幕生成失败'
    $script:postHint.Text = [string]$post.error
    $script:postButtons.Visibility = 'Collapsed'
    $script:postProgress.Visibility = 'Collapsed'
  }
}

$script:tabLive.Add_Click({ Switch-Mode 'live' })
$script:tabRecord.Add_Click({ Switch-Mode 'record' })
$script:tabFile.Add_Click({ Switch-Mode 'file' })
$script:fileButton.Add_Click({ Select-File })
$script:recentButton.Add_Click({ Show-RecentMenu })
$script:subtitleButton.Add_Click({
  $script:fileSubtitleIndex = ($script:fileSubtitleIndex + 1) % $script:fileSubtitleModes.Count
  $script:subtitleButton.Content = $script:fileSubtitleLabels[$script:fileSubtitleIndex]
})
$script:fileOpen.Add_Click({
  $target = [string]$script:fileOpen.Tag
  if (-not [string]::IsNullOrWhiteSpace($target)) {
    try { Start-Process explorer.exe -ArgumentList $target } catch {}
  }
})
$script:monitorButton.Add_Click({
  if ($script:monitors.Count -lt 2) { return }
  $script:monitorIndex = ($script:monitorIndex + 1) % $script:monitors.Count
  $script:monitorButton.Content = $script:monitorLabels[$script:monitorIndex]
})
$script:postSoft.Add_Click({ Request-Post 'soft' })
$script:postBurn.Add_Click({ Request-Post 'burn' })
$script:postSrt.Add_Click({ Request-Post 'srt' })
$script:postNone.Add_Click({
  $script:postPanel.Visibility = 'Collapsed'
  Set-Status '已保存' '#6FCF97'
})
$script:postOpen.Add_Click({
  $path = [string]$script:postOpen.Tag
  if (-not [string]::IsNullOrWhiteSpace($path)) {
    try { Start-Process explorer.exe -ArgumentList ('/select,"' + $path + '"') } catch {}
  }
})

$script:header.Add_MouseLeftButtonDown({ try { $script:window.DragMove() } catch {} })
$script:pinButton.Add_Click({
  $script:window.Topmost = -not $script:window.Topmost
  $script:pinButton.Foreground = New-Brush $(if ($script:window.Topmost) { '#6EA8FE' } else { '#7C8AA5' })
})
$script:closeButton.Add_Click({
  if ($script:capturing) {
    Stop-Session
    $script:closeAfterStop = $true
    return
  }
  if ($script:trayEnabled) { Hide-CaptureWindow } else { Exit-CaptureNotes }
})

$script:micSettingsButton.Add_Click({
  try { Start-Process 'ms-settings:privacy-microphone' } catch {
    Show-Error ("无法打开 Windows 麦克风设置：" + $_.Exception.Message)
  }
})

$script:sourceButton.Add_Click({
  $script:sourceIndex = ($script:sourceIndex + 1) % $script:sourceCodes.Count
  $script:sourceButton.Content = $script:sourceLabels[$script:sourceIndex]
  $script:modeHint.Text = (Get-ModeLabel) + ' · ' + $script:sourceLabels[$script:sourceIndex] + ' → ' + $script:targetLabels[$script:targetIndex]
})
$script:targetButton.Add_Click({
  $script:targetIndex = ($script:targetIndex + 1) % $script:targetCodes.Count
  $script:targetButton.Content = $script:targetLabels[$script:targetIndex]
  $script:modeHint.Text = (Get-ModeLabel) + ' · ' + $script:sourceLabels[$script:sourceIndex] + ' → ' + $script:targetLabels[$script:targetIndex]
})
$script:startButton.Add_Click({
  if ($script:mode -eq 'file') { Start-FileJob; return }
  if ($script:waitingStop) { return }
  if ($script:capturing) { Stop-Session } else { Start-Session }
})

# ---------------------------------------------------------------- timers ----
$script:flushTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:flushTimer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:flushTimer.Add_Tick({ Pump-Audio })

$script:pollTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:pollTimer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:pollTimer.Add_Tick({ Update-FromSnapshot })
$script:pollTimer.Start()

$script:postTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:postTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:postTimer.Add_Tick({ Update-PostState })
$script:postTimer.Start()

$script:fileTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:fileTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:fileTimer.Add_Tick({ Update-FileState })
$script:fileTimer.Start()

$script:diskTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:diskTimer.Interval = [TimeSpan]::FromSeconds(60)
$script:diskTimer.Add_Tick({
  if (-not $script:capturing -or $script:mode -ne 'record') { return }
  try {
    $root = [System.IO.Path]::GetPathRoot($script:dataDir)
    $drive = [System.IO.DriveInfo]::new($root)
    if ($drive.AvailableFreeSpace -lt 500MB) {
      Show-Error '磁盘剩余空间不足 500 MB，录制已停止。'
      Stop-Session
    }
  } catch {}
})
$script:diskTimer.Start()

$script:heartbeatTimer = [System.Windows.Threading.DispatcherTimer]::new()
$script:heartbeatTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
$script:heartbeatTimer.Add_Tick({
  try {
    [System.IO.File]::WriteAllText($script:aliveFile, (Get-Date).ToString('o'))
    [System.IO.File]::WriteAllText($script:pidFile, [string]$PID)
  } catch {}
  if (Test-Path -LiteralPath $script:showFile) {
    try { Remove-Item -LiteralPath $script:showFile -Force } catch {}
    try { $script:window.Show(); $script:window.Activate() } catch {}
  }
  if (Test-Path -LiteralPath $script:quitFile) {
    try { Remove-Item -LiteralPath $script:quitFile -Force } catch {}
    Exit-CaptureNotes
  }
  if (($script:closeAfterStop -or $script:exitAfterStop)) {
    $snapshot = $null
    try { $snapshot = Get-Content -LiteralPath $script:liveFile -Raw | ConvertFrom-Json } catch {}
    if ($null -eq $snapshot -or $snapshot.status -eq 'stopped' -or $snapshot.status -eq 'error') {
      $script:closeAfterStop = $false
      if ($script:exitAfterStop) {
        $script:exitAfterStop = $false
        Exit-CaptureNotes
      } elseif ($script:trayEnabled) {
        Hide-CaptureWindow
      } else {
        $script:allowClose = $true
        try { $script:window.Close() } catch {}
      }
    }
  }
})
$script:heartbeatTimer.Start()

if ($ParentPid -gt 0) {
  $script:parentTimer = [System.Windows.Threading.DispatcherTimer]::new()
  $script:parentTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
  $script:parentTimer.Add_Tick({
    if ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      if ($script:capturing) { Stop-Session }
      $script:allowClose = $true
      if ($null -ne $script:tray) {
        try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
        $script:tray = $null
      }
      try { $script:window.Close() } catch {}
    }
  })
  $script:parentTimer.Start()
}

$window.Add_SourceInitialized({
  try {
    $helper = [System.Windows.Interop.WindowInteropHelper]::new($script:window)
    $source = [System.Windows.Interop.HwndSource]::FromHwnd($helper.Handle)
    $source.AddHook({
      param($hwnd, $msg, $wParam, $lParam, [ref]$handled)
      if ($msg -eq 0x0010 -and $script:trayEnabled -and -not $script:allowClose) {
        $handled.Value = $true
        Hide-CaptureWindow
      }
      return [IntPtr]::Zero
    })
  } catch {}
})

$window.Add_Closed({
  try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch {}
})

$window.Add_Closing({
  param($sender, $eventArgs)
  if ($script:trayEnabled -and -not $script:allowClose) {
    $eventArgs.Cancel = $true
    Hide-CaptureWindow
    return
  }
  if ($script:capturing) { Stop-Session }
  if ($null -ne $script:tray) {
    try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
    $script:tray = $null
  }
  try { Remove-Item -LiteralPath $script:pidFile -Force -ErrorAction SilentlyContinue } catch {}
})

if ($AutoCloseMs -gt 0) {
  $script:autoTimer = [System.Windows.Threading.DispatcherTimer]::new()
  $script:autoTimer.Interval = [TimeSpan]::FromMilliseconds($AutoCloseMs)
  $script:autoTimer.Add_Tick({
    $script:allowClose = $true
    if ($null -ne $script:tray) {
      try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
      $script:tray = $null
    }
    try { $script:window.Close() } catch {}
  })
  $script:autoTimer.Start()
}

# ---------------------------------------------------------------- preview ---
if (-not [string]::IsNullOrWhiteSpace($PreviewPath)) {
  $script:isPreview = $true
  $fake = [pscustomobject]@{
    status = 'listening'
    sessionId = 'cn-20261108-164500-preview'
    mode = 'live'
    video = $null
    videoError = ''
    elapsedMs = 75400
    error = ''
    lanes = [pscustomobject]@{
      system = [pscustomobject]@{ active = $true; ready = $true; partial = '' }
      mic = [pscustomobject]@{ active = $true; ready = $true; partial = 'あ、でも今日は…' }
    }
    segments = @(
      [pscustomobject]@{ id = 's1'; lane = 'system'; start = 12.3; end = 15.6; text = 'そうですね、散歩でも行きましょうか。'; translation = '是啊，要不要去散散步？'; state = 'done' },
      [pscustomobject]@{ id = 's2'; lane = 'mic'; start = 16.1; end = 18.4; text = 'いいですね、行きましょう。'; translation = '真不错，走吧。'; state = 'done' },
      [pscustomobject]@{ id = 's3'; lane = 'system'; start = 19.0; end = 22.2; text = 'あ、でも今日はちょっと…'; translation = ''; state = 'pending' }
    )
  }
  if ($PreviewMode -eq 'record') {
    Switch-Mode 'record'
    $fake.mode = 'record'
    $fake.video = [pscustomobject]@{ file = 'screen.mp4'; duration = 75.4; width = 2560; height = 1600 }
    Set-Status '录制中 · 画面 + 系统 + 麦克风' '#E5484D'
    $script:modeHint.Text = '录屏 · 日本語 → 简体中文'
  } elseif ($PreviewMode -eq 'file') {
    Switch-Mode 'file'
    $script:fileInput = 'D:\videos\sample.mp4'
    $script:fileButton.Content = 'sample.mp4'
    $script:fileProcessing = $true
    Set-FileUi $true
    Set-Status '识别中 · 62%' '#F2C94C'
    $script:modeHint.Text = '文件 · 中文 → 简体中文'
  } else {
    Set-Status '正在聆听 · 系统 + 麦克风' '#6FCF97'
    $script:modeHint.Text = '实时 · 日本語 → 简体中文'
  }
  Render-Snapshot $fake
  if ($PreviewPost) { Show-PostPrompt }
  if ($PreviewMode -ne 'file') { $script:elapsedText.Text = Format-Clock ([double]$fake.elapsedMs / 1000) }
  $window.Show()
  $window.UpdateLayout()
  Start-Sleep -Milliseconds 500
  try {
    $width = [int]$window.ActualWidth
    $height = [int]$window.ActualHeight
    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
      $width, $height, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($window)
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.File]::Create($PreviewPath)
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
  } catch {
    [Console]::Error.WriteLine("preview failed: $($_.Exception.Message)")
  }
  $window.Close()
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($script:dataDirError)) {
  Show-Error "运行目录不可写：$($script:dataDirError)。请确认 DSH 有写权限，或用 -DataDir 指定可写目录。"
}

# Test hook: the window-host integration test drives a real capture without a
# mouse. Both variables are ignored in normal use.
if ($env:CAPTURE_NOTES_AUTOSTART -eq '1') {
  $script:autoStartTimer = [System.Windows.Threading.DispatcherTimer]::new()
  $script:autoStartTimer.Interval = [TimeSpan]::FromMilliseconds(1200)
  $script:autoStartTimer.Add_Tick({
    $script:autoStartTimer.Stop()
    if (-not [string]::IsNullOrWhiteSpace($env:CAPTURE_NOTES_AUTOFILE)) {
      Switch-Mode 'file'
      $script:fileInput = $env:CAPTURE_NOTES_AUTOFILE
      $script:fileButton.Content = Format-FileName ([System.IO.Path]::GetFileName($script:fileInput))
      Start-FileJob
      return
    }
    if ($env:CAPTURE_NOTES_AUTOMODE -eq 'record') { Switch-Mode 'record' }
    if (-not $script:capturing) { Start-Session }
    $seconds = 0
    if ([int]::TryParse([string]$env:CAPTURE_NOTES_AUTOSTOP, [ref]$seconds) -and $seconds -gt 0) {
      $script:autoStopTimer = [System.Windows.Threading.DispatcherTimer]::new()
      $script:autoStopTimer.Interval = [TimeSpan]::FromSeconds($seconds)
      $script:autoStopTimer.Add_Tick({
        $script:autoStopTimer.Stop()
        if ($script:capturing) { Stop-Session }
      })
      $script:autoStopTimer.Start()
    }
  })
  $script:autoStartTimer.Start()
}

if (-not [string]::IsNullOrWhiteSpace($PreviewPath)) {
  $window.ShowDialog() | Out-Null
} else {
  $window.Show()
  [System.Windows.Threading.Dispatcher]::Run()
}
if ($null -ne $script:tray) {
  try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
  $script:tray = $null
}
