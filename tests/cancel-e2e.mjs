/**
 * Verify that mux/burn can be cancelled and leave no partial output.
 *
 * Run: node tests/cancel-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { burnSubtitles, muxSubtitles, resolveFfmpeg } from '../lib/core/media.js'
import { processFile } from '../lib/core/pipeline.js'
import { writeSubtitles } from '../lib/core/subtitle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, '.tmp-cancel-e2e')
const ffmpeg = resolveFfmpeg()
assert.ok(ffmpeg, 'ffmpeg not found')

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const video = path.join(TMP, 'source.mp4')
const generated = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
  '-t', '120',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-y', video,
], { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
assert.equal(generated.status, 0, 'could not generate the test video')

const subtitles = await writeSubtitles({
  segments: [{ id: 's1', start: 0, end: 2, text: '取消测试' }],
  outDir: TMP,
  width: 1280,
  height: 720,
  bilingual: false,
})

const burnOut = path.join(TMP, 'burn.mp4')
const burnController = new AbortController()
const burnPromise = burnSubtitles({
  video,
  ass: subtitles.assPath,
  out: burnOut,
  preset: 'ultrafast',
  signal: burnController.signal,
})
setTimeout(() => burnController.abort(), 350)
await assert.rejects(burnPromise, /已取消/)
assert.equal(fs.existsSync(burnOut), false, 'cancelled burn left an output file')
console.log('[cancel-e2e] burn cancelled, no partial output')

const muxOut = path.join(TMP, 'mux.mp4')
const muxController = new AbortController()
const muxPromise = muxSubtitles({
  video,
  subtitles: subtitles.srtPath,
  out: muxOut,
  signal: muxController.signal,
})
setTimeout(() => muxController.abort(), 20)
await assert.rejects(muxPromise, /已取消/)
assert.equal(fs.existsSync(muxOut), false, 'cancelled mux left an output file')
console.log('[cancel-e2e] mux cancelled, no partial output')

const sample = path.join(HERE, '.tmp-file-e2e', 'sample.mp4')
if (fs.existsSync(sample)) {
  const long = path.join(TMP, 'long.mp4')
  const madeLong = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', sample, '-t', '60',
    '-c', 'copy', '-y', long,
  ], { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
  assert.equal(madeLong.status, 0, 'could not generate the long cancel input')

  const controller = new AbortController()
  const outDir = path.join(TMP, 'out-asr-cancel')
  const job = processFile({
    input: long,
    language: 'zh',
    threads: 4,
    subtitle: 'none',
    signal: controller.signal,
    outDir,
    workDir: path.join(TMP, 'work-asr-cancel'),
  })
  setTimeout(() => controller.abort(), 700)
  await assert.rejects(job, /已取消/)
  assert.equal(fs.existsSync(path.join(outDir, 'session.json')), false)
  console.log('[cancel-e2e] ASR cancelled, no session output')
}

console.log('[cancel-e2e] PASS')
