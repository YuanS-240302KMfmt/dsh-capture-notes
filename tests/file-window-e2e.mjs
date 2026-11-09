/**
 * P3 window file-job integration test.
 *
 * Starts the real window, lets it pick a file through the test hook
 * (CAPTURE_NOTES_AUTOFILE) and issue native/file.request. The host runs the
 * pipeline and the window displays progress from native/file.json.
 *
 * Run: node tests/file-window-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveFfmpeg } from '../lib/core/media.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || 'D:/dsh_mod/.video-notes'
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-file-window')

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const outRoot = path.join(TMP, 'out')
const workRoot = path.join(TMP, 'work')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(outRoot, { recursive: true })
fs.mkdirSync(workRoot, { recursive: true })

const ffmpeg = resolveFfmpeg()
const sample = path.join(TMP, 'sample.mp4')
const generated = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-stream_loop', '-1', '-i', SPEECH,
  '-t', '6',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30',
  '-c:a', 'aac', '-b:a', '96k',
  '-shortest', '-y', sample,
], { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
assert.equal(generated.status, 0)

process.env.CAPTURE_NOTES_AUTOSTART = '1'
process.env.CAPTURE_NOTES_AUTOFILE = sample

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
  sessionsDir: path.join(TMP, 'sessions'),
  windowDataDir: dataDir,
  fileOutRoot: outRoot,
  fileWorkRoot: workRoot,
  nativeWindow: true,
  openOnStart: true,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 180_000) {
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

console.log(`[file-window] file=${sample}`)

const stateFile = path.join(dataDir, 'native', 'file.json')
const done = await waitFor('window file job done', () => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  return state.status === 'done' ? state : null
})

try {
  assert.ok(done.outDir, 'no outDir')
  assert.ok(fs.existsSync(path.join(done.outDir, 'transcript.md')), 'transcript.md missing')
  assert.ok(fs.existsSync(path.join(done.outDir, 'segments.json')), 'segments.json missing')
  assert.ok(fs.existsSync(path.join(done.outDir, 'sample.soft.mp4')), 'soft video missing')
  console.log(`[file-window] out=${done.outDir} segments=${done.result?.segments}`)
  console.log('[file-window] PASS')
} finally {
  for (const disposer of disposers.reverse()) {
    try { disposer() } catch {}
  }
  await sleep(800)
}

process.exit(0)
