#!/usr/bin/env node
/**
 * Headless CLI for capture-notes P3.
 *
 *   node scripts/cli.mjs file --input <media> [--language zh] [--subtitle soft|burn|both|none]
 *   node scripts/cli.mjs apply-translation --session <dir|id> --target zh-CN [--format bi|target] [--mux soft|burn]
 *   node scripts/cli.mjs simplify --file <md>
 *
 * Progress goes to stderr; the final JSON goes to stdout.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyTranslation, processFile, simplifyFile } from '../lib/core/pipeline.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.dirname(HERE)

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (['keep-audio', 'subs-only', 'help'].includes(key)) {
      out[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) {
      out[key] = true
      i--
      continue
    }
    out[key] = value
  }
  return out
}

function resolveOut(value) {
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.join(MODULE, value)
}

function printHelp() {
  console.log(`用法：
  node scripts/cli.mjs file --input <media> [--language auto|zh|en|ja|ko|yue]
      [--subtitle soft|burn|both|none] [--threads 6] [--limit 0] [--keep-audio]
      [--subs-only] [--font "Microsoft YaHei"] [--margin 5] [--out out/<slug>] [--work work/<slug>]

  node scripts/cli.mjs apply-translation --session <dir|id> --target zh-CN
      [--format bi|target] [--mux none|soft|burn] [--margin 5]

  node scripts/cli.mjs simplify --file <md|txt>

进度写 stderr，结果 JSON 写 stdout。`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || args.help) {
    printHelp()
    process.exit(command ? 0 : 2)
  }

  if (command === 'file') {
    const input = args.input
    if (!input) throw new Error('缺少 --input')
    const marginPercent = Number(args.margin ?? 5)
    const result = await processFile({
      input,
      language: args.language ?? 'auto',
      threads: Number(args.threads ?? 6),
      subtitle: args.subtitle ?? 'soft',
      limit: Number(args.limit ?? 0),
      keepAudio: Boolean(args['keep-audio']),
      subsOnly: Boolean(args['subs-only']),
      font: args.font ?? 'Microsoft YaHei',
      margin: Math.max(0, Math.min(0.5, marginPercent / 100)),
      outDir: resolveOut(args.out),
      workDir: resolveOut(args.work),
      onProgress: (progress) => {
        console.error(`[${progress.stage}] ${progress.percent ?? ''}% ${progress.detail ?? ''}`)
      },
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'apply-translation') {
    const result = await applyTranslation({
      session: args.session,
      target: args.target,
      format: args.format ?? 'bi',
      mux: args.mux ?? 'none',
      margin: Math.max(0, Math.min(0.5, Number(args.margin ?? 5) / 100)),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'simplify') {
    const result = await simplifyFile(args.file)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2))
  process.exit(1)
})
