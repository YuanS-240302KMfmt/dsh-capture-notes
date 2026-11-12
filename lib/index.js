/**
 * Host half of capture-notes — P1 live lane.
 *
 * The WPF window owns audio capture and writes a small file protocol:
 *
 *   native/start.json              { lanes, language, target, formats }
 *   native/chunks/<lane>/*.pcm     16 kHz mono PCM16, 0.5 s per file
 *   native/audio/<lane>.wav        archive at the device format
 *   native/stop.request            stop and flush
 *
 * The host watches that directory, feeds one SenseVoice worker per lane,
 * translates final segments through the built-in translator, and writes
 * live.json back for the window to render. On stop it moves the archives into
 * sessions/<id>/ and writes transcript.md / .srt / segments.json / session.json.
 *
 * The plugin never writes to .video-notes; it only borrows its model and
 * runtime paths until P5 copies them into the module.
 */

import { randomBytes } from 'node:crypto'
import { fork, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { burnSubtitles, concatAndMux, muxSubtitles, probe, resolveFfmpeg, runToFile } from './core/media.js'
import { processFile } from './core/pipeline.js'
import { writeSubtitles } from './core/subtitle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE)
const NOTES_ROOT = process.env.VIDEO_NOTES_HOME || path.join(PKG_ROOT, '..', '.video-notes')
const NOTES_RUNTIME = path.join(NOTES_ROOT, 'node_modules')
const NOTES_MODELS = path.join(NOTES_ROOT, 'models')

const SOURCES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']
const TARGETS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']
const PROVIDERS = ['auto', 'bing', 'google']
const LANES = ['system', 'mic']
const LANE_LABELS = { system: '系统', mic: '麦克风' }
const SNAPSHOT_SEGMENTS = 8
const MAX_SESSIONS = 2

class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorBody(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  console.error('[capture-notes] unexpected failure:', error)
  return { code: 'INTERNAL', message: '录屏字幕台发生内部错误，请重试' }
}

function handler(fn) {
  return async (request) => {
    try {
      return await fn(request)
    } catch (error) {
      return json({ ok: false, error: errorBody(error) })
    }
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function resolveOptions(config = {}) {
  return {
    runtimeDir: asString(config.runtimeDir),
    modelDir: asString(config.modelDir),
    vadModelPath: asString(config.vadModelPath),
    ffmpegPath: asString(config.ffmpegPath),
    threads: asInt(config.threads, 6, 1, 16),
    maxSegmentSeconds: asInt(config.maxSegmentSeconds, 8, 2, 30),
    partialIntervalMs: asInt(config.partialIntervalMs, 900, 300, 3000),
    translationTimeoutMs: asInt(config.translationTimeoutMs, 10_000, 2_000, 60_000),
    idleStopMs: asInt(config.idleStopMs, 180_000, 30_000, 3_600_000),
    sessionsDir: asString(config.sessionsDir, path.join(PKG_ROOT, 'sessions')),
    fileOutRoot: asString(config.fileOutRoot, path.join(PKG_ROOT, 'out')),
    fileWorkRoot: asString(config.fileWorkRoot, path.join(PKG_ROOT, 'work')),
    windowDataDir: asString(config.windowDataDir, path.join(PKG_ROOT, 'runtime-data')),
    nativeWindow: config.nativeWindow !== false,
    openOnStart: config.openOnStart !== false,
    processMode: ['auto', 'worker', 'fork'].includes(config.processMode) ? config.processMode : 'auto',
  }
}

function hasSherpa(dir) {
  return dir !== '' && fs.existsSync(path.join(dir, 'sherpa-onnx-node', 'package.json'))
}

function runtimeCandidates(options) {
  const values = [
    options.runtimeDir,
    process.env.CAPTURE_NOTES_RUNTIME ?? '',
    path.join(PKG_ROOT, 'runtime', 'node_modules'),
    NOTES_RUNTIME,
    path.join(PKG_ROOT, 'node_modules'),
  ]
  const out = []
  for (const value of values) {
    if (!value) continue
    const dir = path.resolve(value)
    if (hasSherpa(dir)) return dir
    if (hasSherpa(path.join(dir, 'node_modules'))) return path.join(dir, 'node_modules')
    out.push(dir)
  }
  return out
}

function sensevoiceIn(dir) {
  if (!dir) return null
  for (const candidate of [dir, path.join(dir, 'sensevoice')]) {
    for (const modelName of ['model.int8.onnx', 'model.onnx']) {
      const model = path.join(candidate, modelName)
      const tokens = path.join(candidate, 'tokens.txt')
      if (fs.existsSync(model) && fs.existsSync(tokens)) return { modelDir: candidate, model, tokens }
    }
  }
  return null
}

function resolveEngine(options) {
  const runtime = runtimeCandidates(options)
  const runtimeDir = Array.isArray(runtime) ? runtime[0] : runtime
  if (!runtimeDir || !hasSherpa(runtimeDir)) {
    return {
      ok: false,
      message: `找不到 sherpa-onnx 运行时。请确认 ${NOTES_RUNTIME} 存在，或在插件配置里设置 runtimeDir。`,
    }
  }
  const notesRoot = path.dirname(runtimeDir)
  const modelCandidates = [
    options.modelDir,
    process.env.CAPTURE_NOTES_MODEL_DIR ?? '',
    path.join(PKG_ROOT, 'models', 'sensevoice'),
    path.join(notesRoot, 'models', 'sensevoice'),
    path.join(NOTES_MODELS, 'sensevoice'),
  ]
  let model = null
  for (const candidate of modelCandidates) {
    model = sensevoiceIn(candidate)
    if (model) break
  }
  if (!model) {
    return {
      ok: false,
      message: `找不到 SenseVoice 模型（model.int8.onnx + tokens.txt）。请确认 ${NOTES_MODELS}\\sensevoice 存在，或在插件配置里设置 modelDir。`,
    }
  }
  const vadCandidates = [
    options.vadModelPath,
    process.env.CAPTURE_NOTES_VAD ?? '',
    path.join(PKG_ROOT, 'models', 'silero_vad.onnx'),
    path.join(notesRoot, 'models', 'silero_vad.onnx'),
    path.join(NOTES_MODELS, 'silero_vad.onnx'),
  ]
  const vad = vadCandidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? ''
  if (!vad) {
    return {
      ok: false,
      message: `找不到 Silero VAD 模型。请确认 ${NOTES_MODELS}\\silero_vad.onnx 存在，或在插件配置里设置 vadModelPath。`,
    }
  }
  return { ok: true, runtimeDir, model: model.model, modelDir: model.modelDir, tokens: model.tokens, vad }
}

function int16ToFloat(buffer) {
  const view = new DataView(buffer)
  const length = Math.floor(buffer.byteLength / 2)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

function baseLang(tag) {
  const value = String(tag ?? '').toLowerCase().replace(/_/g, '-').replace(/[<|>]/g, '')
  if (value === 'yue' || value.startsWith('yue-') || value === 'cantonese') return 'zh'
  if (value.startsWith('zh')) return 'zh'
  if (value.startsWith('en')) return 'en'
  if (value.startsWith('ja')) return 'ja'
  if (value.startsWith('ko')) return 'ko'
  return value.split('-')[0]
}

function sameLanguage(source, target) {
  return baseLang(source) !== '' && baseLang(source) === baseLang(target)
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

function ts(seconds, comma = false) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const r = ms % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(r, 3)}`
}

function localStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function powerShellCandidates() {
  return [process.env.DSH_PWSH, 'pwsh.exe', 'powershell.exe'].filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  )
}

function readWavInfo(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(4096)
      const read = fs.readSync(fd, head, 0, head.length, 0)
      if (read < 12 || head.toString('ascii', 0, 4) !== 'RIFF') return null
      let pos = 12
      while (pos + 8 <= read) {
        const id = head.toString('ascii', pos, pos + 4)
        const size = head.readUInt32LE(pos + 4)
        if (id === 'fmt ') {
          return {
            format: head.readUInt16LE(pos + 8),
            channels: head.readUInt16LE(pos + 10),
            sampleRate: head.readUInt32LE(pos + 12),
            bits: head.readUInt16LE(pos + 22),
          }
        }
        pos += 8 + size + (size % 2)
      }
      return null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function buildSnapshot(session) {
  const elapsedMs = session.firstAudioAt
    ? (session.status === 'stopped' ? session.elapsedMs : Date.now() - session.firstAudioAt)
    : 0
  const lanes = {}
  for (const [key, lane] of Object.entries(session.lanes)) {
    lanes[key] = { active: lane.active, ready: lane.ready, partial: lane.partial, error: lane.error }
  }
  return {
    status: session.status,
    sessionId: session.id,
    mode: session.mode ?? 'live',
    video: session.video
      ? { file: path.basename(session.video.file), duration: session.video.duration, width: session.video.width, height: session.video.height }
      : null,
    videoError: session.videoError ?? '',
    post: session.post ?? null,
    language: session.language,
    target: session.target,
    error: session.error ?? '',
    elapsedMs,
    lanes,
    segments: session.segments.slice(-SNAPSHOT_SEGMENTS).map((segment) => ({
      id: segment.id,
      lane: segment.lane,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      translation: segment.translation,
      state: segment.state,
    })),
    savedFiles: session.files ?? [],
    updatedAt: new Date().toISOString(),
  }
}

async function writeSnapshotObject(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(value), 'utf8')
  await fsp.rename(temporary, file)
}

async function writeSnapshotFile(file, session) {
  await writeSnapshotObject(file, buildSnapshot(session))
}

function createWindowController(options) {
  const script = path.join(HERE, 'window.ps1')
  const candidates = powerShellCandidates()
  const available = options.nativeWindow
    && process.platform === 'win32'
    && fs.existsSync(script)
    && candidates.length > 0
  const dataDir = options.windowDataDir
  const ffmpeg = resolveFfmpeg(options.ffmpegPath) ?? ''
  const liveFile = path.join(dataDir, 'live.json')
  const showFile = path.join(dataDir, 'show.request')
  const quitFile = path.join(dataDir, 'quit.request')
  const aliveFile = path.join(dataDir, 'alive.txt')
  const windowPidFile = path.join(dataDir, 'window.pid')
  const errorLog = path.join(dataDir, 'window-error.log')
  let child = null
  let disposed = false

  const alive = () => {
    try {
      const pid = Number.parseInt(fs.readFileSync(windowPidFile, 'utf8').trim(), 10)
      if (!Number.isFinite(pid) || pid <= 0) return false
      process.kill(pid, 0)
      return Date.now() - fs.statSync(aliveFile).mtimeMs < 8_000
    } catch {
      return false
    }
  }

  const launchAt = (index) => {
    if (disposed || !available || index >= candidates.length) return
    const executable = candidates[index]
    let proc
    try {
      fs.appendFileSync(errorLog, `\n[${new Date().toISOString()}] launch ${executable} data=${dataDir} parent=${process.pid}\n`)
      const errFd = fs.openSync(errorLog, 'a')
      try {
        proc = spawn(
          executable,
          ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-DataDir', dataDir, '-ParentPid', String(process.pid), '-FfmpegPath', ffmpeg],
          { stdio: ['ignore', 'ignore', errFd], windowsHide: true },
        )
      } finally {
        fs.closeSync(errFd)
      }
    } catch (error) {
      console.error(`[capture-notes] ${executable} failed:`, error)
      launchAt(index + 1)
      return
    }
    child = proc
    proc.once('error', (error) => {
      const current = child === proc
      if (current) child = null
      if (disposed || !current) return
      console.error(`[capture-notes] ${executable} failed:`, error)
      launchAt(index + 1)
    })
    proc.once('exit', (code) => {
      if (child === proc) child = null
      try { fs.appendFileSync(errorLog, `[${new Date().toISOString()}] exit code=${String(code)}\n`) } catch {}
    })
  }

  return {
    available,
    dataDir,
    liveFile,
    isRunning: () => child !== null || alive(),
    async show() {
      if (!available) return false
      try { await fsp.rm(quitFile, { force: true }) } catch {}
      await fsp.mkdir(dataDir, { recursive: true })
      await fsp.writeFile(showFile, new Date().toISOString(), 'utf8')
      if (child === null && !alive()) launchAt(0)
      return true
    },
    dispose() {
      disposed = true
      try { fs.writeFileSync(quitFile, new Date().toISOString(), 'utf8') } catch {}
      if (child !== null) {
        try { child.kill() } catch {}
        child = null
      }
      try {
        fs.rmSync(aliveFile, { force: true })
        fs.rmSync(windowPidFile, { force: true })
      } catch {}
    },
  }
}

function mapGoogleTarget(target) {
  return target
}

async function googleTranslate(text, source, target, signal) {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  const form = new URLSearchParams({
    client: 'gtx',
    sl: source || 'auto',
    tl: mapGoogleTarget(target),
    dt: 't',
    q: text,
  })
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal,
  })
  if (!response.ok) throw new Error(`Google 翻译返回 HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload?.[0])) throw new Error('Google 翻译返回了无法解析的数据')
  return payload[0].map((part) => (Array.isArray(part) ? String(part[0] ?? '') : '')).join('').trim()
}

function translatorOf(ctx) {
  try {
    return ctx.get('translator')
  } catch {
    return undefined
  }
}

async function translate(ctx, session, text, signal) {
  const source = session.language === 'auto' ? undefined : (session.language === 'yue' ? 'zh' : session.language)
  const service = translatorOf(ctx)
  if (service) {
    try {
      const spec = service.resolve({
        text,
        targetLanguage: session.target,
        ...(source === undefined ? {} : { sourceLanguage: source }),
        ...(session.provider === 'auto' ? {} : { provider: session.provider }),
      })
      return await service.translate(spec, signal)
    } catch (error) {
      if (session.provider !== 'auto') throw error
      console.warn('[capture-notes] built-in translator failed, trying Google fallback:', error?.message ?? error)
    }
  }
  return googleTranslate(text, source, session.target, signal)
}

function emit(session) {
  session.onSnapshot?.()
}

async function pumpTranslations(ctx, session) {
  if (session.translating) return
  session.translating = true
  try {
    while (session.translateQueue.length > 0) {
      const segment = session.translateQueue.shift()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('translation timeout')), session.options.translationTimeoutMs)
      try {
        const text = await translate(ctx, session, segment.text, controller.signal)
        segment.translation = cleanText(text)
        segment.state = 'done'
      } catch (error) {
        segment.state = 'error'
        console.warn('[capture-notes] translation failed:', error?.message ?? error)
      } finally {
        clearTimeout(timer)
      }
      schedulePersist(session)
      emit(session)
    }
  } finally {
    session.translating = false
  }
}

function setStatus(session, status, detail = '') {
  session.status = status
  if (status === 'error') {
    session.error = detail
    session.closed = true
    session.closedAt = Date.now()
    for (const lane of Object.values(session.lanes)) lane.stopWorker?.()
  }
  emit(session)
}

function createSession(ctx, options, request) {
  const engine = resolveEngine(options)
  if (!engine.ok) throw new AppError('ENGINE_MISSING', engine.message)
  const language = SOURCES.includes(request.source) ? request.source : 'auto'
  const target = TARGETS.includes(request.target) ? request.target : 'zh-CN'
  const provider = PROVIDERS.includes(request.provider) ? request.provider : 'auto'
  const requested = Array.isArray(request.lanes)
    ? request.lanes
    : (typeof request.lanes === 'string' ? [request.lanes] : ['system'])
  const lanes = [...new Set(requested.filter((lane) => LANES.includes(lane)))]
  if (lanes.length === 0) lanes.push('system')

  const now = new Date()
  const id = `cn-${localStamp(now)}-${randomBytes(2).toString('hex')}`
  const dir = path.join(options.sessionsDir, id)
  fs.mkdirSync(dir, { recursive: true })

  const session = {
    id,
    dir,
    ctx,
    options,
    engine,
    mode: request.mode === 'record' ? 'record' : 'live',
    language,
    target,
    provider,
    status: 'starting',
    error: null,
    video: null,
    videoError: null,
    post: null,
    segmentPersistTimer: null,
    lanes: {},
    segments: [],
    translateQueue: [],
    translating: false,
    segmentSeq: 0,
    createdAt: now.getTime(),
    startedAt: now.getTime(),
    firstAudioAt: 0,
    lastAudioAt: 0,
    elapsedMs: 0,
    stopping: false,
    finalized: false,
    closed: false,
    closedAt: 0,
    files: [],
    onSnapshot: null,
  }

  const perLaneThreads = lanes.length > 1
    ? Math.max(2, Math.floor(options.threads / 2))
    : options.threads
  for (const key of lanes) {
    session.lanes[key] = {
      key,
      active: true,
      ready: false,
      stopped: false,
      partial: '',
      error: null,
      worker: null,
      post: null,
      stopWorker: null,
      firstAudioAt: 0,
      lastAudioAt: 0,
      threads: perLaneThreads,
    }
  }

  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    schema: 1,
    id,
    mode: session.mode,
    status: 'starting',
    createdAt: now.toISOString(),
    languages: { source: language, target },
    sources: Object.fromEntries(LANES.map((key) => [key, Boolean(session.lanes[key])])),
  }, null, 2), 'utf8')

  for (const lane of Object.values(session.lanes)) startLaneWorker(ctx, options, session, lane)
  emit(session)
  return session
}

function startLaneWorker(ctx, options, session, lane) {
  const workerData = {
    runtimeDir: session.engine.runtimeDir,
    model: session.engine.model,
    tokens: session.engine.tokens,
    vad: session.engine.vad,
    language: session.language,
    threads: lane.threads,
    maxSegmentSeconds: options.maxSegmentSeconds,
    partialIntervalMs: options.partialIntervalMs,
    lane: lane.key,
  }
  const workerUrl = new URL('./asr-worker.js', import.meta.url)
  const useFork = options.processMode === 'fork'
    || (options.processMode === 'auto' && process.versions.electron !== undefined)
  let worker
  let stderrTail = ''
  if (useFork) {
    worker = fork(fileURLToPath(workerUrl), [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CAPTURE_NOTES_WORKER_DATA: JSON.stringify(workerData),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: [],
      windowsHide: true,
    })
    worker.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000)
      console.error(`[capture-notes] ${lane.key} asr stderr:`, String(chunk).trim())
    })
  } else {
    worker = new Worker(workerUrl, { name: `capture-notes-${lane.key}`, workerData })
  }
  lane.worker = worker
  lane.post = (message) => {
    try {
      if (typeof worker.postMessage === 'function') worker.postMessage(message)
      else worker.send(message)
    } catch {}
  }
  lane.stopWorker = () => {
    try {
      if (typeof worker.terminate === 'function') void worker.terminate()
      else worker.kill()
    } catch {}
  }

  worker.on('message', (message) => {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        lane.ready = true
        if (Object.values(session.lanes).every((candidate) => candidate.ready || !candidate.active)) {
          if (session.status === 'starting') setStatus(session, 'listening')
        }
        break
      case 'partial': {
        const text = cleanText(message.text)
        if (text !== '' && text !== lane.partial) {
          lane.partial = text
          emit(session)
        }
        break
      }
      case 'final':
        onFinal(session, lane, message)
        break
      case 'error':
        lane.error = asString(message.message, '本地识别失败')
        lane.active = false
        lane.partial = ''
        lane.stopWorker?.()
        if (!Object.values(session.lanes).some((candidate) => candidate.active)) {
          setStatus(session, 'error', `${LANE_LABELS[lane.key]}识别失败：${lane.error}`)
        } else {
          emit(session)
        }
        break
      case 'stopped':
        lane.stopped = true
        if (Object.values(session.lanes).every((candidate) => candidate.stopped || !candidate.active)) {
          void finalizeStop(session)
        }
        break
      default:
        break
    }
  })
  worker.on('error', (error) => {
    console.error(`[capture-notes] ${lane.key} worker error:`, error)
    lane.error = String(error?.message ?? error)
    lane.active = false
    if (!Object.values(session.lanes).some((candidate) => candidate.active)) {
      setStatus(session, 'error', `${LANE_LABELS[lane.key]}识别进程出错：${lane.error}`)
    }
  })
  worker.on('exit', (code) => {
    if (session.status === 'stopped' || session.closed || lane.stopped) return
    if (code !== 0) {
      const detail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' ')
      lane.error = `识别进程已退出（code ${code}）${detail === '' ? '' : `：${detail}`}`
      lane.active = false
      if (!Object.values(session.lanes).some((candidate) => candidate.active)) {
        setStatus(session, 'error', `${LANE_LABELS[lane.key]}识别失败：${lane.error}`)
      }
    }
  })
}

function onFinal(session, lane, message) {
  const text = cleanText(message.text)
  lane.partial = ''
  if (text === '') {
    emit(session)
    return
  }
  const segment = {
    id: `s${pad(++session.segmentSeq, 5)}`,
    lane: lane.key,
    start: Number.isFinite(message.start) ? Number(message.start) : 0,
    end: Number.isFinite(message.end) ? Number(message.end) : 0,
    text,
    lang: asString(message.lang).toLowerCase(),
    translation: '',
    state: 'pending',
  }
  session.segments.push(segment)
  schedulePersist(session)
  emit(session)

  if (sameLanguage(segment.lang, session.target)) {
    segment.translation = segment.text
    segment.state = 'same'
    emit(session)
    return
  }
  session.translateQueue.push(segment)
  void pumpTranslations(session.ctx, session)
}

function stopSession(session) {
  if (session.status === 'stopped' || session.status === 'error' || session.stopping) return
  session.stopping = true
  session.elapsedMs = session.firstAudioAt ? Date.now() - session.firstAudioAt : 0
  setStatus(session, 'stopping')
  session.stopTimer = setTimeout(() => { void finalizeStop(session, 'timeout') }, 4_000)
  const active = Object.values(session.lanes).filter((lane) => lane.active)
  if (active.length === 0) {
    void finalizeStop(session, 'no-active-lane')
    return
  }
  for (const lane of active) lane.post?.({ type: 'stop' })
}

function buildSegments(session) {
  return [...session.segments]
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({
      id: segment.id,
      start: Number(segment.start.toFixed(3)),
      end: Number(segment.end.toFixed(3)),
      text: segment.text,
      lang: segment.lang,
      source: segment.lane,
      speaker: null,
      speakers: [],
      overlap: false,
      translation: segment.translation,
      translationState: segment.state === 'pending' ? 'pending' : segment.state,
    }))
}

function buildTranscriptMarkdown(session) {
  const laneNames = Object.keys(session.lanes).map((key) => LANE_LABELS[key]).join('+')
  const lines = [
    '# 实时字幕记录',
    '',
    `> ${new Date(session.createdAt).toLocaleString('zh-CN')} · ${laneNames} · ${session.language} → ${session.target} · ${session.segments.length} 段 · SenseVoice int8`,
    `> 会话：${session.id}`,
    '',
  ]
  for (const segment of [...session.segments].sort((a, b) => a.start - b.start)) {
    lines.push(`**[${ts(segment.start)} – ${ts(segment.end)}] [${LANE_LABELS[segment.lane]}]** ${segment.text}`)
    if (segment.translation && segment.translation !== segment.text) {
      lines.push('')
      lines.push(`> ${segment.translation}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildTranscriptSrt(session) {
  return [...session.segments]
    .sort((a, b) => a.start - b.start)
    .map((segment, index) => {
      const text = segment.translation && segment.translation !== segment.text
        ? `[${LANE_LABELS[segment.lane]}] ${segment.text}\n${segment.translation}`
        : `[${LANE_LABELS[segment.lane]}] ${segment.text}`
      return `${index + 1}\n${ts(segment.start, true)} --> ${ts(segment.end, true)}\n${text}\n`
    })
    .join('\n')
}

function buildSessionManifest(session) {
  const tracks = []
  for (const key of Object.keys(session.lanes)) {
    const file = path.join(session.dir, 'audio', `${key}.wav`)
    const info = fs.existsSync(file) ? readWavInfo(file) : null
    if (!info) continue
    tracks.push({
      role: key,
      file: `audio/${key}.wav`,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bits: info.bits,
    })
  }
  const endedAt = new Date()
  return {
    schema: 1,
    id: session.id,
    mode: session.mode,
    status: session.status === 'stopped' ? 'completed' : session.status,
    createdAt: new Date(session.createdAt).toISOString(),
    endedAt: endedAt.toISOString(),
    languages: { source: session.language, target: session.target },
    sources: Object.fromEntries(LANES.map((key) => [key, Boolean(session.lanes[key])])),
    input: { kind: 'device' },
    recording: {
      video: session.video ? 'screen.mp4' : null,
      videoInfo: session.video
        ? { duration: session.video.duration, width: session.video.width, height: session.video.height, sizeBytes: session.video.sizeBytes }
        : null,
      videoError: session.videoError ?? null,
      tracks,
    },
    artifacts: {
      transcript: 'transcript.md',
      srt: 'transcript.srt',
      segments: 'segments.json',
      subtitles: null,
      translations: [],
      subtitledVideo: null,
      notes: null,
    },
    stats: {
      segments: session.segments.length,
      durationSec: Number((session.elapsedMs / 1000).toFixed(1)),
      rtf: null,
    },
    crashRecovered: false,
  }
}

async function moveArchive(session, laneKey) {
  const source = path.join(session.options.windowDataDir, 'native', 'audio', `${laneKey}.wav`)
  if (!fs.existsSync(source)) return null
  const targetDir = path.join(session.dir, 'audio')
  await fsp.mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, `${laneKey}.wav`)
  try {
    await fsp.rename(source, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await fsp.copyFile(source, target)
    await fsp.rm(source, { force: true })
  }
  return target
}

function videoPartsDir(options) {
  return path.join(options.windowDataDir, 'native', 'video')
}

async function dropCorruptTail(parts, session) {
  if (parts.length <= 1) return parts
  const last = parts[parts.length - 1]
  const ffmpeg = resolveFfmpeg(session.options.ffmpegPath)
  if (!ffmpeg) return parts
  try {
    const check = await runToFile(
      ffmpeg,
      ['-hide_banner', '-v', 'error', '-i', last, '-f', 'null', '-'],
      { logPath: path.join(session.dir, 'part-check.log') },
    )
    if (check.code === 0 && check.stderr.trim() === '') return parts
    console.warn(`[capture-notes] dropping truncated last video part: ${path.basename(last)}`)
    await fsp.rm(last, { force: true })
    return parts.slice(0, -1)
  } catch (error) {
    console.warn('[capture-notes] last video part check failed:', error?.message ?? error)
    return parts
  }
}

async function finalizeVideo(session) {
  const dir = videoPartsDir(session.options)
  let names = []
  try {
    names = (await fsp.readdir(dir))
      .filter((name) => /^part-\d+\.ts$/i.test(name))
      .filter((name) => {
        try { return fs.statSync(path.join(dir, name)).size > 1000 } catch { return false }
      })
      .sort()
  } catch {
    return null
  }
  if (names.length === 0) return null
  const parts = await dropCorruptTail(names.map((name) => path.join(dir, name)), session)
  if (parts.length === 0) return null
  const audioTracks = []
  for (const key of ['system', 'mic']) {
    const file = path.join(session.dir, 'audio', `${key}.wav`)
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) audioTracks.push({ file })
  }
  let trimSec = 0
  try {
    const timing = JSON.parse(await fsp.readFile(path.join(session.options.windowDataDir, 'native', 'record.json'), 'utf8'))
    const audioAt = Date.parse(timing.audioStartedAt)
    const videoAt = Date.parse(timing.videoStartedAt)
    if (Number.isFinite(audioAt) && Number.isFinite(videoAt)) trimSec = Math.max(0, (videoAt - audioAt) / 1000)
  } catch {}
  const out = path.join(session.dir, 'screen.mp4')
  const info = await concatAndMux({
    parts,
    out,
    audioTracks,
    trimSec,
    ffmpeg: session.options.ffmpegPath,
    logPath: path.join(session.dir, 'mux.log'),
  })
  session.video = {
    file: out,
    duration: info.duration,
    width: info.width,
    height: info.height,
    sizeBytes: info.size,
  }
  for (const part of parts) {
    try { await fsp.rm(part, { force: true }) } catch {}
  }
  try { await fsp.rm(path.join(session.options.windowDataDir, 'native', 'record.json'), { force: true }) } catch {}
  return info
}

async function persistSegments(session) {
  const file = path.join(session.dir, 'segments.json')
  const temporary = `${file}.${process.pid}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(buildSegments(session), null, 2), 'utf8')
  await fsp.rename(temporary, file)
}

function schedulePersist(session) {
  if (session.segmentPersistTimer) return
  session.segmentPersistTimer = setTimeout(() => {
    session.segmentPersistTimer = null
    void persistSegments(session).catch(() => {})
  }, 800)
}

async function finalizeStop(session, reason = '') {
  if (session.finalized) return
  session.finalized = true
  if (session.stopTimer) clearTimeout(session.stopTimer)
  if (session.segmentPersistTimer) clearTimeout(session.segmentPersistTimer)
  session.stopTimer = null
  session.segmentPersistTimer = null
  const translateDeadline = Date.now() + 2_000
  while ((session.translating || session.translateQueue.length > 0) && Date.now() < translateDeadline) {
    await sleep(100)
  }
  for (const lane of Object.values(session.lanes)) lane.stopWorker?.()
  if (!session.firstAudioAt) session.elapsedMs = 0
  else if (session.status !== 'stopped') session.elapsedMs = Date.now() - session.firstAudioAt

  try {
    for (const key of Object.keys(session.lanes)) await moveArchive(session, key)
  } catch (error) {
    console.error('[capture-notes] could not move the archive:', error)
  }

  if (session.mode === 'record') {
    try {
      await finalizeVideo(session)
    } catch (error) {
      session.videoError = String(error?.message ?? error)
      console.error('[capture-notes] could not finalize the recording:', error)
    }
  }

  const segments = buildSegments(session)
  const files = []
  try {
    await fsp.mkdir(session.dir, { recursive: true })
    await fsp.writeFile(path.join(session.dir, 'segments.json'), JSON.stringify(segments, null, 2), 'utf8')
    await fsp.writeFile(path.join(session.dir, 'transcript.md'), buildTranscriptMarkdown(session), 'utf8')
    await fsp.writeFile(path.join(session.dir, 'transcript.srt'), buildTranscriptSrt(session), 'utf8')
    session.status = 'stopped'
    const manifest = buildSessionManifest(session)
    if (reason !== '') manifest.stopReason = reason
    await fsp.writeFile(path.join(session.dir, 'session.json'), JSON.stringify(manifest, null, 2), 'utf8')
    files.push(
      path.join(session.dir, 'transcript.md'),
      path.join(session.dir, 'transcript.srt'),
      path.join(session.dir, 'segments.json'),
      path.join(session.dir, 'session.json'),
    )
    if (session.video) files.push(session.video.file)
  } catch (error) {
    console.error('[capture-notes] could not save the session:', error)
    session.status = 'error'
    session.error = `保存会话失败：${error?.message ?? error}`
  }
  try {
    await fsp.rm(path.join(session.options.windowDataDir, 'native', 'active.json'), { force: true })
  } catch {}
  session.files = files
  session.closed = true
  session.closedAt = Date.now()
  emit(session)
}

async function writePostState(options, state) {
  await writeSnapshotObject(path.join(options.windowDataDir, 'native', 'post.json'), state)
}

async function updateSessionArtifacts(session, mode, output, subtitles) {
  const file = path.join(session.dir, 'session.json')
  const manifest = JSON.parse(await fsp.readFile(file, 'utf8'))
  manifest.artifacts = manifest.artifacts ?? {}
  manifest.artifacts.subtitles = { srt: 'subtitles.srt', ass: 'subtitles.ass' }
  if (mode === 'srt') manifest.artifacts.subtitledVideo = null
  else manifest.artifacts.subtitledVideo = path.basename(output)
  if (subtitles) manifest.artifacts.subtitleCues = subtitles.cues
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8')
  session.files = [...new Set([...(session.files ?? []), output, subtitles?.srtPath, subtitles?.assPath].filter(Boolean))]
}

async function runPostProcess(session, mode) {
  const startedAt = Date.now()
  const state = {
    status: 'running',
    mode,
    sessionId: session.id,
    startedAt: new Date().toISOString(),
    output: null,
    error: '',
  }
  session.post = state
  await writePostState(session.options, state)
  try {
    if (!session.video || !fs.existsSync(session.video.file)) throw new Error('这次会话没有可用的录屏文件')
    const info = await probe(session.video.file)
    const segments = JSON.parse(await fsp.readFile(path.join(session.dir, 'segments.json'), 'utf8'))
    const subtitles = await writeSubtitles({
      segments,
      outDir: session.dir,
      width: info.width,
      height: info.height,
      bilingual: true,
      maxDuration: Number(info.duration) || 0,
    })
    let output = null
    if (mode === 'soft') {
      output = path.join(session.dir, 'screen.soft.mp4')
      await muxSubtitles({ video: session.video.file, subtitles: subtitles.srtPath, out: output, logPath: path.join(session.dir, 'post-mux.log') })
    } else if (mode === 'burn') {
      output = path.join(session.dir, 'screen.hardsub.mp4')
      await burnSubtitles({ video: session.video.file, ass: subtitles.assPath, out: output, logPath: path.join(session.dir, 'post-burn.log') })
    } else if (mode === 'srt') {
      output = subtitles.srtPath
    } else {
      throw new Error(`未知的后处理模式：${mode}`)
    }
    const done = {
      ...state,
      status: 'done',
      output,
      outputName: path.basename(output),
      cues: subtitles.cues,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      finishedAt: new Date().toISOString(),
    }
    session.post = done
    await writePostState(session.options, done)
    await updateSessionArtifacts(session, mode, output, subtitles)
  } catch (error) {
    const failed = {
      ...state,
      status: 'error',
      error: String(error?.message ?? error),
      finishedAt: new Date().toISOString(),
    }
    session.post = failed
    await writePostState(session.options, failed)
  }
  emit(session)
}

function buildIdleSnapshot() {  return {
    status: 'idle',
    sessionId: '',
    language: 'auto',
    target: 'zh-CN',
    error: '',
    elapsedMs: 0,
    lanes: {
      system: { active: true, ready: false, partial: '', error: null },
      mic: { active: false, ready: false, partial: '', error: null },
    },
    segments: [],
    savedFiles: [],
    updatedAt: new Date().toISOString(),
  }
}

async function recoverOrphanRecording(options) {
  const nativeDir = path.join(options.windowDataDir, 'native')
  const videoDir = path.join(nativeDir, 'video')
  let names = []
  try {
    names = (await fsp.readdir(videoDir))
      .filter((name) => /^part-\d+\.ts$/i.test(name))
      .filter((name) => {
        try { return fs.statSync(path.join(videoDir, name)).size > 1000 } catch { return false }
      })
      .sort()
  } catch {
    return null
  }
  if (names.length === 0) return null
  const newest = Math.max(...names.map((name) => fs.statSync(path.join(videoDir, name)).mtimeMs))
  // A file touched seconds ago may belong to a recording that is still running.
  if (Date.now() - newest < 5_000) return null

  const id = `recovered-${localStamp()}`
  const dir = path.join(options.sessionsDir, id)
  const audioDir = path.join(dir, 'audio')
  await fsp.mkdir(audioDir, { recursive: true })
  const audioTracks = []
  const tracks = []
  for (const key of ['system', 'mic']) {
    const source = path.join(nativeDir, 'audio', `${key}.wav`)
    if (!fs.existsSync(source) || fs.statSync(source).size < 1000) continue
    const target = path.join(audioDir, `${key}.wav`)
    try {
      await fsp.rename(source, target)
    } catch {
      await fsp.copyFile(source, target)
      await fsp.rm(source, { force: true })
    }
    audioTracks.push({ file: target })
    const info = readWavInfo(target)
    if (info) tracks.push({ role: key, file: `audio/${key}.wav`, ...info })
  }

  const parts = names.map((name) => path.join(videoDir, name))
  const usableParts = await dropCorruptTail(parts, { dir, options })
  if (usableParts.length === 0) {
    throw new Error('恢复失败：所有 TS 分片均无法解码')
  }
  const out = path.join(dir, 'screen.mp4')
  const info = await concatAndMux({
    parts: usableParts,
    out,
    audioTracks,
    ffmpeg: options.ffmpegPath,
    logPath: path.join(dir, 'mux.log'),
  })
  const now = new Date()
  const manifest = {
    schema: 1,
    id,
    mode: 'record',
    status: 'aborted',
    crashRecovered: true,
    createdAt: now.toISOString(),
    endedAt: now.toISOString(),
    languages: { source: 'auto', target: 'zh-CN' },
    sources: { system: tracks.some((track) => track.role === 'system'), mic: tracks.some((track) => track.role === 'mic') },
    input: { kind: 'device' },
    recording: {
      video: 'screen.mp4',
      videoInfo: { duration: info.duration, width: info.width, height: info.height, sizeBytes: info.size },
      videoError: null,
      tracks,
    },
    artifacts: { transcript: null, srt: null, segments: null, subtitles: null, translations: [], subtitledVideo: null, notes: null },
    stats: { segments: 0, durationSec: Number((info.duration || 0).toFixed(1)), rtf: null },
  }
  await fsp.writeFile(path.join(dir, 'session.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await fsp.writeFile(path.join(dir, 'RECOVERY.md'), [
    '# 崩溃恢复记录',
    '',
    `> ${now.toLocaleString('zh-CN')} · 从 native/video 的 ${usableParts.length} 个分片恢复`,
    '',
    `- 视频：\`screen.mp4\`（${Math.round(info.duration)}s，${info.width}×${info.height}）`,
    `- 音轨：${tracks.map((track) => track.role).join('、') || '无'}`,
    '- 逐字稿：崩溃前的增量文件未保留，可从音频重新转写',
    '',
  ].join('\n'), 'utf8')
  for (const part of usableParts) {
    try { await fsp.rm(part, { force: true }) } catch {}
  }
  try { await fsp.rm(path.join(nativeDir, 'record.json'), { force: true }) } catch {}
  try { await fsp.rm(path.join(nativeDir, 'active.json'), { force: true }) } catch {}
  console.log(`[capture-notes] recovered an interrupted recording into ${dir}`)
  return { id, dir, info }
}

async function writeFileState(options, state) {
  await writeSnapshotObject(path.join(options.windowDataDir, 'native', 'file.json'), state)
}

const SUMMARY_SYSTEM_PROMPT = [
  '你是「录屏字幕台」的中文内容纪要助手。',
  '只使用用户提供的逐字稿，不补充逐字稿没有的事实，不编造人名、时间、数字或结论。',
  '输出简体中文 Markdown。先判断内容类型（会议/课程/访谈/其他），再写：标题、概览、带 [HH:MM:SS] 的要点、结论或行动项。',
  '行动项尽量写清谁/做什么/何时；逐字稿没有提到就写“片段未提及”。',
  '推断出的内容标注“（推断）”。不要输出繁体中文，不要输出与逐字稿无关的客套话。',
].join('\n')

const SUMMARY_CHUNK_CHARS = 18_000

function summaryClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':')
}

function withinDirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function splitSummaryTranscript(text, maxChars = SUMMARY_CHUNK_CHARS) {
  const lines = String(text).split(/\r?\n/)
  const chunks = []
  let current = ''
  for (const line of lines) {
    if (current !== '' && current.length + line.length + 1 > maxChars) {
      chunks.push(current)
      current = ''
    }
    current += (current === '' ? '' : '\n') + line
  }
  if (current.trim() !== '') chunks.push(current)
  return chunks.length > 0 ? chunks : ['']
}

async function readSummaryTranscript(dir, manifest) {
  const transcriptName = String(manifest?.artifacts?.transcript || 'transcript.md')
  const transcriptFile = path.join(dir, transcriptName)
  if (fs.existsSync(transcriptFile)) {
    const text = await fsp.readFile(transcriptFile, 'utf8')
    if (text.trim() !== '') return text
  }
  const segmentsFile = path.join(dir, 'segments.json')
  if (!fs.existsSync(segmentsFile)) return ''
  const segments = JSON.parse(await fsp.readFile(segmentsFile, 'utf8'))
  if (!Array.isArray(segments) || segments.length === 0) return ''
  return segments.map((segment) => {
    const lane = segment?.lane === 'mic' ? '麦克风' : '系统'
    return `[${summaryClock(segment?.start)}] [${lane}] ${String(segment?.text ?? '')}`
  }).join('\n')
}

async function callSummaryModel(ctx, prompt, signal) {
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new AppError('NO_LLM', '当前 DSH 没有挂载模型，无法生成纪要。')
  }
  let selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    ?? ctx.agentDefaultModel?.currentSelection?.()
  if (!selection?.provider || !selection?.model) {
    const provider = llm.listProviders?.()[0]
    const models = provider ? await llm.listModels?.(provider.id) : []
    if (!provider || !models?.[0]) {
      throw new AppError('NO_MODEL', '当前没有可用的 DSH 模型，请先在设置里选择模型。')
    }
    selection = { provider: provider.id, model: models[0].id }
  }
  const options = {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 4096,
    temperature: 0.2,
    signal,
  }
  let text = ''
  const stream = await llm.stream(options)
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    } else if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'aborted') throw new AppError('CANCELLED', '已取消纪要生成。')
      if (kind === 'error') throw new AppError('MODEL_ERROR', '模型生成纪要失败。')
    }
  }
  return text.trim()
}

function summaryRequestPrompt(transcript, index, total, title) {
  return [
    `这是《${title}》逐字稿的第 ${index}/${total} 部分。`,
    '请提取这一部分的事实、观点、结论和行动项，保留原文中的时间戳；',
    '输出简洁的简体中文要点，作为后续合并的中间材料。不要写最终标题，不要补充逐字稿没有的内容。',
    '',
    transcript,
  ].join('\n')
}

function summaryFinalPrompt(transcript, title) {
  return [
    `请为《${title}》生成完整的内容纪要，使用简体中文 Markdown。`,
    '结构：标题、概览（2–4 句）、带 [HH:MM:SS] 的要点、结论/行动项。',
    '内容类型自动判断（会议/课程/访谈/其他）；只使用逐字稿内容；推断标注“（推断）”；缺失写“片段未提及”。',
    '',
    transcript,
  ].join('\n')
}

function summaryMergePrompt(partials, title) {
  return [
    `以下是《${title}》逐字稿各部分生成的中间摘要。请合并、去重，生成最终完整纪要。`,
    '使用简体中文 Markdown：标题、概览（2–4 句）、带 [HH:MM:SS] 的要点、结论/行动项。',
    '只使用这些中间摘要，不添加新事实；推断标注“（推断）”；缺失写“片段未提及”。',
    '',
    partials.map((part, index) => `## 第 ${index + 1} 部分\n${part}`).join('\n\n'),
  ].join('\n')
}

async function writeSummaryState(options, state) {
  await writeSnapshotObject(path.join(options.windowDataDir, 'native', 'summary.json'), state)
}

async function runSummaryJob(ctx, options, request, job) {
  const dir = path.resolve(String(request?.dir ?? ''))
  const startedAt = Date.now()
  const allowed = [options.sessionsDir, options.fileOutRoot].some((root) => withinDirectory(root, dir))
  const state = {
    status: 'running',
    stage: '读取逐字稿',
    percent: 2,
    dir,
    startedAt: new Date().toISOString(),
  }
  await writeSummaryState(options, state)
  try {
    if (!allowed) throw new AppError('BAD_DIR', '纪要目标目录不在会话或文件输出目录内。')
    const manifestPath = path.join(dir, 'session.json')
    if (!fs.existsSync(manifestPath)) throw new AppError('NO_SESSION', '找不到 session.json。')
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    const transcript = await readSummaryTranscript(dir, manifest)
    if (transcript.trim() === '') {
      throw new AppError('NO_TRANSCRIPT', '没有逐字稿，无法生成纪要。')
    }
    const title = String(manifest?.input?.path ? path.basename(String(manifest.input.path)) : path.basename(dir))
    const chunks = splitSummaryTranscript(transcript)
    let notes
    if (chunks.length === 1) {
      state.stage = '生成纪要'
      state.percent = 20
      await writeSummaryState(options, state)
      notes = await callSummaryModel(ctx, summaryFinalPrompt(transcript, title), job.controller.signal)
    } else {
      const partials = []
      for (let index = 0; index < chunks.length; index++) {
        if (job.controller.signal.aborted) throw new AppError('CANCELLED', '已取消纪要生成。')
        state.stage = `生成分段 ${index + 1}/${chunks.length}`
        state.percent = Math.round(10 + (index / chunks.length) * 60)
        await writeSummaryState(options, state)
        partials.push(await callSummaryModel(ctx, summaryRequestPrompt(chunks[index], index + 1, chunks.length, title), job.controller.signal))
      }
      state.stage = '合并纪要'
      state.percent = 80
      await writeSummaryState(options, state)
      notes = await callSummaryModel(ctx, summaryMergePrompt(partials, title), job.controller.signal)
    }
    if (job.controller.signal.aborted) throw new AppError('CANCELLED', '已取消纪要生成。')
    notes = String(notes ?? '').trim()
    if (notes === '') throw new AppError('EMPTY_NOTES', '模型没有返回纪要内容。')
    if (!/^#\s/m.test(notes)) notes = `# ${title} · 内容纪要\n\n${notes}`
    const notesFile = path.join(dir, 'notes.md')
    await fsp.writeFile(notesFile, `${notes.trim()}\n`, 'utf8')
    manifest.artifacts ||= {}
    manifest.artifacts.notes = 'notes.md'
    manifest.summary = {
      generatedAt: new Date().toISOString(),
      model: ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? ctx.agentDefaultModel?.currentSelection?.() ?? null,
      chunks: chunks.length,
    }
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeSummaryState(options, {
      ...state,
      status: 'done',
      stage: 'done',
      percent: 100,
      output: 'notes.md',
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    })
  } catch (error) {
    const cancelled = job.controller.signal.aborted || error?.code === 'CANCELLED'
    await writeSummaryState(options, {
      ...state,
      status: cancelled ? 'cancelled' : 'error',
      stage: cancelled ? 'cancelled' : 'error',
      error: cancelled ? '已取消' : String(error?.message ?? error),
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    })
  }
}

async function runFileJob(options, request, job) {
  const startedAt = Date.now()
  let lastWrite = 0
  const state = {
    status: 'running',
    stage: '准备',
    percent: 0,
    detail: '',
    input: String(request?.input ?? ''),
    startedAt: new Date().toISOString(),
  }
  await writeFileState(options, state)
  try {
    const result = await processFile({
      input: request?.input,
      language: request?.language ?? 'auto',
      threads: options.threads,
      subtitle: request?.subtitle ?? 'soft',
      limit: Number(request?.limit ?? 0),
      keepAudio: Boolean(request?.keepAudio),
      subsOnly: Boolean(request?.subsOnly),
      font: request?.font ?? 'Microsoft YaHei',
      margin: Number.isFinite(Number(request?.margin)) ? Number(request.margin) : 0.05,
      ffmpeg: options.ffmpegPath,
      outRoot: options.fileOutRoot,
      workRoot: options.fileWorkRoot,
      signal: job.controller.signal,
      onProgress: (progress) => {
        state.stage = progress.stage ?? state.stage
        state.percent = Number.isFinite(progress.percent) ? progress.percent : state.percent
        state.detail = progress.detail ?? ''
        if (Date.now() - lastWrite > 400) {
          lastWrite = Date.now()
          void writeFileState(options, { ...state })
        }
      },
    })
    await writeFileState(options, {
      ...state,
      status: 'done',
      stage: 'done',
      percent: 100,
      detail: '完成',
      outDir: result.outDir,
      workDir: result.workDir,
      result,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    })
  } catch (error) {
    const cancelled = job.controller.signal.aborted
    await writeFileState(options, {
      ...state,
      status: cancelled ? 'cancelled' : 'error',
      stage: cancelled ? 'cancelled' : 'error',
      error: String(error?.message ?? error),
      cancelled,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    })
  }
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  const sessions = new Map()
  const windowController = createWindowController(options)
  void recoverOrphanRecording(options).catch((error) => {
    console.error('[capture-notes] orphan recording recovery failed:', error)
  })
  if (options.openOnStart && windowController.available) {
    void (async () => {
      try {
        await writeSnapshotObject(windowController.liveFile, buildIdleSnapshot())
      } catch {}
      await windowController.show()
    })()
  }

  let snapshotSession = null
  let snapshotTimer = null
  let snapshotBusy = false
  let snapshotAgain = false
  const flushSnapshot = async () => {
    const session = snapshotSession
    if (session === null) return
    if (snapshotBusy) {
      snapshotAgain = true
      return
    }
    snapshotBusy = true
    try {
      await writeSnapshotFile(windowController.liveFile, session)
    } catch (error) {
      console.error('[capture-notes] could not write the snapshot:', error)
    } finally {
      snapshotBusy = false
      if (snapshotAgain) {
        snapshotAgain = false
        scheduleSnapshot(snapshotSession)
      }
    }
  }
  const scheduleSnapshot = (session) => {
    snapshotSession = session
    if (snapshotTimer !== null) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      void flushSnapshot()
    }, 80)
  }

  const nativeDir = path.join(windowController.dataDir, 'native')
  const nativeChunksDir = path.join(nativeDir, 'chunks')
  const nativeStartFile = path.join(nativeDir, 'start.json')
  const nativeStopFile = path.join(nativeDir, 'stop.request')
  const nativeActiveFile = path.join(nativeDir, 'active.json')
  const nativePostFile = path.join(nativeDir, 'post.request')
  const nativeFileRequest = path.join(nativeDir, 'file.request')
  const nativeFileCancel = path.join(nativeDir, 'file.cancel')
  const nativeSummaryRequest = path.join(nativeDir, 'summary.request')
  const nativeSummaryCancel = path.join(nativeDir, 'summary.cancel')
  let nativeSession = null
  let fileJob = null
  let summaryJob = null
  let fileRequestSeen = 0
  let fileCancelSeen = 0
  let summaryRequestSeen = 0
  let summaryCancelSeen = 0
  let nativePolling = false
  let nativeStartSeen = 0
  let nativeStopSeen = 0
  let nativePostSeen = 0

  const ingestChunks = async (session) => {
    for (const lane of Object.values(session.lanes)) {
      if (!lane.active) continue
      const dir = path.join(nativeChunksDir, lane.key)
      let names = []
      try {
        names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.pcm')).sort()
      } catch {}
      for (const name of names.slice(0, 80)) {
        const file = path.join(dir, name)
        let buffer
        try {
          buffer = await fsp.readFile(file)
        } catch {
          continue
        }
        try {
          await fsp.rm(file, { force: true })
        } catch {}
        if (buffer.length < 2) continue
        const samples = int16ToFloat(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length))
        lane.firstAudioAt ||= Date.now()
        lane.lastAudioAt = Date.now()
        session.firstAudioAt ||= Date.now()
        session.lastAudioAt = Date.now()
        lane.post?.({ type: 'audio', samples })
      }
    }
  }

  const startNativeSession = async (request) => {
    if (fileJob !== null) {
      try {
        await writeSnapshotObject(windowController.liveFile, {
          ...buildIdleSnapshot(),
          status: 'error',
          error: '正在处理文件任务，请等待完成或取消后再开始录制。',
        })
      } catch {}
      return
    }
    if (nativeSession !== null && !nativeSession.closed) stopSession(nativeSession)
    nativeSession = null
    let session
    try {
      session = createSession(ctx, options, {
        lanes: request?.lanes,
        source: request?.language,
        target: request?.target,
        provider: request?.provider,
        mode: request?.mode,
      })
    } catch (error) {
      try {
        await writeSnapshotObject(windowController.liveFile, {
          ...buildIdleSnapshot(),
          status: 'error',
          error: error instanceof AppError ? error.message : `无法启动本地识别：${error?.message ?? error}`,
        })
      } catch {}
      return
    }
    session.native = true
    session.onSnapshot = () => scheduleSnapshot(session)
    nativeSession = session
    sessions.set(session.id, session)
    try {
      await fsp.writeFile(nativeActiveFile, JSON.stringify({ id: session.id, dir: session.dir }), 'utf8')
    } catch {}
    scheduleSnapshot(session)
  }

  const pollNative = async () => {
    if (nativePolling) return
    nativePolling = true
    try {
      try {
        const info = await fsp.stat(nativeStartFile)
        if (info.mtimeMs > nativeStartSeen) {
          nativeStartSeen = info.mtimeMs
          let request = {}
          try {
            request = JSON.parse(await fsp.readFile(nativeStartFile, 'utf8'))
          } catch {}
          await fsp.rm(nativeStartFile, { force: true })
          await startNativeSession(request)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] start.json failed:', error)
      }

      if (nativeSession !== null && (nativeSession.closed || nativeSession.status === 'error')) {
        nativeSession = null
      }

      if (nativeSession !== null && nativeSession.status !== 'stopped' && nativeSession.status !== 'stopping') {
        await ingestChunks(nativeSession)
        if (nativeSession.firstAudioAt && Date.now() - nativeSession.lastAudioAt > options.idleStopMs) {
          stopSession(nativeSession)
        }
      }

      try {
        const info = await fsp.stat(nativeStopFile)
        if (info.mtimeMs > nativeStopSeen) {
          nativeStopSeen = info.mtimeMs
          await fsp.rm(nativeStopFile, { force: true })
          if (nativeSession !== null) {
            await ingestChunks(nativeSession)
            stopSession(nativeSession)
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] stop.request failed:', error)
      }

      try {
        const info = await fsp.stat(nativePostFile)
        if (info.mtimeMs > nativePostSeen) {
          nativePostSeen = info.mtimeMs
          let request = {}
          try {
            request = JSON.parse(await fsp.readFile(nativePostFile, 'utf8'))
          } catch {}
          await fsp.rm(nativePostFile, { force: true })
          const session = sessions.get(request?.sessionId)
          if (!session) {
            await writePostState(options, {
              status: 'error',
              mode: String(request?.mode ?? ''),
              sessionId: String(request?.sessionId ?? ''),
              error: '找不到会话，可能已被清理',
            })
          } else {
            const mode = ['soft', 'burn', 'srt'].includes(request?.mode) ? request.mode : 'srt'
            void runPostProcess(session, mode)
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] post.request failed:', error)
      }

      try {
        const info = await fsp.stat(nativeSummaryCancel)
        if (info.mtimeMs > summaryCancelSeen) {
          summaryCancelSeen = info.mtimeMs
          await fsp.rm(nativeSummaryCancel, { force: true })
          summaryJob?.controller?.abort()
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] summary.cancel failed:', error)
      }

      try {
        const info = await fsp.stat(nativeSummaryRequest)
        if (info.mtimeMs > summaryRequestSeen) {
          summaryRequestSeen = info.mtimeMs
          let request = {}
          try {
            request = JSON.parse(await fsp.readFile(nativeSummaryRequest, 'utf8'))
          } catch {}
          await fsp.rm(nativeSummaryRequest, { force: true })
          if (summaryJob !== null) {
            await writeSummaryState(options, {
              status: 'error',
              stage: 'error',
              error: '已有纪要在生成，请先等待或取消。',
              dir: String(request?.dir ?? ''),
            })
          } else if (nativeSession !== null || fileJob !== null) {
            await writeSummaryState(options, {
              status: 'error',
              stage: 'error',
              error: '正在录制或处理文件，完成后再生成纪要。',
              dir: String(request?.dir ?? ''),
            })
          } else {
            const job = { controller: new AbortController(), startedAt: Date.now(), request }
            summaryJob = job
            void runSummaryJob(ctx, options, request, job).finally(() => {
              if (summaryJob === job) summaryJob = null
            })
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] summary.request failed:', error)
      }

      try {
        const info = await fsp.stat(nativeFileCancel)
        if (info.mtimeMs > fileCancelSeen) {
          fileCancelSeen = info.mtimeMs
          await fsp.rm(nativeFileCancel, { force: true })
          fileJob?.controller?.abort()
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] file.cancel failed:', error)
      }

      try {
        const info = await fsp.stat(nativeFileRequest)
        if (info.mtimeMs > fileRequestSeen) {
          fileRequestSeen = info.mtimeMs
          let request = {}
          try {
            request = JSON.parse(await fsp.readFile(nativeFileRequest, 'utf8'))
          } catch {}
          await fsp.rm(nativeFileRequest, { force: true })
          if (fileJob !== null) {
            await writeFileState(options, { status: 'error', error: '已有文件任务在运行，请先等待或取消。', input: String(request?.input ?? '') })
          } else if (nativeSession !== null && !nativeSession.closed) {
            await writeFileState(options, { status: 'error', error: '正在录制/监听，结束后再处理文件。', input: String(request?.input ?? '') })
          } else {
            const job = { controller: new AbortController(), startedAt: Date.now(), request }
            fileJob = job
            void runFileJob(options, request, job).finally(() => {
              if (fileJob === job) fileJob = null
            })
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error('[capture-notes] file.request failed:', error)
      }
    } finally {
      nativePolling = false
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void pollNative() }, 250)
    return () => clearInterval(timer)
  }, 'capture-notes: native capture')

  const route = (routePath, methods, fn) => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: routePath,
        methods,
        requestBody: 'buffered',
        fetch: handler(fn),
      }),
      `capture-notes: ${routePath}`,
    )
  }

  route('/api/capture-notes/health', ['GET'], async () => {
    const engine = resolveEngine(options)
    let translator = false
    try { translator = ctx.get('translator') !== undefined } catch {}
    return json({
      ok: true,
      engine: engine.ok
        ? { model: path.basename(engine.model), runtime: engine.runtimeDir }
        : { ok: false, message: engine.message },
      translator,
      nativeWindow: windowController.available,
      sessions: sessions.size,
      fileJob: fileJob === null ? 'idle' : 'running',
      sessionsDir: options.sessionsDir,
      fileOutRoot: options.fileOutRoot,
    })
  })

  route('/api/capture-notes/window', ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      return json({ ok: true, available: windowController.available, running: windowController.isRunning(), dataDir: windowController.dataDir })
    }
    const body = await request.json().catch(() => ({}))
    if (body?.action === 'show') await windowController.show()
    return json({ ok: true, available: windowController.available, running: windowController.isRunning() })
  })

  route('/api/capture-notes/stop', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({}))
    const session = sessions.get(body?.id)
    if (!session) return json({ ok: true })
    stopSession(session)
    return json({ ok: true, state: session.status })
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const session of [...sessions.values()]) {
        if (session.closed && now - session.closedAt > 10 * 60_000) sessions.delete(session.id)
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, 'capture-notes: cleanup')

  ctx.effect(() => () => {
    if (snapshotTimer !== null) clearTimeout(snapshotTimer)
    if (nativeSession !== null) stopSession(nativeSession)
    if (fileJob !== null) fileJob.controller.abort()
    if (summaryJob !== null) summaryJob.controller.abort()
    for (const session of sessions.values()) {
      for (const lane of Object.values(session.lanes)) lane.stopWorker?.()
    }
    sessions.clear()
    windowController.dispose()
  }, 'capture-notes: native window')
}

export const name = 'capture-notes'
export const inject = ['connection', 'agentDefaultModel']
