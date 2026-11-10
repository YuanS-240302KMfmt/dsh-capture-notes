/**
 * File-mode pipeline: local media -> 16 kHz WAV -> SenseVoice -> transcript,
 * subtitles and an optional soft/hard-subtitled video.
 *
 * Shared by scripts/cli.mjs (skill/批量) and the Host file job (window).
 * ffmpeg runs without pipes; the ASR lane is the same worker used live.
 */

import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { burnSubtitles, muxSubtitles, probe, resolveFfmpeg } from './media.js'
import { writeSubtitles } from './subtitle.js'

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOTES_ROOT = process.env.VIDEO_NOTES_HOME || path.join(MODULE_ROOT, '..', '.video-notes')

function startResourceMeter() {
  const startedAt = Date.now()
  const cpuAtStart = process.cpuUsage()
  let peakRss = process.memoryUsage().rss
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 2000)
  timer.unref?.()
  const snapshot = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const cpu = process.cpuUsage(cpuAtStart)
    return {
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      peakRssMB: Number((peakRss / 1048576).toFixed(1)),
      cpuSeconds: Number(((cpu.user + cpu.system) / 1e6).toFixed(1)),
    }
  }
  return {
    snapshot,
    stop() {
      clearInterval(timer)
      return snapshot()
    },
  }
}

function runtimeDir() {
  const candidates = [
    process.env.CAPTURE_NOTES_RUNTIME,
    path.join(MODULE_ROOT, 'runtime', 'node_modules'),
    path.join(NOTES_ROOT, 'node_modules'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sherpa-onnx-node', 'package.json'))) return dir
  }
  throw new Error('找不到 sherpa-onnx 运行时')
}

function runtimeRequire(name) {
  const dir = runtimeDir()
  return createRequire(path.join(dir, 'package.json'))(name)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function slugify(input) {
  const base = path.basename(input, path.extname(input))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'media'
  const hash = createHash('sha1').update(path.resolve(input)).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const r = ms % 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`
}

class WavStream {
  constructor(file) {
    this.file = file
    this.buffer = Buffer.alloc(0)
    this.fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(12)
    fs.readSync(this.fd, header, 0, 12, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`不是 RIFF/WAVE：${file}`)
    }
    const size = fs.fstatSync(this.fd).size
    let pos = 12
    let fmt = null
    let dataOffset = -1
    let dataSize = 0
    while (pos + 8 <= size) {
      const chunk = Buffer.alloc(8)
      fs.readSync(this.fd, chunk, 0, 8, pos)
      const id = chunk.toString('ascii', 0, 4)
      const length = chunk.readUInt32LE(4)
      if (id === 'fmt ') {
        const body = Buffer.alloc(length)
        fs.readSync(this.fd, body, 0, length, pos + 8)
        fmt = {
          format: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bits: body.readUInt16LE(14),
        }
      } else if (id === 'data') {
        dataOffset = pos + 8
        dataSize = Math.min(length, size - dataOffset)
        break
      }
      pos += 8 + length + (length % 2)
    }
    if (!fmt || dataOffset < 0) throw new Error(`WAV 缺少 fmt/data：${file}`)
    if (fmt.format !== 1 || fmt.sampleRate !== 16000 || fmt.channels !== 1 || fmt.bits !== 16) {
      throw new Error(`需要 16 kHz 单声道 PCM16，实际 ${fmt.sampleRate} Hz / ${fmt.channels} ch / ${fmt.bits} bit`)
    }
    this.dataOffset = dataOffset
    this.dataSize = dataSize
    this.totalSamples = Math.floor(dataSize / 2)
    this.readSamples = 0
  }

  next(maxSamples) {
    const count = Math.min(maxSamples, this.totalSamples - this.readSamples)
    if (count <= 0) return null
    const bytes = count * 2
    const buffer = Buffer.alloc(bytes)
    fs.readSync(this.fd, buffer, 0, bytes, this.dataOffset + this.readSamples * 2)
    const samples = new Float32Array(count)
    for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768
    this.readSamples += count
    return samples
  }

  close() {
    try { fs.closeSync(this.fd) } catch {}
  }
}

let converter = null
let converterChecked = false
function getConverter() {
  if (converterChecked) return converter
  converterChecked = true
  try {
    const opencc = runtimeRequire('opencc-js')
    converter = opencc.Converter({ from: 't', to: 'cn' })
  } catch {
    converter = null
  }
  return converter
}

function simplifySegments(segments) {
  const convert = getConverter()
  if (!convert) return 0
  let changed = 0
  for (const segment of segments) {
    const lang = String(segment.lang ?? '').toLowerCase()
    if (lang !== 'zh' && lang !== 'yue' && lang !== '') continue
    const next = convert(segment.text)
    if (next !== segment.text) {
      segment.text = next
      changed++
    }
  }
  return changed
}

async function transcribeWav({ wav, language, threads, onProgress, signal }) {
  const totalSeconds = wav.totalSamples / 16000
  const workerData = {
    runtimeDir: runtimeDir(),
    model: resolveModel('model.int8.onnx'),
    tokens: resolveModel('tokens.txt'),
    vad: resolveVad(),
    language,
    threads,
    maxSegmentSeconds: 8,
    partialIntervalMs: 900,
  }
  const worker = new Worker(new URL('../asr-worker.js', import.meta.url), {
    name: 'capture-notes-file-asr',
    workerData,
  })
  const segments = []
  let error = null
  let stopped = false
  let stopResolve
  const stoppedPromise = new Promise((resolve) => { stopResolve = resolve })
  let ackResolve = null

  worker.on('message', (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'final') {
      const text = String(message.text ?? '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim()
      if (text === '') return
      segments.push({
        id: `s${String(segments.length + 1).padStart(5, '0')}`,
        start: Number(message.start) || 0,
        end: Number(message.end) || 0,
        text,
        lang: String(message.lang ?? '').replace(/<\|/g, '').replace(/\|>/g, '').toLowerCase(),
      })
    } else if (message.type === 'error') {
      error = new Error(message.message)
      const resolve = ackResolve
      ackResolve = null
      resolve?.()
    } else if (message.type === 'stopped') {
      stopped = true
      stopResolve()
    } else if (message.type === 'ack') {
      const resolve = ackResolve
      ackResolve = null
      resolve?.()
    }
  })
  worker.on('error', (workerError) => {
    error = workerError
    const resolve = ackResolve
    ackResolve = null
    resolve?.()
    stopResolve()
  })

  const aborted = () => signal?.aborted === true
  const onAbort = () => {
    // Do not terminate a worker that may be inside the native sherpa decoder.
    // Let the current 30 s batch finish, then stop cooperatively below.
    stopResolve()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await waitReady(worker, 120_000)
    const chunkSamples = 16000 * 30
    while (!aborted()) {
      const chunk = wav.next(chunkSamples)
      if (chunk === null) break
      await new Promise((resolve) => {
        ackResolve = resolve
        worker.postMessage({ type: 'audio', samples: chunk })
      })
      if (aborted() || error) break
      const percent = Math.min(95, 5 + Math.round((wav.readSamples / wav.totalSamples) * 90))
      onProgress?.({ stage: 'asr', percent, detail: `${Math.floor(wav.readSamples / 16000)} / ${Math.floor(totalSeconds)} s` })
      await sleep(2)
    }
    if (!aborted() && !error) {
      worker.postMessage({ type: 'stop' })
      await Promise.race([stoppedPromise, sleep(120_000)])
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      if (!stopped) {
        worker.postMessage({ type: 'stop' })
        await Promise.race([stoppedPromise, sleep(30_000)])
      }
    } catch {}
    try { await worker.terminate() } catch {}
    wav.close()
  }
  if (aborted()) throw new Error('已取消')
  if (error) throw error
  if (!stopped) throw new Error('识别进程未正常结束')
  segments.sort((a, b) => a.start - b.start)
  const simplified = simplifySegments(segments)
  return { segments, totalSeconds, simplified }
}

function waitReady(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('识别引擎加载超时')) }, timeoutMs)
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        cleanup()
        resolve()
      } else if (message?.type === 'error') {
        cleanup()
        reject(new Error(message.message))
      }
    }
    const onError = (workerError) => {
      cleanup()
      reject(workerError)
    }
    const cleanup = () => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
  })
}

function resolveModel(name) {
  const candidates = [
    path.join(MODULE_ROOT, 'models', 'sensevoice', name),
    path.join(NOTES_ROOT, 'models', 'sensevoice', name),
  ]
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) throw new Error(`找不到模型文件 ${name}`)
  return file
}

function resolveVad() {
  const candidates = [
    path.join(MODULE_ROOT, 'models', 'silero_vad.onnx'),
    path.join(NOTES_ROOT, 'models', 'silero_vad.onnx'),
  ]
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) throw new Error('找不到 Silero VAD 模型')
  return file
}

function writeTranscript(segments) {
  const lines = ['# 逐字稿', '']
  for (const segment of segments) {
    lines.push(`**[${srtTime(segment.start).replace(',', '.')} – ${srtTime(segment.end).replace(',', '.')}]** ${segment.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

function writePlain(segments) {
  return segments.map((segment) => segment.text).join('\n')
}

function writeSrt(segments) {
  return segments.map((segment, index) => (
    `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text}\n`
  )).join('\n')
}

function publicSegments(segments) {
  return segments.map((segment) => ({
    id: segment.id,
    start: Number(segment.start.toFixed(3)),
    end: Number(segment.end.toFixed(3)),
    text: segment.text,
    lang: segment.lang,
    source: 'file',
    speaker: null,
    speakers: [],
    overlap: false,
    translation: '',
    translationState: 'none',
  }))
}

/**
 * Run the file pipeline. Returns a summary; writes artifacts into outDir and
 * intermediates into workDir.
 */
export async function processFile(options = {}) {
  const meter = startResourceMeter()
  try {
    return await runFile(options, meter)
  } finally {
    meter.stop()
  }
}

async function runFile({
  input,
  language = 'auto',
  threads = 6,
  subtitle = 'soft',
  limit = 0,
  keepAudio = false,
  subsOnly = false,
  font = 'Microsoft YaHei',
  margin = 0.05,
  ffmpeg = '',
  outDir = '',
  workDir = '',
  outRoot = '',
  workRoot = '',
  onProgress = () => {},
  signal,
} = {}, meter) {
  if (!input) throw new Error('缺少输入文件')
  const source = path.resolve(input)
  if (!fs.existsSync(source)) throw new Error(`文件不存在：${source}`)
  const bin = resolveFfmpeg(ffmpeg)
  if (!bin) throw new Error('找不到 ffmpeg')

  const slug = slugify(source)
  const work = workDir || path.join(workRoot || path.join(MODULE_ROOT, 'work'), slug)
  const out = outDir || path.join(outRoot || path.join(MODULE_ROOT, 'out'), slug)
  await fsp.mkdir(work, { recursive: true })
  await fsp.mkdir(out, { recursive: true })

  onProgress({ stage: 'probe', percent: 2, detail: path.basename(source) })
  const info = await probe(source)
  if (info.videoStreams.length === 0 && info.audioStreams.length === 0 && info.subtitleStreams.length === 0) {
    throw new Error('文件没有音频、视频或字幕流')
  }

  if (subsOnly) {
    if (info.subtitleStreams.length === 0) throw new Error('文件没有内嵌文本字幕')
    onProgress({ stage: 'subtitle', percent: 20, detail: '提取内嵌字幕' })
    const srtPath = path.join(out, 'transcript.srt')
    const result = await runFfmpeg(bin, ['-hide_banner', '-nostdin', '-y', '-i', source, '-map', '0:s:0', '-c:s', 'srt', srtPath], work, signal)
    if (result.code !== 0) throw new Error(`提取字幕失败：${result.stderr.slice(-300)}`)
    const manifest = buildFileManifest({ source, info, out, work, subtitle: 'none', segments: 0, subsOnly: true, metrics: meter.snapshot() })
    await fsp.writeFile(path.join(out, 'session.json'), JSON.stringify(manifest, null, 2), 'utf8')
    onProgress({ stage: 'done', percent: 100, detail: '字幕已提取' })
    return { ok: true, mode: 'subtitles-only', outDir: out, workDir: work, srt: srtPath }
  }

  if (info.audioStreams.length === 0) throw new Error('文件没有音频流')
  const hasVideo = info.videoStreams.length > 0
  const mediaKind = hasVideo ? 'video' : 'audio'

  const audioPath = path.join(work, 'audio.wav')
  onProgress({ stage: 'extract', percent: 5, detail: '抽取 16 kHz 单声道' })
  const extractArgs = ['-hide_banner', '-nostdin', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
  if (limit > 0) extractArgs.push('-t', String(limit))
  extractArgs.push(audioPath)
  const extracted = await runFfmpeg(bin, extractArgs, work, signal)
  if (signal?.aborted) throw new Error('已取消')
  if (extracted.code !== 0) throw new Error(`抽音失败：${extracted.stderr.slice(-300)}`)

  const wav = new WavStream(audioPath)
  onProgress({ stage: 'asr', percent: 8, detail: '加载识别模型' })
  const { segments, totalSeconds, simplified } = await transcribeWav({
    wav,
    language,
    threads,
    signal,
    onProgress: (progress) => onProgress({ ...progress, percent: Math.min(95, progress.percent) }),
  })
  if (segments.length === 0) throw new Error('没有识别到语音（可能是纯音乐或静音）')

  const width = info.videoStreams[0]?.width || 1280
  const height = info.videoStreams[0]?.height || 720
  onProgress({ stage: 'subtitle', percent: 96, detail: '生成字幕' })
  const subtitles = await writeSubtitles({
    segments,
    outDir: out,
    width,
    height,
    bilingual: false,
    font,
    marginV: margin,
    maxDuration: Number(info.duration) || totalSeconds,
  })
  const segmentsPublic = publicSegments(segments)
  await fsp.writeFile(path.join(out, 'segments.json'), JSON.stringify(segmentsPublic, null, 2), 'utf8')
  await fsp.writeFile(path.join(out, 'transcript.md'), writeTranscript(segments), 'utf8')
  await fsp.writeFile(path.join(out, 'transcript.srt'), writeSrt(segments), 'utf8')
  await fsp.writeFile(path.join(out, 'transcript.txt'), writePlain(segments), 'utf8')

  const stem = path.basename(source, path.extname(source)).replace(/[<>:"/\\|?*]/g, ' ').trim() || 'video'
  const isMkv = path.extname(source).toLowerCase() === '.mkv'
  let softVideo = null
  let hardVideo = null
  if (!hasVideo) {
    onProgress({ stage: 'subtitle', percent: 97, detail: '音频文件，跳过视频封装' })
  } else if (limit > 0 && subtitle !== 'none') {
    onProgress({ stage: 'subtitle', percent: 97, detail: '--limit 结果跳过字幕封装' })
  } else if (subtitle === 'soft' || subtitle === 'both') {
    onProgress({ stage: 'mux', percent: 97, detail: '封装软字幕' })
    softVideo = path.join(out, `${stem}.soft${isMkv ? '.mkv' : '.mp4'}`)
    await muxSubtitles({ video: source, subtitles: subtitles.srtPath, out: softVideo, ffmpeg: bin, logPath: path.join(work, 'mux.log'), signal })
  }
  if (hasVideo && limit === 0 && (subtitle === 'burn' || subtitle === 'both')) {
    onProgress({ stage: 'burn', percent: 98, detail: '烧录硬字幕（较慢）' })
    hardVideo = path.join(out, `${stem}.hardsub.mp4`)
    await burnSubtitles({ video: source, ass: subtitles.assPath, out: hardVideo, ffmpeg: bin, logPath: path.join(work, 'burn.log'), signal })
  }

  if (!keepAudio) {
    await fsp.rm(audioPath, { force: true })
  }

  const manifest = buildFileManifest({
    source,
    info,
    out,
    work,
    subtitle,
    segments: segmentsPublic.length,
    duration: totalSeconds,
    simplified,
    softVideo,
    hardVideo,
    subtitles,
    keepAudio,
    language,
    metrics: meter.snapshot(),
  })
  await fsp.writeFile(path.join(out, 'session.json'), JSON.stringify(manifest, null, 2), 'utf8')
  onProgress({ stage: 'done', percent: 100, detail: '完成' })
  return {
    ok: true,
    mode: 'file',
    outDir: out,
    workDir: work,
    mediaKind,
    segments: segmentsPublic.length,
    durationSec: Number(totalSeconds.toFixed(1)),
    simplifiedSegments: simplified,
    transcript: path.join(out, 'transcript.md'),
    srt: subtitles.srtPath,
    softVideo,
    hardVideo,
  }
}

async function runFfmpeg(bin, args, cwd, signal) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const log = path.join(cwd, `.ffmpeg-${Date.now()}.log`)
    const fd = fs.openSync(log, 'w')
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', fd] })
    const onAbort = () => {
      try { child.kill() } catch {}
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      fs.closeSync(fd)
      reject(error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      fs.closeSync(fd)
      let stderr = ''
      try { stderr = fs.readFileSync(log, 'utf8') } catch {}
      resolve({ code, stderr, log })
    })
  })
}

function buildFileManifest({
  source,
  info,
  out,
  work,
  subtitle,
  segments,
  duration = 0,
  simplified = 0,
  softVideo = null,
  hardVideo = null,
  subtitles = null,
  keepAudio = false,
  language = 'auto',
  subsOnly = false,
  metrics = {},
}) {
  const now = new Date()
  const mediaKind = info.videoStreams?.length ? 'video' : 'audio'
  return {
    schema: 1,
    id: path.basename(out),
    mode: 'file',
    status: 'completed',
    createdAt: now.toISOString(),
    endedAt: now.toISOString(),
    languages: { source: language, target: '' },
    input: {
      kind: 'file',
      path: path.resolve(source),
      durationSec: Number((info.duration || duration).toFixed(2)),
      width: info.width || 0,
      height: info.height || 0,
      mediaKind,
    },
    recording: { video: null, tracks: [] },
    artifacts: {
      transcript: subsOnly ? null : 'transcript.md',
      srt: 'transcript.srt',
      segments: subsOnly ? null : 'segments.json',
      subtitles: subtitles ? { srt: 'subtitles.srt', ass: 'subtitles.ass' } : (subsOnly ? { srt: 'transcript.srt', ass: null } : null),
      translations: [],
      subtitledVideo: softVideo ? path.basename(softVideo) : (hardVideo ? path.basename(hardVideo) : null),
      hardSubVideo: hardVideo ? path.basename(hardVideo) : null,
      softVideo: softVideo ? path.basename(softVideo) : null,
      notes: null,
    },
    stats: {
      segments,
      durationSec: Number((duration || info.duration || 0).toFixed(1)),
      simplifiedSegments: simplified,
      subtitleMode: subtitle,
      subsOnly,
      keepAudio,
      mediaKind,
      elapsedSeconds: metrics.elapsedSeconds ?? null,
      peakMemoryMB: metrics.peakRssMB ?? null,
      cpuSeconds: metrics.cpuSeconds ?? null,
    },
    crashRecovered: false,
  }
}

/**
 * Apply an agent-generated translation.<target>.json to a file or recording
 * session, rebuild subtitles and optionally re-mux/burn the video.
 */
export async function applyTranslation({
  session,
  target,
  format = 'bi',
  mux = 'none',
  font = 'Microsoft YaHei',
  margin = 0.05,
  ffmpeg = '',
} = {}) {
  if (!session) throw new Error('缺少 --session')
  if (!target) throw new Error('缺少 --target')
  const dir = resolveSessionDir(session)
  const segmentsFile = path.join(dir, 'segments.json')
  if (!fs.existsSync(segmentsFile)) throw new Error(`找不到逐字稿：${segmentsFile}`)
  const translationFile = path.join(dir, `translation.${target}.json`)
  if (!fs.existsSync(translationFile)) throw new Error(`找不到译文文件：${translationFile}`)

  const segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'))
  const translation = JSON.parse(fs.readFileSync(translationFile, 'utf8'))
  const entries = Array.isArray(translation) ? translation : translation.segments
  if (!Array.isArray(entries)) throw new Error('translation 文件缺少 segments 数组')

  const byId = new Map()
  const duplicates = []
  for (const entry of entries) {
    const id = String(entry?.id ?? '')
    if (!id) throw new Error('译文条目缺少 id')
    if (byId.has(id)) duplicates.push(id)
    byId.set(id, String(entry.text ?? ''))
  }
  const missing = segments.map((segment) => segment.id).filter((id) => !byId.has(id))
  const extra = [...byId.keys()].filter((id) => !segments.some((segment) => segment.id === id))
  if (duplicates.length || missing.length || extra.length) {
    const detail = [
      duplicates.length ? `重复 id：${duplicates.join(', ')}` : '',
      missing.length ? `缺失 id：${missing.join(', ')}` : '',
      extra.length ? `多余 id：${extra.join(', ')}` : '',
    ].filter(Boolean).join('；')
    throw new Error(`译文与逐字稿不一致：${detail}`)
  }

  const merged = segments.map((segment) => ({
    ...segment,
    translation: byId.get(segment.id) ?? '',
    translationState: 'done',
  }))
  await fsp.writeFile(segmentsFile, JSON.stringify(merged, null, 2), 'utf8')

  const manifestFile = path.join(dir, 'session.json')
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
  const videoInfo = manifest.recording?.video
    ? path.join(dir, manifest.recording.video)
    : manifest.input?.path
  const info = videoInfo && fs.existsSync(videoInfo) ? await probe(videoInfo) : { width: 1920, height: 1080 }
  const bilingual = format !== 'target'
  const subtitles = await writeSubtitles({
    segments: merged,
    outDir: dir,
    width: info.width,
    height: info.height,
    bilingual,
    font,
    marginV: margin,
    maxDuration: Number(info.duration) || 0,
  })
  await fsp.writeFile(path.join(dir, `transcript.${target}.md`), writeBilingualTranscript(merged), 'utf8')

  let output = null
  if (mux !== 'none') {
    if (!videoInfo || !fs.existsSync(videoInfo)) throw new Error('找不到可重建的视频源')
    if (mux === 'soft') {
      output = path.join(dir, `subtitled.${target}.mp4`)
      await muxSubtitles({ video: videoInfo, subtitles: subtitles.srtPath, out: output, ffmpeg, logPath: path.join(dir, 'mux.log') })
    } else if (mux === 'burn') {
      output = path.join(dir, `subtitled.${target}.hardsub.mp4`)
      await burnSubtitles({ video: videoInfo, ass: subtitles.assPath, out: output, ffmpeg, logPath: path.join(dir, 'burn.log') })
    }
  }

  manifest.artifacts = manifest.artifacts ?? {}
  manifest.artifacts.translations = [
    ...(manifest.artifacts.translations ?? []).filter((entry) => entry.target !== target),
    { target, file: `translation.${target}.json`, state: 'applied' },
  ]
  manifest.artifacts.subtitles = { srt: 'subtitles.srt', ass: 'subtitles.ass' }
  manifest.artifacts.subtitledVideo = output ? path.basename(output) : manifest.artifacts.subtitledVideo
  await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
  return {
    ok: true,
    dir,
    target,
    format: bilingual ? 'bi' : 'target',
    cues: subtitles.cues,
    subtitles: subtitles.srtPath,
    output,
  }
}

function writeBilingualTranscript(segments) {
  const lines = ['# 逐字稿（双语）', '']
  for (const segment of segments) {
    lines.push(`**[${srtTime(segment.start).replace(',', '.')} – ${srtTime(segment.end).replace(',', '.')}]** ${segment.text}`)
    if (segment.translation && segment.translation !== segment.text) lines.push('', `> ${segment.translation}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function resolveSessionDir(value) {
  const candidate = path.resolve(value)
  if (fs.existsSync(path.join(candidate, 'segments.json'))) return candidate
  const roots = [
    path.join(MODULE_ROOT, 'out'),
    path.join(MODULE_ROOT, 'sessions'),
  ]
  for (const root of roots) {
    const direct = path.join(root, value)
    if (fs.existsSync(path.join(direct, 'segments.json'))) return direct
  }
  throw new Error(`找不到会话目录：${value}`)
}

export async function simplifyFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`文件不存在：${file}`)
  const convert = getConverter()
  if (!convert) throw new Error('找不到 opencc-js')
  const text = await fsp.readFile(file, 'utf8')
  const next = convert(text)
  await fsp.writeFile(file, next, 'utf8')
  return { ok: true, file, changed: next !== text }
}
