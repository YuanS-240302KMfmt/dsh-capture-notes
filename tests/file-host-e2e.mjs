/**
 * P3 host file-job test: the window talks to the host through native/file.request
 * and native/file.json. This drives that protocol without the WPF window.
 *
 * Run: node tests/file-host-e2e.mjs
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
const TMP = path.join(HERE, '.tmp-file-host')

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)

const dataDir = path.join(TMP, 'data')
const outRoot = path.join(TMP, 'out')
const workRoot = path.join(TMP, 'work')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'native'), { recursive: true })
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
  sessionsDir: path.join(TMP, 'sessions'),
  windowDataDir: dataDir,
  fileOutRoot: outRoot,
  fileWorkRoot: workRoot,
  threads: 4,
  nativeWindow: false,
  openOnStart: false,
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

const stateFile = path.join(dataDir, 'native', 'file.json')
const requestFile = path.join(dataDir, 'native', 'file.request')
fs.writeFileSync(requestFile, JSON.stringify({
  input: sample,
  language: 'zh',
  subtitle: 'soft',
}), 'utf8')

console.log(`[file-host] request=${sample}`)

const running = await waitFor('file job running', () => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  return state.status === 'running' ? state : null
})
assert.ok(running.stage)

const done = await waitFor('file job done', () => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  return state.status === 'done' ? state : null
})

assert.ok(done.outDir, 'done state has no outDir')
assert.ok(fs.existsSync(path.join(done.outDir, 'transcript.md')), 'transcript.md missing')
assert.ok(fs.existsSync(path.join(done.outDir, 'segments.json')), 'segments.json missing')
assert.ok(fs.existsSync(path.join(done.outDir, 'sample.soft.mp4')), 'soft video missing')
console.log(`[file-host] out=${done.outDir} stage=${done.stage} percent=${done.percent}`)
console.log('[file-host] PASS')

for (const disposer of disposers.reverse()) {
  try { disposer() } catch {}
}
await sleep(200)
process.exit(0)
