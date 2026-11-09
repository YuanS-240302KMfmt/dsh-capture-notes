import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSubtitles } from '../lib/core/subtitle.js'
import { burnSubtitles } from '../lib/core/media.js'

const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2]
if (!out) {
  console.error('usage: node reburn-file.mjs <outDir>')
  process.exit(2)
}
const session = JSON.parse(await fs.readFile(path.join(out, 'session.json'), 'utf8'))
const segments = JSON.parse(await fs.readFile(path.join(out, 'segments.json'), 'utf8'))
const input = session.input.path
const hard = path.join(out, path.basename(input).replace(/\.[^.]+$/, '.hardsub.mp4'))
const fixed = `${hard}.fixed.mp4`

await writeSubtitles({
  segments,
  outDir: out,
  width: session.input.width,
  height: session.input.height,
  bilingual: false,
  font: 'Microsoft YaHei',
  marginV: 5,
  maxDuration: session.input.durationSec,
})
const ass = await fs.readFile(path.join(out, 'subtitles.ass'), 'utf8')
const style = ass.split(/\r?\n/).find((line) => line.startsWith('Style:'))
console.log('[reburn] style:', style)

const result = await burnSubtitles({
  video: input,
  ass: path.join(out, 'subtitles.ass'),
  out: fixed,
  logPath: path.join(moduleRoot, 'work', path.basename(out), 'reburn.log'),
})
console.log('[reburn] encoded', result.sizeBytes, 'bytes in', result.elapsedSeconds, 's')

await fs.rm(hard, { force: true })
await fs.rename(fixed, hard)
console.log('[reburn] replaced', hard)
