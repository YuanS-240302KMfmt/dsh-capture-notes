#!/usr/bin/env node
/**
 * Preflight / post-restart verification for the capture-notes install.
 *
 *   node scripts/verify-install.mjs            # before restarting DSH
 *   node scripts/verify-install.mjs --after     # after DSH has restarted
 *
 * It does not load the plugin or open devices; it checks files, the profile
 * wiring, the installed skill and (after mode) the running window handshake.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const HOME = os.homedir()
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'desktop')
const SKILL = path.join(HOME, '.dsh', 'skills', 'capture-notes')
const AFTER = process.argv.includes('--after')
const dataArgIndex = process.argv.indexOf('--data-dir')
const DATA_DIR = dataArgIndex >= 0
  ? path.resolve(process.argv[dataArgIndex + 1] ?? '')
  : path.resolve(process.env.CAPTURE_NOTES_DATA_DIR ?? path.join(MODULE, 'runtime-data'))

const checks = []
function check(name, ok, detail = '', required = true) {
  checks.push({ name, ok: Boolean(ok), required, detail: String(detail ?? '') })
}

function exists(file) {
  try { return fs.existsSync(file) } catch { return false }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// --- module ---------------------------------------------------------------
const pkgFile = path.join(MODULE, 'package.json')
const pkg = exists(pkgFile) ? readJson(pkgFile) : {}
check('module package', pkg.name === 'dsh-capture-notes', `${pkg.name ?? 'missing'} ${pkg.version ?? ''}`)
for (const file of ['lib/index.js', 'lib/window.ps1', 'lib/asr-worker.js', 'lib/core/media.js', 'lib/core/pipeline.js', 'lib/core/subtitle.js']) {
  check(`file ${file}`, exists(path.join(MODULE, file)), path.join(MODULE, file))
}
check('NAudio.dll', exists(path.join(MODULE, 'lib', 'NAudio.dll')))

// --- assets ---------------------------------------------------------------
check('SenseVoice model', exists(path.join(MODULE, 'models', 'sensevoice', 'model.int8.onnx')))
check('tokens.txt', exists(path.join(MODULE, 'models', 'sensevoice', 'tokens.txt')))
check('Silero VAD', exists(path.join(MODULE, 'models', 'silero_vad.onnx')))
check('sherpa runtime', exists(path.join(MODULE, 'runtime', 'node_modules', 'sherpa-onnx-node', 'package.json')))
check('sherpa native', exists(path.join(MODULE, 'runtime', 'node_modules', 'sherpa-onnx-win-x64', 'package.json')))
check('opencc-js', exists(path.join(MODULE, 'runtime', 'node_modules', 'opencc-js', 'package.json')))
check('ffmpeg', exists(path.join(MODULE, 'runtime', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')))
check('ffprobe', exists(path.join(MODULE, 'runtime', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe')))

// --- profile wiring -------------------------------------------------------
const profilePkgFile = path.join(PROFILE, 'package.json')
const profilePkg = exists(profilePkgFile) ? readJson(profilePkgFile) : {}
const dep = profilePkg.dependencies?.['dsh-capture-notes'] ?? ''
const bundles = profilePkg.dsh?.profile?.bundles ?? []
const link = path.join(PROFILE, 'node_modules', 'dsh-capture-notes')
let linkTarget = ''
try { linkTarget = fs.realpathSync(link) } catch {}
check('profile dependency', dep.startsWith('link:'), dep || 'missing')
check('profile bundles', bundles.includes('dsh-capture-notes'), bundles.join(', '))
check('profile junction', linkTarget !== '' && path.resolve(linkTarget).toLowerCase() === path.resolve(MODULE).toLowerCase(), linkTarget || 'missing')

const profilePatchFile = path.join(PROFILE, 'cordis.patch.yml')
const profilePatch = exists(profilePatchFile) ? fs.readFileSync(profilePatchFile, 'utf8') : ''
check('profile patch has no duplicate insert', !/id:\s*capture-notes/.test(profilePatch), 'capture-notes should be inserted by its own bundle patch')
const modulePatch = exists(path.join(MODULE, 'cordis.patch.yml')) ? fs.readFileSync(path.join(MODULE, 'cordis.patch.yml'), 'utf8') : ''
check('module patch inserts capture-notes', /id:\s*capture-notes/.test(modulePatch), 'cordis.patch.yml')

// --- installed skill ------------------------------------------------------
const skillFile = path.join(SKILL, 'SKILL.md')
const skillSource = path.join(MODULE, 'skill', 'SKILL.md')
const renderSkill = (text) => text.replaceAll('{{MODULE_ROOT}}', MODULE).replace(/\r\n/g, '\n').trim()
const installedSkill = exists(skillFile) ? fs.readFileSync(skillFile, 'utf8') : ''
const renderedSkill = exists(skillSource) ? renderSkill(fs.readFileSync(skillSource, 'utf8')) : ''
check('skill installed', exists(skillFile), skillFile)
check('skill matches source', installedSkill !== '' && renderSkill(installedSkill) === renderedSkill, 'SKILL.md (rendered)')
check('skill template', exists(path.join(SKILL, 'references', 'notes-template.md')))

// --- runtime data (before restart this may not exist yet) -----------------
const liveFile = path.join(DATA_DIR, 'live.json')
const pidFile = path.join(DATA_DIR, 'window.pid')
const errorLog = path.join(DATA_DIR, 'window-error.log')
const nativeDir = path.join(DATA_DIR, 'native')

if (AFTER) {
  check('window data dir', exists(DATA_DIR), DATA_DIR)
  let snapshot = null
  try { snapshot = readJson(liveFile) } catch {}
  check('live.json', snapshot !== null, snapshot ? `status=${snapshot.status}` : 'missing')
  let pid = 0
  try { pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) } catch {}
  let alive = false
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
      alive = true
    } catch (error) {
      // A window spawned by an elevated DSH may reject the probe with EPERM
      // even though it is alive; treat that as "exists".
      if (error?.code === 'EPERM') alive = true
    }
  }
  check('window process', alive, pid > 0 ? `pid=${pid}` : 'window.pid missing')
  check('native dir', exists(nativeDir), nativeDir)
  let fatal = false
  let tail = ''
  if (exists(errorLog)) {
    const lines = fs.readFileSync(errorLog, 'utf8').trim().split(/\r?\n/)
    tail = lines.slice(-12).join('\n')
    fatal = /(Exception|not recognized|cannot find|EACCES|ENOENT)/i.test(tail)
  }
  check('window log has no fatal error', !fatal, tail || 'no window-error.log yet', false)
  check('sessions dir', exists(path.join(MODULE, 'sessions')), path.join(MODULE, 'sessions'), false)
  check('file out dir', exists(path.join(MODULE, 'out')), path.join(MODULE, 'out'), false)
}

const ready = checks.filter((entry) => entry.required).every((entry) => entry.ok)
console.log(JSON.stringify({
  mode: AFTER ? 'after-restart' : 'preflight',
  ready,
  module: MODULE,
  profile: PROFILE,
  skill: SKILL,
  dataDir: DATA_DIR,
  checks,
}, null, 2))

console.error('')
console.error(`${AFTER ? '重启后' : '重启前'}检查：${ready ? 'PASS' : 'FAIL'}`)
for (const entry of checks) {
  if (!entry.ok && entry.required) console.error(`  ✗ ${entry.name} — ${entry.detail}`)
}
if (!ready) process.exit(1)
