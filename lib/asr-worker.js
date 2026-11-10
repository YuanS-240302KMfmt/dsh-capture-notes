/**
 * SenseVoice + Silero VAD worker for capture-notes.
 *
 * One worker owns one lane (system audio or microphone). The host sends 16 kHz
 * mono Float32 batches. The worker posts:
 *   - { type: 'partial', text, lang }  for the rolling in-progress window
 *   - { type: 'final', start, end, text, lang } at every VAD endpoint
 *   - { type: 'ready' | 'stopped' | 'error' }
 *
 * All audio stays in this process; nothing is written to disk.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const SAMPLE_RATE = 16000
const VAD_WINDOW = 512
const PARTIAL_MAX_SECONDS = 3.2
const config = parentPort !== null
  ? workerData
  : JSON.parse(process.env.CAPTURE_NOTES_WORKER_DATA ?? '{}')

function clean(text) {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanLang(value) {
  return String(value ?? '').replace(/<\|/g, '').replace(/\|>/g, '').trim().toLowerCase()
}

function post(message) {
  if (parentPort !== null) parentPort.postMessage(message)
  else if (typeof process.send === 'function') process.send(message)
}

let sherpa
let recognizer
let vad
let vadRemainder = new Float32Array(0)
let pendingChunks = []
let pendingSamples = 0
let pendingStart = 0
let elapsedSamples = 0
let lastPartialText = ''
let lastPartialAt = 0
let stopped = false

function decode(samples) {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  return {
    text: clean(result.text),
    lang: cleanLang(result.lang),
  }
}

function pendingTail(maxSamples) {
  const count = Math.min(pendingSamples, maxSamples)
  if (count <= 0) return new Float32Array(0)
  const out = new Float32Array(count)
  let write = count
  for (let index = pendingChunks.length - 1; index >= 0 && write > 0; index--) {
    const chunk = pendingChunks[index]
    const take = Math.min(chunk.length, write)
    out.set(chunk.subarray(chunk.length - take), write - take)
    write -= take
  }
  return write === 0 ? out : out.subarray(write)
}

/**
 * Drop pending audio that a finished VAD segment already covered. Keeping the
 * tail after the segment avoids clipping the first 0-256 ms of the next phrase
 * when a pause and the next word share one host audio batch.
 */
function dropPendingUpTo(sampleIndex) {
  let count = Math.min(sampleIndex - pendingStart, pendingSamples)
  if (count <= 0) return
  let remaining = count
  while (remaining > 0 && pendingChunks.length > 0) {
    const chunk = pendingChunks[0]
    if (chunk.length <= remaining) {
      pendingChunks.shift()
      remaining -= chunk.length
    } else {
      pendingChunks[0] = chunk.subarray(remaining)
      remaining = 0
    }
  }
  pendingSamples -= count
  pendingStart = sampleIndex
  lastPartialText = ''
  lastPartialAt = 0
}

function drainVad() {
  while (!vad.isEmpty()) {
    const segment = vad.front(false)
    const start = segment.start / SAMPLE_RATE
    const end = start + segment.samples.length / SAMPLE_RATE
    const result = decode(segment.samples)
    vad.pop()
    if (result.text !== '') post({ type: 'final', start, end, text: result.text, lang: result.lang })
    dropPendingUpTo(segment.start + segment.samples.length)
  }
}

function maybePartial() {
  if (stopped) return
  if (pendingSamples < SAMPLE_RATE * 0.65) return
  const now = Date.now()
  if (now - lastPartialAt < config.partialIntervalMs) return
  lastPartialAt = now
  const window = pendingTail(Math.round(SAMPLE_RATE * PARTIAL_MAX_SECONDS))
  if (window.length < SAMPLE_RATE * 0.65) return
  const result = decode(window)
  if (result.text !== '' && result.text !== lastPartialText) {
    lastPartialText = result.text
    post({ type: 'partial', text: result.text, lang: result.lang })
  }
}

function feed(samples) {
  if (stopped || samples.length === 0) return
  elapsedSamples += samples.length
  pendingChunks.push(samples)
  pendingSamples += samples.length

  let input = samples
  if (vadRemainder.length > 0) {
    const merged = new Float32Array(vadRemainder.length + input.length)
    merged.set(vadRemainder, 0)
    merged.set(input, vadRemainder.length)
    input = merged
    vadRemainder = new Float32Array(0)
  }
  let offset = 0
  while (offset + VAD_WINDOW <= input.length) {
    vad.acceptWaveform(input.subarray(offset, offset + VAD_WINDOW))
    offset += VAD_WINDOW
    drainVad()
  }
  if (offset < input.length) vadRemainder = input.slice(offset)
  maybePartial()
}

function finish() {
  if (stopped) return
  stopped = true
  try {
    if (vadRemainder.length > 0) {
      vad.acceptWaveform(vadRemainder)
      vadRemainder = new Float32Array(0)
    }
    vad.flush()
    drainVad()
    if (pendingSamples >= SAMPLE_RATE * 0.5) {
      const window = pendingTail(Math.round(SAMPLE_RATE * PARTIAL_MAX_SECONDS))
      const result = decode(window)
      if (result.text !== '' && result.text !== lastPartialText) {
        const end = elapsedSamples / SAMPLE_RATE
        post({
          type: 'final',
          start: Math.max(0, end - window.length / SAMPLE_RATE),
          end,
          text: result.text,
          lang: result.lang,
        })
      }
    }
  } catch (error) {
    post({ type: 'error', message: `收尾识别失败：${error?.message ?? error}` })
  }
  post({ type: 'stopped' })
}

try {
  const requireFromRuntime = createRequire(path.join(config.runtimeDir, 'sherpa-onnx-node', 'package.json'))
  sherpa = requireFromRuntime('sherpa-onnx-node')
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: config.model,
        language: config.language,
        useInverseTextNormalization: 1,
      },
      tokens: config.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
  })
  vad = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: 0.5,
      minSilenceDuration: 0.35,
      minSpeechDuration: 0.25,
      windowSize: VAD_WINDOW,
      maxSpeechDuration: config.maxSegmentSeconds,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, 60)
  post({ type: 'ready' })
} catch (error) {
  post({ type: 'error', message: `本地识别引擎加载失败：${error?.message ?? error}` })
  throw error
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'audio') {
    if (message.samples instanceof Float32Array) feed(message.samples)
    // File mode uses this as backpressure: next chunk is sent only after the
    // worker has actually processed the previous one.
    post({ type: 'ack', samples: message.samples instanceof Float32Array ? message.samples.length : 0 })
    return
  }
  if (message.type === 'stop') finish()
}

if (parentPort !== null) parentPort.on('message', handleMessage)
else process.on('message', handleMessage)
