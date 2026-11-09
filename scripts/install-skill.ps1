param(
  [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Target)) {
  $Target = Join-Path $env:USERPROFILE '.dsh\skills\capture-notes'
}
$source = Join-Path $PSScriptRoot '..\skill'
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
  throw "skill source not found: $source"
}

New-Item -ItemType Directory -Force -Path $Target, (Join-Path $Target 'references') | Out-Null
$moduleRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$skillText = Get-Content -LiteralPath (Join-Path $source 'SKILL.md') -Raw
$skillText = $skillText.Replace('{{MODULE_ROOT}}', $moduleRoot)
[IO.File]::WriteAllText((Join-Path $Target 'SKILL.md'), $skillText, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $source 'references\notes-template.md') -Destination (Join-Path $Target 'references\notes-template.md') -Force

[pscustomobject]@{
  ok = $true
  target = $Target
  files = @(
    (Join-Path $Target 'SKILL.md'),
    (Join-Path $Target 'references\notes-template.md')
  )
} | ConvertTo-Json -Depth 4
