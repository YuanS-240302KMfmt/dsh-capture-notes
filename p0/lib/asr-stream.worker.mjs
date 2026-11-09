/**
 * One streaming ASR lane for the P0 dual-stream spike.
 *
 * Each worker owns its own SenseVoice recognizer and Silero VAD, mirroring the
 * production plan: one lane per audio source (system / microphone), no shared
 * decoder state. The host only forwards 16 kHz mono Float32 samples.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const SAMPLE_RATE = 16000
const VAD_WINDOW = 512
const config = workerData

function clean(text) {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

let recognizer = null
let vad = null
let remainder = new Float32Array(0)
const decodeMs = []
const texts = []
let segments = 0
let stopped = false

function decode(samples) {
  const startedAt = performance.now()
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  decodeMs.push(performance.now() - startedAt)
  return result
}

function drain() {
  while (!vad.isEmpty()) {
    const segment = vad.front(false)
    const result = decode(segment.samples)
    vad.pop()
    const text = clean(result.text)
    if (text !== '') {
      segments++
      texts.push(text)
    }
  }
}

function feed(samples) {
  if (stopped || samples.length === 0) return
  let input = samples
  if (remainder.length > 0) {
    const merged = new Float32Array(remainder.length + input.length)
    merged.set(remainder, 0)
    merged.set(input, remainder.length)
    input = merged
    remainder = new Float32Array(0)
  }
  let offset = 0
  while (offset + VAD_WINDOW <= input.length) {
    vad.acceptWaveform(input.subarray(offset, offset + VAD_WINDOW))
    offset += VAD_WINDOW
    drain()
  }
  if (offset < input.length) remainder = input.slice(offset)
}

function finish() {
  if (stopped) return
  stopped = true
  try {
    if (remainder.length > 0) {
      vad.acceptWaveform(remainder)
      remainder = new Float32Array(0)
    }
    vad.flush()
    drain()
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error?.message ?? error) })
  }
  parentPort.postMessage({ type: 'done', segments, decodeMs, texts })
}

try {
  const requireFrom = createRequire(path.join(config.runtimeDir, 'sherpa-onnx-node', 'package.json'))
  const sherpa = requireFrom('sherpa-onnx-node')
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
      model: config.vadPath,
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
  parentPort.postMessage({ type: 'ready', at: Date.now() })
} catch (error) {
  parentPort.postMessage({ type: 'init-error', message: String(error?.message ?? error) })
  throw error
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'audio' && message.samples instanceof Float32Array) feed(message.samples)
  else if (message.type === 'stop') finish()
})
