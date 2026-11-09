/**
 * P3 file-mode end-to-end test.
 *
 * Covers: media -> transcript + soft subtitles, agent translation apply
 * (bilingual + rebuilt soft video), translation id validation, and the
 * subtitles-only path for a video with an embedded text track.
 *
 * Run: node tests/file-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { muxSubtitles, probe, resolveFfmpeg } from '../lib/core/media.js'
import { applyTranslation, processFile } from '../lib/core/pipeline.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const SPEECH = process.env.P1_SPEECH_WAV
  || path.join(MODULE, '..', 'live-translate', 'tests', 'speech.wav')
const TMP = path.join(HERE, '.tmp-file-e2e')

const ffmpeg = resolveFfmpeg()
assert.ok(ffmpeg, 'ffmpeg not found')

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const sample = path.join(TMP, 'sample.mp4')
const generated = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-stream_loop', '-1', '-i', SPEECH,
  '-t', '8',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30',
  '-c:a', 'aac', '-b:a', '96k',
  '-shortest', '-y', sample,
], { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
assert.equal(generated.status, 0, 'could not generate the test media')
assert.ok(fs.statSync(sample).size > 100_000)

console.log(`[file-e2e] media=${sample}`)

const result = await processFile({
  input: sample,
  language: 'zh',
  subtitle: 'soft',
  threads: 4,
  outRoot: path.join(TMP, 'out'),
  workRoot: path.join(TMP, 'work'),
  onProgress: () => {},
})

const outDir = result.outDir
const segmentsFile = path.join(outDir, 'segments.json')
const softVideo = path.join(outDir, 'sample.soft.mp4')
assert.ok(fs.existsSync(segmentsFile), 'segments.json missing')
assert.ok(fs.existsSync(path.join(outDir, 'transcript.md')), 'transcript.md missing')
assert.ok(fs.existsSync(path.join(outDir, 'transcript.srt')), 'transcript.srt missing')
assert.ok(fs.existsSync(path.join(outDir, 'transcript.txt')), 'transcript.txt missing')
assert.ok(fs.existsSync(path.join(outDir, 'subtitles.srt')), 'subtitles.srt missing')
assert.ok(fs.existsSync(softVideo), 'soft video missing')
const assFile = path.join(outDir, 'subtitles.ass')
assert.ok(fs.existsSync(assFile), 'subtitles.ass missing')
const styleLine = fs.readFileSync(assFile, 'utf8').split(/\r?\n/).find((line) => line.startsWith('Style:'))
assert.ok(styleLine, 'ass style line missing')
const assMarginV = Number(styleLine.split(',')[21])
assert.ok(Number.isFinite(assMarginV) && assMarginV > 0 && assMarginV <= 200, `ass marginV out of range: ${assMarginV}`)

const segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'))
assert.ok(segments.length >= 1, 'no segments')
assert.ok(segments.every((segment) => segment.source === 'file'), 'source should be file')
const softInfo = await probe(softVideo)
assert.equal(softInfo.videoStreams.length, 1)
assert.ok(softInfo.audioStreams.length >= 1)
assert.ok(softInfo.subtitleStreams.length >= 1, 'soft video has no subtitle stream')
console.log(`[file-e2e] pipeline segments=${segments.length} soft=${softInfo.duration.toFixed(2)}s subs=${softInfo.subtitleStreams.length}`)

// Agent-style translation, default bilingual.
const translation = {
  schema: 1,
  target: 'zh-CN',
  source: 'segments.json',
  segments: segments.map((segment, index) => ({
    id: segment.id,
    text: index === 0 ? '营业时间早上9点到下午5点。' : '用餐时间早上9点到下午5点。',
  })),
}
fs.writeFileSync(path.join(outDir, 'translation.zh-CN.json'), JSON.stringify(translation, null, 2), 'utf8')

const applied = await applyTranslation({
  session: outDir,
  target: 'zh-CN',
  format: 'bi',
  mux: 'soft',
  ffmpeg,
})
assert.ok(fs.existsSync(applied.output), 'translated video missing')
const bilingual = fs.readFileSync(path.join(outDir, 'subtitles.srt'), 'utf8')
assert.ok(bilingual.includes('营业时间'), 'translation line missing from srt')
assert.ok(bilingual.includes('开饭时间'), 'original line missing from bilingual srt')
const translatedInfo = await probe(applied.output)
assert.ok(translatedInfo.subtitleStreams.length >= 1)
assert.ok(Math.abs((translatedInfo.duration || 0) - (softInfo.duration || 0)) <= 0.5)
console.log(`[file-e2e] translation cues=${applied.cues} output=${path.basename(applied.output)}`)

// Validation: a missing id must be rejected rather than silently dropped.
const broken = { ...translation, segments: translation.segments.slice(0, -1) }
fs.writeFileSync(path.join(outDir, 'translation.zh-CN.json'), JSON.stringify(broken, null, 2), 'utf8')
await assert.rejects(
  () => applyTranslation({ session: outDir, target: 'zh-CN', format: 'bi', mux: 'none', ffmpeg }),
  /缺失 id/,
)
console.log('[file-e2e] validation rejects missing ids')

// Subtitles-only path: mux a text track into the sample, then extract it.
const withSubs = path.join(TMP, 'withsubs.mp4')
const plainSrt = path.join(TMP, 'plain.srt')
fs.writeFileSync(plainSrt, '1\n00:00:00,000 --> 00:00:05,000\n内嵌字幕测试\n', 'utf8')
await muxSubtitles({ video: sample, subtitles: plainSrt, out: withSubs, ffmpeg })
const subsOnly = await processFile({
  input: withSubs,
  subsOnly: true,
  outRoot: path.join(TMP, 'out-subs'),
  workRoot: path.join(TMP, 'work-subs'),
})
assert.ok(fs.existsSync(subsOnly.srt), 'extracted subtitle missing')
assert.ok(fs.readFileSync(subsOnly.srt, 'utf8').includes('内嵌字幕测试'))
console.log('[file-e2e] subtitles-only extraction works')

console.log('[file-e2e] PASS')
