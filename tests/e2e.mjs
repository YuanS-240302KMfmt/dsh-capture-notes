/**
 * P1 end-to-end test without installing the plugin.
 *
 * Drives the same file protocol the WPF window uses: start.json, two lanes of
 * 16 kHz PCM chunks, stop.request. Uses the real SenseVoice workers and a fake
 * translator, then asserts the session artifacts on disk.
 *
 * Run: node tests/e2e.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || 'D:/dsh_mod/.video-notes'
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-e2e')

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const sessionsDir = path.join(TMP, 'sessions')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'native', 'chunks', 'system'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'native', 'chunks', 'mic'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'native', 'audio'), { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })

const routes = new Map()
const disposers = []
const translator = {
  resolve(request) {
    return { ...request, provider: 'fake' }
  },
  async translate(spec) {
    await new Promise((resolve) => setTimeout(resolve, 8))
    return `[译] ${spec.text}`
  },
}
const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  },
  get(name) {
    return name === 'translator' ? translator : undefined
  },
}

apply(ctx, {
  threads: 4,
  sessionsDir,
  windowDataDir: dataDir,
  nativeWindow: false,
  openOnStart: false,
  idleStopMs: 600_000,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function waitFor(label, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = predicate()
      if (value) return value
    } catch {}
    await sleep(150)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function wavPcm(file) {
  const buffer = fs.readFileSync(file)
  let pos = 12
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    if (id === 'data') return buffer.subarray(pos + 8, pos + 8 + size)
    pos += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${file}`)
}

function writeChunks(lane, pcm) {
  const dir = path.join(dataDir, 'native', 'chunks', lane)
  fs.mkdirSync(dir, { recursive: true })
  let seq = 0
  for (let offset = 0; offset < pcm.length; offset += 16_000) {
    seq++
    const slice = pcm.subarray(offset, Math.min(offset + 16_000, pcm.length))
    fs.writeFileSync(path.join(dir, `chunk-${String(seq).padStart(6, '0')}.pcm`), slice)
  }
  return seq
}

const startFile = path.join(dataDir, 'native', 'start.json')
const stopFile = path.join(dataDir, 'native', 'stop.request')
const liveFile = path.join(dataDir, 'live.json')

const pcm = wavPcm(SPEECH)
const systemChunks = writeChunks('system', pcm)
const micChunks = writeChunks('mic', pcm.subarray(0, Math.floor(pcm.length / 2) * 2))

// The window writes start.json after the devices are open; the chunks may
// already be on disk by then, which is exactly what we want to exercise.
fs.writeFileSync(startFile, JSON.stringify({
  version: 1,
  lanes: ['system', 'mic'],
  language: 'zh',
  target: 'en',
  provider: 'auto',
  formats: { system: 'test', mic: 'test' },
}), 'utf8')

console.log(`[e2e] data=${dataDir}`)
console.log(`[e2e] chunks system=${systemChunks} mic=${micChunks}`)

const listening = await waitFor('session listening', () => {
  const snapshot = readJson(liveFile)
  return snapshot.status === 'listening' ? snapshot : null
})
console.log(`[e2e] session ${listening.sessionId} listening`)

const withSegments = await waitFor('segments from both lanes', () => {
  const snapshot = readJson(liveFile)
  if (!Array.isArray(snapshot.segments)) return null
  const lanes = new Set(snapshot.segments.map((segment) => segment.lane))
  return lanes.has('system') && lanes.has('mic') && snapshot.segments.length >= 2 ? snapshot : null
})
console.log(`[e2e] segments=${withSegments.segments.length} lanes=${[...new Set(withSegments.segments.map((s) => s.lane))].join(',')}`)

// Give the translation queue a moment, then stop.
await waitFor('translation done', () => {
  const snapshot = readJson(liveFile)
  return snapshot.segments.every((segment) => segment.state !== 'pending') ? snapshot : null
}, 15_000)

// Archives normally come from the window; fake them so the move path is tested.
fs.copyFileSync(SPEECH, path.join(dataDir, 'native', 'audio', 'system.wav'))
fs.copyFileSync(SPEECH, path.join(dataDir, 'native', 'audio', 'mic.wav'))
fs.writeFileSync(stopFile, new Date().toISOString(), 'utf8')

const stopped = await waitFor('session stopped', () => {
  const snapshot = readJson(liveFile)
  return snapshot.status === 'stopped' ? snapshot : null
})
console.log(`[e2e] stopped ${stopped.sessionId}`)

const sessionDir = path.join(sessionsDir, stopped.sessionId)
const segmentsFile = path.join(sessionDir, 'segments.json')
const manifestFile = path.join(sessionDir, 'session.json')
const transcriptFile = path.join(sessionDir, 'transcript.md')
const srtFile = path.join(sessionDir, 'transcript.srt')

await waitFor('artifacts', () => fs.existsSync(segmentsFile) && fs.existsSync(manifestFile) && fs.existsSync(srtFile) && fs.existsSync(transcriptFile))

const segments = readJson(segmentsFile)
const manifest = readJson(manifestFile)
const transcript = fs.readFileSync(transcriptFile, 'utf8')
const srt = fs.readFileSync(srtFile, 'utf8')

assert.ok(segments.length >= 2, `expected >=2 segments, got ${segments.length}`)
assert.ok(segments.every((segment) => segment.lang === 'zh'), `language tag not cleaned: ${segments.map((segment) => segment.lang).join(',')}`)
assert.ok(segments.some((segment) => segment.source === 'system'), 'missing system segment')
assert.ok(segments.some((segment) => segment.source === 'mic'), 'missing mic segment')
assert.ok(segments.every((segment) => typeof segment.translation === 'string' && segment.translation.startsWith('[译]')), 'translation missing')
assert.ok(transcript.includes('开饭时间'), 'transcript does not contain the recognized text')
assert.ok(transcript.includes('[系统]') && transcript.includes('[麦克风]'), 'transcript is missing lane labels')
assert.ok(srt.includes('-->'), 'srt has no cues')
assert.equal(manifest.status, 'completed')
assert.equal(manifest.artifacts.transcript, 'transcript.md')
assert.equal(manifest.recording.tracks.length, 2, `expected 2 archive tracks, got ${manifest.recording.tracks.length}`)
assert.ok(fs.existsSync(path.join(sessionDir, 'audio', 'system.wav')), 'system archive not moved')
assert.ok(fs.existsSync(path.join(sessionDir, 'audio', 'mic.wav')), 'mic archive not moved')

console.log(`[e2e] segments=${segments.length} model=transcript+srt+segments+session`)
console.log(`[e2e] tracks=${manifest.recording.tracks.map((track) => `${track.role}@${track.sampleRate}`).join(' ')}`)
console.log('[e2e] PASS')

for (const disposer of disposers.reverse()) {
  try { disposer() } catch {}
}
process.exit(0)
