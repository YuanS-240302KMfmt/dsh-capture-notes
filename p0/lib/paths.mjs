/**
 * Shared path and process helpers for the P0 spikes.
 *
 * P0 borrows the ffmpeg binaries and SenseVoice models from the read-only
 * .video-notes install; the final module will carry its own copies under
 * runtime/ and models/ (P5). Every lookup therefore prefers the module-local
 * path and falls back to .video-notes.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const MODULE_ROOT = path.resolve(import.meta.dirname, '..', '..')
export const P0_ROOT = path.join(MODULE_ROOT, 'p0')
export const TMP_ROOT = path.join(P0_ROOT, '.tmp')
export const NOTES_ROOT = process.env.VIDEO_NOTES_HOME || path.join(MODULE_ROOT, '..', '.video-notes')

function firstExisting(candidates, label) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  const tried = candidates.filter(Boolean).map((candidate) => `  - ${candidate}`).join('\n')
  throw new Error(`找不到 ${label}，尝试过：\n${tried}`)
}

export function ffmpegPath() {
  return firstExisting([
    process.env.FFMPEG_PATH,
    path.join(MODULE_ROOT, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    path.join(NOTES_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  ], 'ffmpeg')
}

export function ffprobePath() {
  return firstExisting([
    process.env.FFPROBE_PATH,
    path.join(MODULE_ROOT, 'runtime', 'ffprobe', 'ffprobe.exe'),
    path.join(NOTES_ROOT, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  ], 'ffprobe')
}

export function naudioPath() {
  return firstExisting([
    path.join(MODULE_ROOT, 'lib', 'NAudio.dll'),
    path.join(MODULE_ROOT, '..', 'live-translate', 'lib', 'NAudio.dll'),
  ], 'NAudio.dll')
}

export function runtimeDir() {
  const candidates = [
    process.env.CAPTURE_NOTES_RUNTIME,
    path.join(MODULE_ROOT, 'runtime', 'node_modules'),
    path.join(NOTES_ROOT, 'node_modules'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sherpa-onnx-node', 'package.json'))) return dir
  }
  throw new Error(`找不到 sherpa-onnx 运行时，尝试过：\n${candidates.map((dir) => `  - ${dir}`).join('\n')}`)
}

export function models() {
  const sensevoice = firstExisting([
    path.join(MODULE_ROOT, 'models', 'sensevoice', 'model.int8.onnx'),
    path.join(NOTES_ROOT, 'models', 'sensevoice', 'model.int8.onnx'),
  ], 'SenseVoice 模型 model.int8.onnx')
  const tokens = path.join(path.dirname(sensevoice), 'tokens.txt')
  if (!fs.existsSync(tokens)) throw new Error(`找不到 tokens.txt：${tokens}`)
  const vad = firstExisting([
    path.join(MODULE_ROOT, 'models', 'silero_vad.onnx'),
    path.join(NOTES_ROOT, 'models', 'silero_vad.onnx'),
  ], 'Silero VAD 模型 silero_vad.onnx')
  return { model: sensevoice, tokens, vad }
}

export function speechWav() {
  return firstExisting([
    process.env.P0_SPEECH_WAV,
    path.join(MODULE_ROOT, '..', 'live-translate', 'tests', 'speech.wav'),
  ], '测试语音 speech.wav')
}

export function powerShell() {
  return process.env.PWSH || 'pwsh.exe'
}

export function freshDir(name) {
  const dir = path.join(TMP_ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Run a child process without piped stdio (the DSH sandbox forbids pipes).
 * stdout is ignored; stderr goes to a log file we can read afterwards.
 */
export async function run(bin, args, { cwd, logPath, stdoutPath, timeoutMs = 0 } = {}) {
  ensureDir(TMP_ROOT)
  const log = logPath ?? path.join(TMP_ROOT, `stderr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.log`)
  ensureDir(path.dirname(log))
  const errFd = fs.openSync(log, 'w')
  const outFd = stdoutPath ? fs.openSync(stdoutPath, 'w') : 'ignore'
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', outFd, errFd] })
      let timer = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { child.kill() } catch {}
          reject(new Error(`${path.basename(bin)} 超时（${timeoutMs} ms）`))
        }, timeoutMs)
      }
      child.on('error', (error) => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        let stderr = ''
        try { stderr = fs.readFileSync(log, 'utf8') } catch {}
        resolve({ code, log, stderr })
      })
    })
  } finally {
    fs.closeSync(errFd)
    if (stdoutPath) fs.closeSync(outFd)
  }
}

/** Minimal RIFF/WAVE reader: enough for fmt + data sizes. */
export function readWav(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是 RIFF/WAVE 文件：${file}`)
  }
  let pos = 12
  let fmt = null
  let dataSize = 0
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(pos + 8),
        channels: buffer.readUInt16LE(pos + 10),
        sampleRate: buffer.readUInt32LE(pos + 12),
        byteRate: buffer.readUInt32LE(pos + 16),
        blockAlign: buffer.readUInt16LE(pos + 20),
        bits: buffer.readUInt16LE(pos + 22),
      }
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buffer.length - pos - 8))
      break
    }
    pos += 8 + size + (size % 2)
  }
  if (!fmt) throw new Error(`WAV 缺少 fmt 块：${file}`)
  const durationSec = fmt.byteRate > 0 ? dataSize / fmt.byteRate : 0
  return { ...fmt, dataSize, durationSec, bytes: buffer.length }
}

/** Read a 16 kHz mono PCM16 WAV into Float32Array (for the ASR spike). */
export function readPcm16(file) {
  const info = readWav(file)
  if (info.channels !== 1 || info.sampleRate !== 16000 || info.bits !== 16 || info.format !== 1) {
    throw new Error(`需要 16 kHz 单声道 PCM16 WAV，实际：${info.sampleRate} Hz / ${info.channels} ch / ${info.bits} bit / format ${info.format}`)
  }
  const buffer = fs.readFileSync(file)
  let pos = 12
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    if (id === 'data') {
      const length = Math.floor(Math.min(size, buffer.length - pos - 8) / 2)
      const samples = new Float32Array(length)
      for (let i = 0; i < length; i++) samples[i] = buffer.readInt16LE(pos + 8 + i * 2) / 32768
      return { samples, info }
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error(`WAV 缺少 data 块：${file}`)
}

export function nowIso() {
  return new Date().toISOString()
}

export function writeReport(dir, name, report) {
  ensureDir(dir)
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}
