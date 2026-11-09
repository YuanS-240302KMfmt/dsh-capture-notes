/**
 * P0 / v1 — can we record the screen and package two separate audio tracks?
 *
 *   1. NAudio captures system loopback + microphone into two WAVs (capture-audio.ps1).
 *   2. ffmpeg gdigrab records the primary screen (video only) for N seconds.
 *   3. ffmpeg muxes video + system.wav + mic.wav into one MP4 with two AAC tracks.
 *
 * The microphone is optional: when Windows denies microphone access the spike
 * substitutes tests/speech.wav as the second track, so the packaging path is
 * still validated and the limitation is reported explicitly.
 *
 * Usage: node v1-record.mjs [--seconds 15] [--no-player]
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  ffmpegPath,
  ffprobePath,
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
const seconds = Number.parseInt(argValue('--seconds', '15'), 10)
const usePlayer = !args.includes('--no-player')

const dir = freshDir('v1')
const audioDir = path.join(dir, 'audio')
const captureScript = path.join(import.meta.dirname, 'lib', 'capture-audio.ps1')
const captureReport = path.join(audioDir, 'capture.json')
const readyFile = path.join(audioDir, 'ready.json')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startPlayer(wav) {
  const command = `Add-Type -AssemblyName System.Windows.Extensions; $p = New-Object System.Media.SoundPlayer '${wav.replace(/'/g, "''")}'; while ($true) { $p.PlaySync() }`
  return spawn(powerShell(), ['-NoProfile', '-Command', command], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

async function probe(file) {
  const out = path.join(dir, `probe-${path.basename(file)}.json`)
  const result = await run(ffprobePath(), [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,duration,channels,sample_rate,width,height:format=duration,size',
    '-of', 'json',
    file,
  ], { stdoutPath: out })
  if (result.code !== 0) throw new Error(`ffprobe 失败（${path.basename(file)}）：${result.stderr}`)
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

console.log(`[v1] output: ${dir}`)
console.log(`[v1] recording ${seconds}s, player=${usePlayer}`)

let player = null
let audioStartedAt = 0
const audioRun = run(powerShell(), [
  '-NoProfile', '-File', captureScript,
  '-Seconds', String(seconds + 2),
  '-OutDir', audioDir,
  '-Source', 'both',
  '-ReportPath', captureReport,
  '-ReadyPath', readyFile,
], { logPath: path.join(dir, 'audio.log'), timeoutMs: (seconds + 30) * 1000 })

// Wait until NAudio has actually opened its devices, then start the video.
const waitDeadline = Date.now() + 20_000
while (!fs.existsSync(readyFile) && Date.now() < waitDeadline) {
  await sleep(100)
}
if (!fs.existsSync(readyFile)) {
  console.error('[v1] audio capture never became ready')
  process.exit(1)
}
audioStartedAt = Date.parse(JSON.parse(fs.readFileSync(readyFile, 'utf8')).at)

if (usePlayer) {
  player = startPlayer(speechWav())
  await sleep(400)
}

const videoPath = path.join(dir, 'screen.mp4')
const videoStartedAt = Date.now()
const video = await run(ffmpegPath(), [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0',
  '-i', 'desktop',
  '-t', String(seconds),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-an', '-y', videoPath,
], { logPath: path.join(dir, 'video.log'), timeoutMs: (seconds + 60) * 1000 })
if (player) { try { player.kill() } catch {} }
const audio = await audioRun

if (video.code !== 0) {
  console.error(`[v1] gdigrab failed: ${video.stderr}`)
  process.exit(1)
}
if (audio.code !== 0) {
  console.error(`[v1] audio capture failed: ${audio.stderr}`)
  process.exit(1)
}

const capture = JSON.parse(fs.readFileSync(captureReport, 'utf8'))
const byRole = new Map(capture.sources.map((source) => [source.role, source]))
const systemInfo = byRole.get('system')
const micInfo = byRole.get('mic')
const micError = (capture.errors ?? []).find((entry) => entry.role === 'mic')?.error ?? null

if (!systemInfo || systemInfo.chunks < 2) {
  console.error('[v1] system loopback produced no audio; is anything playing?')
  process.exit(1)
}
const systemWav = systemInfo.wav
const systemInfoWav = readWav(systemWav)

let micWav = null
let micSource = 'captured'
let micCaptured = false
if (micInfo && micInfo.chunks >= 2 && fs.existsSync(micInfo.wav) && readWav(micInfo.wav).durationSec > 0.2) {
  micWav = micInfo.wav
  micCaptured = true
} else {
  micWav = speechWav()
  micSource = 'stand-in'
}

const leadMs = Math.max(0, videoStartedAt - audioStartedAt)
const trimSec = Math.min(leadMs / 1000, 5)

const muxedPath = path.join(dir, 'muxed.mp4')
const muxArgs = [
  '-hide_banner', '-loglevel', 'error',
  '-i', videoPath,
  ...(trimSec > 0.02 ? ['-ss', trimSec.toFixed(3)] : []),
  '-i', systemWav,
  ...(micCaptured ? [] : ['-stream_loop', '-1']),
  '-i', micWav,
  '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
  '-t', String(seconds),
  '-y', muxedPath,
]
const mux = await run(ffmpegPath(), muxArgs, {
  logPath: path.join(dir, 'mux.log'),
  timeoutMs: 120_000,
})
if (mux.code !== 0) {
  console.error(`[v1] mux failed: ${mux.stderr}`)
  process.exit(1)
}

const probeResult = await probe(muxedPath)
const streams = probeResult.streams ?? []
const videoStreams = streams.filter((stream) => stream.codec_type === 'video')
const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
const durations = streams.map((stream) => Number.parseFloat(stream.duration)).filter((value) => Number.isFinite(value))
const spreadSec = durations.length > 1 ? Math.max(...durations) - Math.min(...durations) : Infinity

const decode = await run(ffmpegPath(), [
  '-hide_banner', '-loglevel', 'error', '-i', muxedPath, '-f', 'null', '-',
], { logPath: path.join(dir, 'decode.log'), timeoutMs: 120_000 })

const checks = {
  oneVideoStream: videoStreams.length === 1,
  twoAudioStreams: audioStreams.length === 2,
  durationSpreadUnder200ms: spreadSec <= 0.2,
  decodesCleanly: decode.code === 0,
}
const ok = Object.values(checks).every(Boolean)

const report = {
  ok,
  seconds,
  dir,
  video: {
    file: videoPath,
    bytes: fs.statSync(videoPath).size,
    startedAt: new Date(videoStartedAt).toISOString(),
  },
  audio: {
    system: {
      file: systemWav,
      format: systemInfo.format,
      durationSec: Number(systemInfoWav.durationSec.toFixed(3)),
      chunks: systemInfo.chunks,
    },
    mic: {
      captured: micCaptured,
      file: micWav,
      source: micSource,
      error: micError,
    },
  },
  mux: {
    file: muxedPath,
    bytes: fs.statSync(muxedPath).size,
    streams: streams.map((stream) => ({
      index: stream.index,
      type: stream.codec_type,
      codec: stream.codec_name,
      duration: stream.duration,
      channels: stream.channels,
      sampleRate: stream.sample_rate,
    })),
    durationSpreadSec: Number(spreadSec.toFixed(3)),
    decodeOk: decode.code === 0,
  },
  timing: { audioLeadMs: leadMs, trimSec: Number(trimSec.toFixed(3)) },
  checks,
}

const reportFile = writeReport(dir, 'report.json', report)
console.log('')
console.log(`video   : ${videoStreams[0]?.codec_name ?? '?'} ${videoStreams[0]?.width ?? '?'}x${videoStreams[0]?.height ?? '?'} ${videoStreams[0]?.duration ?? '?'}s`)
console.log(`system  : ${systemInfo.format}, ${report.audio.system.durationSec}s, ${systemInfo.chunks} chunks`)
console.log(`mic     : ${micCaptured ? 'captured' : `stand-in (${micError ?? 'no data'})`}`)
console.log(`muxed   : ${audioStreams.length} audio tracks, spread ${report.mux.durationSpreadSec}s, decode=${decode.code === 0 ? 'ok' : 'fail'}`)
console.log(`checks  : ${JSON.stringify(checks)}`)
console.log(`report  : ${reportFile}`)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
