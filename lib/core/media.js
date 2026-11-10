/**
 * ffmpeg helpers for capture-notes.
 *
 * All child processes write stdout/stderr to files instead of pipes, matching
 * the DSH sandbox rule that forbids piped stdio. P2 borrows the ffmpeg build
 * from .video-notes; P5 switches to the module-local runtime.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = path.resolve(HERE, '..', '..')
const NOTES_ROOT = process.env.VIDEO_NOTES_HOME || path.join(MODULE_ROOT, '..', '.video-notes')

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

export function resolveFfmpeg(explicit = '') {
  return firstExisting([
    explicit,
    process.env.FFMPEG_PATH,
    path.join(MODULE_ROOT, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    path.join(MODULE_ROOT, 'runtime', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(NOTES_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(MODULE_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  ])
}

export function resolveFfprobe(explicit = '') {
  return firstExisting([
    explicit,
    process.env.FFPROBE_PATH,
    path.join(MODULE_ROOT, 'runtime', 'ffprobe', 'ffprobe.exe'),
    path.join(MODULE_ROOT, 'runtime', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
    path.join(NOTES_ROOT, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
    path.join(MODULE_ROOT, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  ])
}

export async function runToFile(bin, args, { cwd, logPath, stdoutPath, signal } = {}) {
  if (!bin) throw new Error('ffmpeg path is not configured')
  const log = logPath ?? path.join(MODULE_ROOT, 'sessions', `.ffmpeg-${Date.now()}.log`)
  await fsp.mkdir(path.dirname(log), { recursive: true })
  const errFd = fs.openSync(log, 'w')
  const outFd = stdoutPath ? fs.openSync(stdoutPath, 'w') : 'ignore'
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', outFd, errFd] })
      const onAbort = () => {
        try { child.kill() } catch {}
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      child.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        let stderr = ''
        try { stderr = fs.readFileSync(log, 'utf8') } catch {}
        resolve({ code, stderr, log })
      })
    })
  } finally {
    fs.closeSync(errFd)
    if (stdoutPath) fs.closeSync(outFd)
  }
}

export async function probe(file, explicitFfprobe = '') {
  const ffprobe = resolveFfprobe(explicitFfprobe)
  if (!ffprobe) throw new Error('找不到 ffprobe')
  const out = path.join(os.tmpdir(), `capture-notes-probe-${Date.now()}-${process.pid}.json`)
  const result = await runToFile(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,duration,width,height,channels,sample_rate',
    '-of', 'json',
    file,
  ], { logPath: `${out}.log`, stdoutPath: out })
  if (result.code !== 0) throw new Error(`ffprobe 失败：${result.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  const data = JSON.parse(fs.readFileSync(out, 'utf8'))
  await fsp.rm(out, { force: true })
  await fsp.rm(`${out}.log`, { force: true })
  const streams = data.streams ?? []
  return {
    duration: Number.parseFloat(data.format?.duration ?? '0') || 0,
    size: Number.parseInt(data.format?.size ?? '0', 10) || 0,
    streams,
    videoStreams: streams.filter((stream) => stream.codec_type === 'video'),
    audioStreams: streams.filter((stream) => stream.codec_type === 'audio'),
    subtitleStreams: streams.filter((stream) => stream.codec_type === 'subtitle'),
    width: Number.parseInt(streams.find((stream) => stream.codec_type === 'video')?.width ?? '0', 10) || 0,
    height: Number.parseInt(streams.find((stream) => stream.codec_type === 'video')?.height ?? '0', 10) || 0,
  }
}

/**
 * Concatenate MPEG-TS video parts and mux them with one or two WAV tracks.
 * The parts are the crash-tolerant output of the window's ffmpeg recorder.
 */
export async function concatAndMux({
  parts,
  out,
  audioTracks = [],
  trimSec = 0,
  ffmpeg = '',
  logPath = '',
}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('concat: no video parts')
  const bin = resolveFfmpeg(ffmpeg)
  if (!bin) throw new Error('找不到 ffmpeg')
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const listFile = path.join(path.dirname(out), `.concat-${Date.now()}.txt`)
  const list = parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
  await fsp.writeFile(listFile, `${list}\n`, 'utf8')

  const args = ['-hide_banner', '-nostdin', '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listFile]
  for (const track of audioTracks) {
    if (!track?.file || !fs.existsSync(track.file)) continue
    if (trimSec > 0.02) args.push('-ss', trimSec.toFixed(3))
    args.push('-i', track.file)
  }
  const audioCount = audioTracks.filter((track) => track?.file && fs.existsSync(track.file)).length
  args.push('-map', '0:v:0')
  for (let index = 0; index < audioCount; index++) args.push('-map', `${index + 1}:a:0`)
  args.push('-c:v', 'copy')
  if (audioCount > 0) args.push('-c:a', 'aac', '-b:a', '128k')
  args.push('-movflags', '+faststart', '-shortest', out)

  const result = await runToFile(bin, args, { logPath: logPath || `${out}.log` })
  await fsp.rm(listFile, { force: true })
  if (result.code !== 0) {
    throw new Error(`视频封装失败：${result.stderr.trim().split('\n').slice(-4).join(' | ')}`)
  }
  return probe(out)
}

/** Add a subtitle track without re-encoding video or audio. */
export async function muxSubtitles({ video, subtitles, out, language = 'chi', ffmpeg = '', logPath = '', signal = null }) {
  const bin = resolveFfmpeg(ffmpeg)
  if (!bin) throw new Error('找不到 ffmpeg')
  if (!fs.existsSync(video)) throw new Error(`找不到视频：${video}`)
  if (!fs.existsSync(subtitles)) throw new Error(`找不到字幕：${subtitles}`)
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const isMkv = path.extname(out).toLowerCase() === '.mkv'
  const subtitleCodec = isMkv
    ? (path.extname(subtitles).toLowerCase() === '.ass' ? 'ass' : 'srt')
    : 'mov_text'
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', video,
    '-i', subtitles,
    '-map', '0',
    '-map', '1:0',
    '-c', 'copy',
    '-c:s', subtitleCodec,
    '-metadata:s:s:0', `language=${language}`,
    '-metadata:s:s:0', 'title=自动生成',
    '-disposition:s:0', 'default',
  ]
  if (!isMkv) args.push('-movflags', '+faststart')
  args.push(out)
  const result = await runToFile(bin, args, { logPath: logPath || `${out}.log`, signal })
  if (signal?.aborted) {
    await fsp.rm(out, { force: true })
    throw new Error('已取消')
  }
  if (result.code !== 0) throw new Error(`字幕封装失败：${result.stderr.trim().split('\n').slice(-4).join(' | ')}`)
  return { out, sizeBytes: fs.statSync(out).size }
}

/** Burn an ASS file into the picture (re-encodes video). */
export async function burnSubtitles({ video, ass, out, crf = 20, preset = 'veryfast', ffmpeg = '', logPath = '', log = () => {}, signal = null }) {
  const bin = resolveFfmpeg(ffmpeg)
  if (!bin) throw new Error('找不到 ffmpeg')
  if (!fs.existsSync(video)) throw new Error(`找不到视频：${video}`)
  if (!fs.existsSync(ass)) throw new Error(`找不到字幕：${ass}`)
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const info = await probe(video)
  const startedAt = Date.now()
  log(`[burn] encoding ${Math.round(info.duration)}s to ${path.basename(out)}`)
  const result = await runToFile(bin, [
    '-hide_banner', '-nostdin', '-y',
    '-i', path.resolve(video),
    '-vf', `ass=${path.basename(ass)}`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    out,
  ], { cwd: path.dirname(ass), logPath: logPath || `${out}.log`, signal })
  if (signal?.aborted) {
    await fsp.rm(out, { force: true })
    throw new Error('已取消')
  }
  if (result.code !== 0) throw new Error(`字幕烧录失败：${result.stderr.trim().split('\n').slice(-4).join(' | ')}`)
  return { out, sizeBytes: fs.statSync(out).size, elapsedSeconds: (Date.now() - startedAt) / 1000 }
}
