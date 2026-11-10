/**
 * P2 crash-recovery test.
 *
 * Simulates an interrupted recording: a stale MPEG-TS part, an archive WAV and
 * a dangling record.json in the native directory. Applying the plugin must mux
 * them into sessions/recovered-xxx/screen.mp4 and mark the manifest as aborted.
 *
 * Run: node tests/recovery-e2e.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probe, resolveFfmpeg } from '../lib/core/media.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || 'D:/dsh_mod/.video-notes'
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-recovery-e2e')

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const sessionsDir = path.join(TMP, 'sessions')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'native', 'video'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'native', 'audio'), { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })

const ffmpeg = resolveFfmpeg()
assert.ok(ffmpeg, 'ffmpeg not found')

const { spawnSync } = await import('node:child_process')
const part = path.join(dataDir, 'native', 'video', 'part-000.ts')
const generated = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-t', '3',
  '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p',
  '-f', 'mpegts', '-y', part,
], { stdio: 'ignore', windowsHide: true, timeout: 60_000 })
assert.equal(generated.status, 0, 'could not generate the test part')
assert.ok(fs.statSync(part).size > 10_000, 'test part is too small')

// A truncated tail part is what a hard kill usually leaves behind. Recovery
// must validate it with ffmpeg and drop it instead of muxing corrupt video.
const badPart = path.join(dataDir, 'native', 'video', 'part-001.ts')
const bytes = fs.readFileSync(part)
fs.writeFileSync(badPart, bytes.subarray(0, 5000))
const old = new Date(Date.now() - 60_000)
fs.utimesSync(part, old, old)
fs.utimesSync(badPart, old, old)

fs.copyFileSync(SPEECH, path.join(dataDir, 'native', 'audio', 'system.wav'))
fs.writeFileSync(path.join(dataDir, 'native', 'record.json'), JSON.stringify({
  audioStartedAt: new Date().toISOString(),
  videoStartedAt: new Date().toISOString(),
}), 'utf8')

// Make the part look like it came from a crashed session, not one still writing.
fs.utimesSync(part, old, old)
fs.utimesSync(badPart, old, old)

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
  sessionsDir,
  windowDataDir: dataDir,
  nativeWindow: false,
  openOnStart: false,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 60_000) {
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

console.log(`[recovery-e2e] data=${dataDir}`)

const recovered = await waitFor('recovered session', () => {
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!name.startsWith('recovered-')) continue
    const file = path.join(sessionsDir, name, 'session.json')
    if (!fs.existsSync(file)) continue
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (manifest.crashRecovered) return { dir: path.join(sessionsDir, name), manifest }
  }
  return null
})

const video = path.join(recovered.dir, 'screen.mp4')
try {
  assert.ok(fs.existsSync(video), 'recovered screen.mp4 missing')
  assert.equal(recovered.manifest.status, 'aborted')
  assert.equal(recovered.manifest.recording.video, 'screen.mp4')
  assert.ok(fs.existsSync(path.join(recovered.dir, 'audio', 'system.wav')), 'audio not moved')
  assert.equal(fs.existsSync(part), false, 'stale part was not cleaned')

  const info = await probe(video)
  assert.equal(info.videoStreams.length, 1)
  assert.ok(info.audioStreams.length >= 1, 'recovered video has no audio')
  assert.ok(info.duration >= 2, 'recovered video is too short')
  assert.equal(fs.existsSync(badPart), false, 'corrupt tail part was not dropped')

  const decodeLog = path.join(TMP, 'decode.log')
  const decodeFd = fs.openSync(decodeLog, 'w')
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', video, '-f', 'null', '-'], {
    stdio: ['ignore', 'ignore', decodeFd],
    windowsHide: true,
    timeout: 120_000,
  })
  fs.closeSync(decodeFd)
  assert.equal(decoded.status, 0, `recovered video failed to decode: ${decoded.error?.message ?? decoded.signal ?? ''}`)
  const decodeErrors = fs.readFileSync(decodeLog, 'utf8').trim()
  assert.equal(decodeErrors, '', `recovered video has decode errors: ${decodeErrors}`)

  console.log(`[recovery-e2e] ${recovered.manifest.id} video=${info.duration.toFixed(2)}s audio=${info.audioStreams.length}`)
  console.log('[recovery-e2e] PASS')
} finally {
  for (const disposer of disposers.reverse()) {
    try { disposer() } catch {}
  }
  await sleep(500)
}

process.exit(0)
