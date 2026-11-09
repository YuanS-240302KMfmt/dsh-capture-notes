/**
 * Self-check for capture-notes. Prints JSON and exits non-zero when something
 * required is missing. Does not load models, open devices, or spawn anything.
 *
 * Run: node scripts/doctor.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const NOTES = process.env.VIDEO_NOTES_HOME || path.join(MODULE, '..', '.video-notes')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

const runtimeDir = firstExisting([
  process.env.CAPTURE_NOTES_RUNTIME,
  path.join(MODULE, 'runtime', 'node_modules'),
  path.join(NOTES, 'node_modules'),
])
check('sherpa runtime', runtimeDir && fs.existsSync(path.join(runtimeDir, 'sherpa-onnx-node', 'package.json')), runtimeDir ?? 'not found')
check('sherpa native', runtimeDir && fs.existsSync(path.join(runtimeDir, 'sherpa-onnx-win-x64', 'package.json')), 'sherpa-onnx-win-x64')
check('opencc-js', runtimeDir && fs.existsSync(path.join(runtimeDir, 'opencc-js', 'package.json')), 'opencc-js')

const sensevoice = firstExisting([
  path.join(MODULE, 'models', 'sensevoice', 'model.int8.onnx'),
  path.join(NOTES, 'models', 'sensevoice', 'model.int8.onnx'),
])
check('SenseVoice model', sensevoice, sensevoice ?? 'not found')
check('tokens.txt', sensevoice && fs.existsSync(path.join(path.dirname(sensevoice), 'tokens.txt')))

const vad = firstExisting([
  path.join(MODULE, 'models', 'silero_vad.onnx'),
  path.join(NOTES, 'models', 'silero_vad.onnx'),
])
check('Silero VAD', vad, vad ?? 'not found')

const naudio = firstExisting([
  path.join(MODULE, 'lib', 'NAudio.dll'),
  path.join(MODULE, '..', 'live-translate', 'lib', 'NAudio.dll'),
])
check('NAudio.dll', naudio, naudio ?? 'not found')

const pwshProbe = spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], {
  stdio: 'ignore',
  timeout: 8_000,
  windowsHide: true,
})
const pwsh = pwshProbe.status === 0 ? 'pwsh.exe' : which('pwsh.exe')
check('PowerShell 7', pwshProbe.status === 0, pwshProbe.status === 0 ? 'pwsh.exe' : (pwsh ?? 'pwsh.exe could not be started'))

const ffmpeg = firstExisting([
  process.env.FFMPEG_PATH,
  path.join(MODULE, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
  path.join(MODULE, 'runtime', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  path.join(NOTES, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
])
check('ffmpeg', ffmpeg, ffmpeg ?? 'not found')

const ffprobe = firstExisting([
  process.env.FFPROBE_PATH,
  path.join(MODULE, 'runtime', 'ffprobe', 'ffprobe.exe'),
  path.join(MODULE, 'runtime', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  path.join(NOTES, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
])
check('ffprobe', ffprobe, ffprobe ?? 'not found')

const windowScript = path.join(MODULE, 'lib', 'window.ps1')
check('window.ps1', fs.existsSync(windowScript), windowScript)

const sessionsDir = process.env.CAPTURE_NOTES_SESSIONS || path.join(MODULE, 'sessions')
let sessionsWritable = false
try {
  fs.mkdirSync(sessionsDir, { recursive: true })
  const probe = path.join(sessionsDir, `.probe-${process.pid}`)
  fs.writeFileSync(probe, 'ok')
  fs.rmSync(probe, { force: true })
  sessionsWritable = true
} catch {}
check('sessions writable', sessionsWritable, sessionsDir)

const ready = checks.every((entry) => entry.ok)
const moduleRuntime = path.resolve(MODULE, 'runtime')
const moduleModels = path.resolve(MODULE, 'models')
const inModule = (value, root) => Boolean(value && path.resolve(value).toLowerCase().startsWith(root.toLowerCase()))
const selfContained = Boolean(
  inModule(runtimeDir, moduleRuntime)
  && inModule(sensevoice, moduleModels)
  && inModule(vad, moduleModels)
  && inModule(ffmpeg, moduleRuntime)
  && inModule(ffprobe, moduleRuntime)
)
console.log(JSON.stringify({
  ready,
  selfContained,
  runtimeSource: inModule(runtimeDir, moduleRuntime) ? 'module' : (runtimeDir ? 'external' : 'missing'),
  module: MODULE,
  runtimeDir,
  models: { sensevoice, vad },
  tools: { naudio, pwsh, ffmpeg, ffprobe },
  sessionsDir,
  checks,
}, null, 2))
process.exit(ready ? 0 : 1)
