import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)
const TMP = path.join(HERE, '.tmp-summary-e2e')
const dataDir = path.join(TMP, 'data')
const sessionsDir = path.join(TMP, 'sessions')
const sessionDir = path.join(sessionsDir, 'summary-demo')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'native'), { recursive: true })
fs.mkdirSync(sessionDir, { recursive: true })

fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
  schema: 1,
  id: 'summary-demo',
  mode: 'record',
  status: 'completed',
  artifacts: { transcript: 'transcript.md', notes: null },
  input: { kind: 'device' },
}, null, 2), 'utf8')
fs.writeFileSync(path.join(sessionDir, 'transcript.md'), [
  '# 实时字幕记录',
  '',
  '> 测试',
  '',
  '**[00:00:01.000 – 00:00:03.000] [系统]** 我们讨论发布计划。',
  '**[00:00:04.000 – 00:00:06.000] [麦克风]** 周五前完成测试。',
].join('\n'), 'utf8')

let streamCalls = 0
const llm = {
  listProviders: () => [{ id: 'mock', name: 'Mock' }],
  listModels: () => [{ id: 'mock-model', name: 'Mock Model' }],
  async *stream(options) {
    streamCalls += 1
    assert.equal(options.provider, 'mock')
    assert.equal(options.model, 'mock-model')
    assert.match(options.system, /只使用/)
    assert.match(options.messages[0].content[0].text, /发布计划/)
    yield { type: 'text-delta', index: 0, text: '# 测试纪要\n\n## 概览\n发布计划讨论。\n' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const disposers = []
const ctx = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
  get(name) { return name === 'llm' ? llm : undefined },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  connection: { fetch: { register() { return () => {} } } },
}

const { apply } = await import(pathToFileURL(path.join(MODULE, 'lib', 'index.js')).href)
apply(ctx, {
  sessionsDir,
  windowDataDir: dataDir,
  fileOutRoot: path.join(TMP, 'out'),
  nativeWindow: false,
  openOnStart: false,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = predicate()
      if (value) return value
    } catch {}
    await sleep(100)
  }
  throw new Error('timeout waiting for summary')
}

fs.writeFileSync(path.join(dataDir, 'native', 'summary.request'), JSON.stringify({ dir: sessionDir }), 'utf8')
const state = await waitFor(() => {
  const file = path.join(dataDir, 'native', 'summary.json')
  if (!fs.existsSync(file)) return null
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  return value.status === 'done' ? value : (value.status === 'error' ? value : null)
})
try {
  assert.equal(state.status, 'done', state.error)
  assert.equal(streamCalls, 1)
  const notes = fs.readFileSync(path.join(sessionDir, 'notes.md'), 'utf8')
  assert.match(notes, /测试纪要/)
  const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
  assert.equal(manifest.artifacts.notes, 'notes.md')
  assert.ok(manifest.summary, 'summary metadata missing')
  console.log(`[summary-e2e] PASS calls=${streamCalls} notes=${notes.length}`)
} finally {
  for (const disposer of disposers.reverse()) {
    try { disposer() } catch {}
  }
}
process.exit(0)
