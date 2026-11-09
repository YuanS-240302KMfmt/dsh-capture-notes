param(
  [int]$Seconds = 10,
  [string]$OutDir = '',
  [string]$NaudioPath = '',
  [ValidateSet('system', 'mic', 'both')][string]$Source = 'both',
  [int]$ChunkMs = 500,
  [string]$ReportPath = '',
  [string]$ReadyPath = '',
  [int]$StartDelayMs = 0
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutDir)) { throw 'OutDir is required' }
if ([string]::IsNullOrWhiteSpace($ReportPath)) { $ReportPath = Join-Path $OutDir 'capture.json' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ([string]::IsNullOrWhiteSpace($NaudioPath)) {
  $NaudioPath = Join-Path $PSScriptRoot '..\..\lib\NAudio.dll'
}
if (-not (Test-Path -LiteralPath $NaudioPath)) { throw "NAudio.dll not found: $NaudioPath" }
$NaudioPath = (Resolve-Path -LiteralPath $NaudioPath).Path
Add-Type -Path $NaudioPath

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
                if (writer != null)
                {
                    writer.Write(args.Buffer, 0, args.BytesRecorded);
                }
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

$references = @($NaudioPath)
foreach ($assemblyName in @('netstandard.dll', 'System.Collections.dll', 'System.Threading.dll')) {
  $assemblyPath = Join-Path $PSHOME $assemblyName
  if (Test-Path -LiteralPath $assemblyPath) { $references += $assemblyPath }
}
Add-Type -TypeDefinition $captureCode -ReferencedAssemblies $references
Write-Host "[capture] NAudio loaded, pipeline compiled"

function New-Capture([string]$role) {
  if ($role -eq 'mic') {
    $capture = [NAudio.Wave.WaveInEvent]::new()
    try { $capture.WaveFormat = [NAudio.Wave.WaveFormat]::new(48000, 16, 1) } catch {}
    return $capture
  }
  return [NAudio.Wave.WasapiLoopbackCapture]::new()
}

$roles = if ($Source -eq 'both') { @('system', 'mic') } else { @($Source) }
$items = @()
$errors = @()

foreach ($role in $roles) {
  $capture = $null
  $pipeline = $null
  try {
    $capture = New-Capture $role
    $wav = Join-Path $OutDir "$role.wav"
    $chunkDir = Join-Path $OutDir "chunks\$role"
    New-Item -ItemType Directory -Force -Path $chunkDir | Out-Null
    Get-ChildItem -LiteralPath $chunkDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $pipeline = [CapturePipeline]::new($capture, $wav)
    $capture.StartRecording()
    Write-Host "[capture] $role started: $($pipeline.SourceFormat) -> $($pipeline.Pcm.WaveFormat)"
    $items += [pscustomobject]@{
      Role     = $role
      Capture  = $capture
      Pipeline = $pipeline
      Wav      = $wav
      ChunkDir = $chunkDir
      Pending  = [System.IO.MemoryStream]::new()
      Seq      = 0
      Cadence  = [System.Collections.Generic.List[int]]::new()
    }
  } catch {
    $errors += [pscustomobject]@{ role = $role; error = $_.Exception.Message }
    if ($null -ne $capture) { try { $capture.Dispose() } catch {} }
  }
}

if ($items.Count -eq 0) {
  [pscustomobject]@{
    ok       = $false
    error    = 'no capture source started'
    errors   = $errors
    psVersion = $PSVersionTable.PSVersion.ToString()
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  throw 'no capture source started'
}

if (-not [string]::IsNullOrWhiteSpace($ReadyPath)) {
  [pscustomobject]@{
    at      = (Get-Date).ToString('o')
    started = @($items | ForEach-Object { $_.Role })
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyPath -Encoding UTF8
}

if ($StartDelayMs -gt 0) { Start-Sleep -Milliseconds $StartDelayMs }

$chunkBytes = [int](32000 * $ChunkMs / 1000)
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = $stopwatch.Elapsed.TotalSeconds + $Seconds
$readBufferSize = 6400
$buffer = New-Object byte[] $readBufferSize

while ($stopwatch.Elapsed.TotalSeconds -lt $deadline) {
  foreach ($item in $items) {
    try {
      $ratio = [double]$item.Pipeline.Buffer.WaveFormat.AverageBytesPerSecond / 32000.0
      $available = [int][math]::Floor($item.Pipeline.BufferedBytes / $ratio)
      if ($available -ge 2) {
        $count = [math]::Min($readBufferSize, $available)
        $count -= $count % 2
        $read = $item.Pipeline.Pcm.Read($buffer, 0, $count)
        if ($read -gt 0) { $item.Pending.Write($buffer, 0, $read) }
      }

      while ($item.Pending.Length -ge $chunkBytes) {
        $all = $item.Pending.ToArray()
        $chunk = New-Object byte[] $chunkBytes
        [System.Array]::Copy($all, 0, $chunk, 0, $chunkBytes)
        $item.Seq++
        $name = 'chunk-{0:D6}.pcm' -f $item.Seq
        $temporary = Join-Path $item.ChunkDir ($name + '.tmp')
        $target = Join-Path $item.ChunkDir $name
        [System.IO.File]::WriteAllBytes($temporary, $chunk)
        Move-Item -LiteralPath $temporary -Destination $target -Force
        $item.Cadence.Add([int]$stopwatch.ElapsedMilliseconds)
        $rest = $all.Length - $chunkBytes
        $item.Pending.SetLength(0)
        if ($rest -gt 0) { $item.Pending.Write($all, $chunkBytes, $rest) }
        $all = $null
      }
    } catch {
      $errors += [pscustomobject]@{ role = $item.Role; error = $_.Exception.Message }
    }
  }
  Start-Sleep -Milliseconds 40
}

foreach ($item in $items) {
  try { $item.Capture.StopRecording() } catch {}
  Write-Host "[capture] $($item.Role) stopped"
}
Start-Sleep -Milliseconds 300
foreach ($item in $items) {
  try { $item.Pipeline.Dispose() } catch {}
  try { $item.Capture.Dispose() } catch {}
  Write-Host "[capture] $($item.Role) disposed"
}
$stopwatch.Stop()
Write-Host "[capture] loop done after $([math]::Round($stopwatch.Elapsed.TotalSeconds,1))s"

$sources = @()
foreach ($item in $items) {
  $wavBytes = 0
  if (Test-Path -LiteralPath $item.Wav) { $wavBytes = (Get-Item -LiteralPath $item.Wav).Length }
  $sources += [pscustomobject]@{
    role       = $item.Role
    format     = $item.Pipeline.SourceFormat
    pcmFormat  = $item.Pipeline.Pcm.WaveFormat.ToString()
    wav        = $item.Wav
    wavBytes   = $wavBytes
    chunks     = $item.Seq
    chunkBytes = $chunkBytes
    chunkTotalSec = [math]::Round(($item.Seq * $chunkBytes) / 32000.0, 3)
    cadenceMs  = @($item.Cadence)
  }
}

$report = [pscustomobject]@{
  ok        = $true
  startedAt = (Get-Date).ToString('o')
  endedAt   = (Get-Date).ToString('o')
  seconds   = $Seconds
  chunkMs   = $ChunkMs
  psVersion = $PSVersionTable.PSVersion.ToString()
  naudio    = [System.Reflection.AssemblyName]::GetAssemblyName($NaudioPath).Version.ToString()
  sources   = $sources
  errors    = $errors
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 8
