/**
 * P0 / v3 — can one capture feed both products at once?
 *
 * Runs the NAudio capture for N seconds and checks that a single device open
 * produces, simultaneously:
 *   - an archive WAV at the device format (48 kHz stereo float for loopback),
 *   - 16 kHz mono PCM16 chunks every 500 ms for the ASR lane.
 *
 * The microphone is checked when Windows allows it; otherwise the spike
 * reports it as blocked (this machine denies waveInOpen with E_ACCESSDENIED)
 * and still validates the system lane.
 *
 * Usage: node v3-audio-tap.mjs [--seconds 10]
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  freshDir,
  powerShell,
  readWav,
  run,
  speechWav,
  writeReport,
} from './lib/paths.mjs'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const seconds = Number.parseInt(argValue('--seconds', '10'), 10)

const dir = freshDir('v3')
const audioDir = path.join(dir, 'audio')
const captureScript = path.join(import.meta.dirname, 'lib', 'capture-audio.ps1')
const captureReport = path.join(audioDir, 'capture.json')
const readyFile = path.join(audioDir, 'ready.json')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startPlayer(wav) {
  const command = `Add-Type -AssemblyName System.Windows.Extensions; $p = New-Object System.Media.SoundPlayer '${wav.replace(/'/g, "''")}'; while ($true) { $p.PlaySync() }`
  return spawn(powerShell(), ['-NoProfile', '-Command', command], { windowsHide: true, stdio: 'ignore' })
}

function analyzeSource(source) {
  const chunkDir = path.join(audioDir, 'chunks', source.role)
  const files = fs.existsSync(chunkDir)
    ? fs.readdirSync(chunkDir).filter((name) => name.endsWith('.pcm')).sort()
    : []
  const sizes = files.map((name) => fs.statSync(path.join(chunkDir, name)).size)
  const cadence = source.cadenceMs ?? []
  const gaps = cadence.slice(1).map((value, index) => value - cadence[index])
  const meanGap = gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null
  const maxGap = gaps.length > 0 ? Math.max(...gaps) : null
  const wav = fs.existsSync(source.wav) ? readWav(source.wav) : null
  const chunkTotalSec = (files.length * 16000) / 32000
  const durationDiffSec = wav ? Math.abs(wav.durationSec - chunkTotalSec) : null
  const uniform = sizes.every((size) => size === 16000)
  return {
    role: source.role,
    format: source.format,
    pcmFormat: source.pcmFormat,
    chunks: files.length,
    chunkSizesUniform: uniform,
    chunkTotalSec: Number(chunkTotalSec.toFixed(3)),
    wavDurationSec: wav ? Number(wav.durationSec.toFixed(3)) : 0,
    durationDiffSec: durationDiffSec === null ? null : Number(durationDiffSec.toFixed(3)),
    cadenceMeanGapMs: meanGap === null ? null : Number(meanGap.toFixed(1)),
    cadenceMaxGapMs: maxGap,
    sampleRate: wav?.sampleRate ?? null,
    channels: wav?.channels ?? null,
    bits: wav?.bits ?? null,
  }
}

function evaluate(candidate, expectedChunks) {
  return {
    enoughChunks: candidate.chunks >= expectedChunks,
    uniformChunks: candidate.chunkSizesUniform,
    cadenceNear500: candidate.cadenceMeanGapMs !== null
      && candidate.cadenceMeanGapMs >= 400
      && candidate.cadenceMeanGapMs <= 650,
    noLongStall: candidate.cadenceMaxGapMs !== null && candidate.cadenceMaxGapMs <= 800,
    archiveMatchesTap: candidate.durationDiffSec !== null && candidate.durationDiffSec <= 0.7,
    pcm16Mono16k: candidate.pcmFormat === '16 bit PCM: 16kHz 1 channels',
  }
}

console.log(`[v3] output: ${dir}`)
console.log(`[v3] capturing ${seconds}s (player on)`)

const player = startPlayer(speechWav())
await sleep(300)

const capture = run(powerShell(), [
  '-NoProfile', '-File', captureScript,
  '-Seconds', String(seconds),
  '-OutDir', audioDir,
  '-Source', 'both',
  '-ReportPath', captureReport,
  '-ReadyPath', readyFile,
], { logPath: path.join(dir, 'capture.log'), timeoutMs: (seconds + 30) * 1000 })

await capture
try { player.kill() } catch {}

if (!fs.existsSync(captureReport)) {
  console.error('[v3] capture produced no report')
  process.exit(1)
}
const raw = JSON.parse(fs.readFileSync(captureReport, 'utf8'))
const sources = raw.sources ?? []
const system = sources.find((source) => source.role === 'system')
const mic = sources.find((source) => source.role === 'mic')
const micError = (raw.errors ?? []).find((entry) => entry.role === 'mic')?.error ?? null

if (!system) {
  console.error('[v3] system loopback did not start')
  process.exit(1)
}

const systemResult = analyzeSource(system)
const systemChecks = evaluate(systemResult, Math.max(2, seconds * 2 - 2))

let micResult = null
let micChecks = null
const micCaptured = Boolean(mic && mic.chunks > 0)
if (micCaptured) {
  micResult = analyzeSource(mic)
  micChecks = evaluate(micResult, Math.max(2, seconds * 2 - 2))
}

const systemOk = Object.values(systemChecks).every(Boolean)
const micOk = micCaptured ? Object.values(micChecks).every(Boolean) : null
const ok = systemOk && (micOk === null || micOk)

const report = {
  ok,
  partial: systemOk && micOk === null,
  seconds,
  dir,
  system: { ...systemResult, checks: systemChecks },
  mic: micCaptured
    ? { captured: true, ...micResult, checks: micChecks }
    : { captured: false, blocked: micError },
  checks: { systemOk, micOk },
}
const reportFile = writeReport(dir, 'report.json', report)

console.log('')
console.log(`system : ${systemResult.chunks} chunks, ${systemResult.wavDurationSec}s wav vs ${systemResult.chunkTotalSec}s tap, gap mean ${systemResult.cadenceMeanGapMs}ms / max ${systemResult.cadenceMaxGapMs}ms`)
console.log(`mic    : ${micCaptured ? `${micResult.chunks} chunks, gap mean ${micResult.cadenceMeanGapMs}ms` : `blocked (${micError ?? 'no data'})`}`)
console.log(`checks : ${JSON.stringify(report.checks)}`)
console.log(`report : ${reportFile}`)
console.log(ok ? (report.partial ? 'PASS (partial: microphone blocked by Windows)' : 'PASS') : 'FAIL')
process.exit(ok ? 0 : 1)
