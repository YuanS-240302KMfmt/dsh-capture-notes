/**
 * P1 window-host integration test.
 *
 * Starts the real plugin with nativeWindow enabled, lets the WPF window
 * auto-start a system-audio capture (test hook: CAPTURE_NOTES_AUTOSTART),
 * plays speech.wav through the default output so loopback has audio, and waits
 * for the session artifacts. Exercises the actual NAudio capture + file
 * protocol + ASR + save path without a mouse.
 *
 * Run: node tests/window-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || 'D:/dsh_mod/.video-notes'
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-window-e2e')

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const sessionsDir = path.join(TMP, 'sessions')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(sessionsDir, { recursive: true })

process.env.CAPTURE_NOTES_AUTOSTART = '1'
process.env.CAPTURE_NOTES_AUTOSTOP = '6'

const playerCommand = `Add-Type -AssemblyName System.Windows.Extensions; $p = New-Object System.Media.SoundPlayer '${SPEECH.replace(/'/g, "''")}'; while ($true) { $p.PlaySync() }`
const player = spawn('pwsh.exe', ['-NoProfile', '-Command', playerCommand], { stdio: 'ignore', windowsHide: true })

const disposers = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  connection: {
    fetch: {
      register() {
        return () => {}
      },
    },
  },
  get() {
    return undefined
  },
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

async function waitFor(label, predicate, timeoutMs = 90_000) {
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

console.log(`[window-e2e] data=${dataDir}`)

const pidFile = path.join(dataDir, 'window.pid')
await waitFor('window pid', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')
console.log('[window-e2e] window up')

const sessionJson = await waitFor('completed session', () => {
  for (const name of fs.readdirSync(sessionsDir)) {
    const file = path.join(sessionsDir, name, 'session.json')
    if (!fs.existsSync(file)) continue
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (manifest.status === 'completed') return { dir: path.join(sessionsDir, name), manifest }
  }
  return null
})

const transcript = fs.readFileSync(path.join(sessionJson.dir, 'transcript.md'), 'utf8')
const segments = JSON.parse(fs.readFileSync(path.join(sessionJson.dir, 'segments.json'), 'utf8'))

console.log(`[window-e2e] session ${sessionJson.manifest.id} segments=${segments.length}`)
console.log(`[window-e2e] transcript: ${transcript.split('\n').filter((line) => line.startsWith('**[0')).slice(0, 2).join(' | ')}`)

const archive = path.join(sessionJson.dir, 'audio', 'system.wav')
const archiveBytes = fs.existsSync(archive) ? fs.statSync(archive).size : 0

try {
  assert.equal(sessionJson.manifest.status, 'completed')
  assert.ok(sessionJson.manifest.recording.tracks.some((track) => track.role === 'system'), 'system archive track missing')
  assert.ok(fs.existsSync(archive), 'system.wav not moved into the session')
  assert.ok(archiveBytes > 10_000, `system.wav looks empty (${archiveBytes} bytes)`)
  assert.ok(fs.existsSync(path.join(sessionJson.dir, 'transcript.md')), 'transcript.md missing')
  assert.ok(fs.existsSync(path.join(sessionJson.dir, 'transcript.srt')), 'transcript.srt missing')
  if (segments.length > 0) {
    assert.ok(transcript.includes('[系统]'), 'transcript is missing the system lane label')
  }
  console.log(`[window-e2e] archive=${Math.round(archiveBytes / 1024)} KB segments=${segments.length}`)
  console.log('[window-e2e] PASS')
} finally {
  try { player.kill() } catch {}
  for (const disposer of disposers.reverse()) {
    try { disposer() } catch {}
  }
  await sleep(800)
}

process.exit(0)
