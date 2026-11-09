/**
 * P2 recording + post-process integration test.
 *
 * Drives the real window in record mode (test hooks), records the screen with
 * audio, lets the host mux MPEG-TS parts + WAV into screen.mp4, then auto-picks
 * soft or burn subtitles through the post.request protocol.
 *
 * Run: P2_POST=soft node tests/record-e2e.mjs
 *      P2_POST=burn node tests/record-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probe } from '../lib/core/media.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || 'D:/dsh_mod/.video-notes'
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-record-e2e')
const POST = (process.env.P2_POST || 'soft').toLowerCase()

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const sessionsDir = path.join(TMP, 'sessions')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })

process.env.CAPTURE_NOTES_AUTOSTART = '1'
process.env.CAPTURE_NOTES_AUTOMODE = 'record'
process.env.CAPTURE_NOTES_AUTOSTOP = String(process.env.P2_SECONDS || '6')
process.env.CAPTURE_NOTES_AUTOPOST = POST

const playerCommand = `Add-Type -AssemblyName System.Windows.Extensions; $p = New-Object System.Media.SoundPlayer '${SPEECH.replace(/'/g, "''")}'; while ($true) { $p.PlaySync() }`
const player = spawn('pwsh.exe', ['-NoProfile', '-Command', playerCommand], { stdio: 'ignore', windowsHide: true })

const disposers = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  connection: { fetch: { register() { return () => {} } } },
  get() { return undefined },
}

apply(ctx, {
  threads: 4,
  sessionsDir,
  windowDataDir: dataDir,
  nativeWindow: true,
  openOnStart: true,
  idleStopMs: 600_000,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = predicate()
      if (value) return value
    } catch {}
    await sleep(300)
  }
  throw new Error(`timeout waiting for ${label}`)
}

console.log(`[record-e2e] post=${POST} data=${dataDir}`)

await waitFor('window pid', () => fs.existsSync(path.join(dataDir, 'window.pid')))

const expected = POST === 'burn' ? 'screen.hardsub.mp4' : 'screen.soft.mp4'
const found = await waitFor(`completed session with ${expected}`, () => {
  for (const name of fs.readdirSync(sessionsDir)) {
    const dir = path.join(sessionsDir, name)
    const file = path.join(dir, 'session.json')
    if (!fs.existsSync(file)) continue
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (manifest.status === 'completed' && manifest.artifacts?.subtitledVideo === expected && fs.existsSync(path.join(dir, expected))) {
      return { dir, manifest }
    }
  }
  return null
})

const video = path.join(found.dir, 'screen.mp4')
const outputFile = path.join(found.dir, expected)
const subtitles = path.join(found.dir, 'subtitles.srt')

try {
  assert.equal(found.manifest.mode, 'record')
  assert.equal(found.manifest.recording.video, 'screen.mp4')
  assert.ok(found.manifest.recording.videoInfo.duration >= 3, 'video is too short')
  assert.ok(fs.existsSync(video), 'screen.mp4 missing')
  assert.ok(fs.statSync(video).size > 100_000, 'screen.mp4 looks empty')
  assert.ok(fs.existsSync(outputFile), `${expected} missing`)
  assert.ok(fs.existsSync(subtitles), 'subtitles.srt missing')

  const videoInfo = await probe(video)
  const outputInfo = await probe(outputFile)
  const srt = fs.readFileSync(subtitles, 'utf8')
  const segments = JSON.parse(fs.readFileSync(path.join(found.dir, 'segments.json'), 'utf8'))

  assert.equal(videoInfo.videoStreams.length, 1)
  assert.ok(videoInfo.audioStreams.length >= 1, 'screen.mp4 has no audio track')
  assert.ok(segments.length >= 1, 'no transcript segments')
  assert.ok(srt.includes('-->'), 'subtitles.srt has no cues')

  if (POST === 'soft') {
    assert.ok(outputInfo.subtitleStreams.length >= 1, 'soft output has no subtitle stream')
    assert.equal(outputInfo.videoStreams[0]?.codec_name, 'h264')
  } else {
    assert.equal(outputInfo.subtitleStreams.length, 0, 'hard output still has a subtitle stream')
    assert.ok(outputInfo.videoStreams.length === 1)
  }
  assert.ok(Math.abs((outputInfo.duration || 0) - (videoInfo.duration || 0)) <= 0.5, 'output duration drifted')

  console.log(`[record-e2e] session=${found.manifest.id} segments=${segments.length}`)
  console.log(`[record-e2e] video=${videoInfo.duration.toFixed(2)}s ${videoInfo.width}x${videoInfo.height} audio=${videoInfo.audioStreams.length}`)
  console.log(`[record-e2e] output=${path.basename(outputFile)} ${outputInfo.duration.toFixed(2)}s subs=${outputInfo.subtitleStreams.length}`)
  console.log(`[record-e2e] PASS (${POST})`)
} finally {
  try { player.kill() } catch {}
  for (const disposer of disposers.reverse()) {
    try { disposer() } catch {}
  }
  await sleep(1000)
}

process.exit(0)
