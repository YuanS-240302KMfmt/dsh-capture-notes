/**
 * P0 / v2 — can two SenseVoice lanes run concurrently within the latency budget?
 *
 * Feeds the same 16 kHz mono clip to one lane (baseline) and then to two lanes
 * at once (system + microphone). Reports wall time, RTF, per-segment decode
 * latency and RSS growth. The two-lane run is the one that matters: its RTF is
 * wall time divided by the total audio processed (2 × clip length).
 *
 * Usage: node v2-dual-asr.mjs [--threads 3] [--clip path.wav]
 */

import { Worker } from 'node:worker_threads'
import {
  freshDir,
  models,
  readPcm16,
  runtimeDir,
  speechWav,
  writeReport,
} from './lib/paths.mjs'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const threads = Number.parseInt(argValue('--threads', '3'), 10)
const clipPath = argValue('--clip', speechWav())

const dir = freshDir('v2')
const engine = models()
const runtime = runtimeDir()
const { samples, info } = readPcm16(clipPath)
const audioSec = samples.length / 16000
const CHUNK_SAMPLES = 8000 // 0.5 s
const WORKER_URL = new URL('./lib/asr-stream.worker.mjs', import.meta.url)

function makeWorker() {
  return new Worker(WORKER_URL, {
    workerData: {
      runtimeDir: runtime,
      model: engine.model,
      tokens: engine.tokens,
      vadPath: engine.vad,
      threads,
      language: 'auto',
      maxSegmentSeconds: 8,
    },
  })
}

function waitFor(worker, wanted) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (wanted.includes(message.type)) {
        cleanup()
        resolve(message)
      } else if (message.type === 'error' || message.type === 'init-error') {
        cleanup()
        reject(new Error(message.message))
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      worker.off('message', onMessage)
      worker.off('error', onError)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
  })
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))))
  return Number(sorted[index].toFixed(1))
}

async function measure(lanes) {
  const errors = []
  const rssBefore = process.memoryUsage().rss
  const spawnedAt = Date.now()
  const workers = Array.from({ length: lanes }, () => makeWorker())
  for (const worker of workers) {
    worker.on('message', (message) => {
      if (message.type === 'error' || message.type === 'init-error') errors.push(message.message)
    })
  }
  try {
    await Promise.all(workers.map((worker) => waitFor(worker, ['ready'])))
    const loadMs = Date.now() - spawnedAt
    const startedAt = Date.now()
    for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
      const slice = samples.slice(offset, offset + CHUNK_SAMPLES)
      for (const worker of workers) worker.postMessage({ type: 'audio', samples: slice })
    }
    for (const worker of workers) worker.postMessage({ type: 'stop' })
    const results = await Promise.all(workers.map((worker) => waitFor(worker, ['done'])))
    const wallMs = Date.now() - startedAt
    const decodeMs = results.flatMap((result) => result.decodeMs)
    const segments = results.reduce((sum, result) => sum + result.segments, 0)
    const rssAfter = process.memoryUsage().rss
    return {
      lanes,
      loadMs,
      wallMs,
      rtf: Number((wallMs / 1000 / (audioSec * lanes)).toFixed(4)),
      throughputX: Number((audioSec * lanes / (wallMs / 1000)).toFixed(1)),
      segments,
      decodeP50Ms: percentile(decodeMs, 0.5),
      decodeP95Ms: percentile(decodeMs, 0.95),
      decodeCount: decodeMs.length,
      rssDeltaMB: Number(((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)),
      errors,
      texts: results.map((result) => result.texts.join(' ')),
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
}

console.log(`[v2] clip: ${clipPath} (${audioSec.toFixed(2)}s, ${info.sampleRate} Hz)`)
console.log(`[v2] runtime: ${runtime}`)
console.log(`[v2] threads per lane: ${threads}`)

const baseline = await measure(1)
console.log(`[v2] baseline: wall=${baseline.wallMs}ms rtf=${baseline.rtf} segments=${baseline.segments}`)

const dual = await measure(2)
console.log(`[v2] dual    : wall=${dual.wallMs}ms rtf=${dual.rtf} throughput=${dual.throughputX}x segments=${dual.segments}`)

const checks = {
  baselineRecognized: baseline.segments > 0,
  bothLanesRecognized: dual.segments >= 2,
  dualRtfUnder020: dual.rtf <= 0.2,
  noErrors: baseline.errors.length === 0 && dual.errors.length === 0,
}
const ok = Object.values(checks).every(Boolean)

const report = {
  ok,
  dir,
  clip: { file: clipPath, durationSec: Number(audioSec.toFixed(3)), sampleRate: info.sampleRate },
  runtime,
  threadsPerLane: threads,
  baseline,
  dual,
  checks,
}
const reportFile = writeReport(dir, 'report.json', report)

console.log('')
console.log(`baseline text: ${baseline.texts[0]?.slice(0, 80) ?? ''}`)
console.log(`dual text    : ${dual.texts.map((text) => text.slice(0, 60)).join(' | ')}`)
console.log(`decode p50/p95: ${dual.decodeP50Ms}/${dual.decodeP95Ms} ms, rss +${dual.rssDeltaMB} MB`)
console.log(`checks       : ${JSON.stringify(checks)}`)
console.log(`report       : ${reportFile}`)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
