/**
 * Subtitle cue builder, ported from .video-notes/scripts/subtitle.mjs.
 *
 * P2 uses it for the post-record subtitle pass: live segments are re-cut into
 * cue-sized lines, translated lines are included when present, and the result
 * is written as SRT + ASS for soft mux or burn-in.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEFAULTS = {
  font: 'Microsoft YaHei',
  width: 1920,
  height: 1080,
  maxLineUnits: 18,
  minDuration: 0.7,
  marginV: 0.05,
}

function charUnits(cp) {
  const c = cp.codePointAt(0)
  if (c === 0x20 || c === 0x09 || c === 0x0a) return 0.35
  if (c < 0x0080) return 0.55
  if (
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf)
  ) return 1
  return 1
}

function textUnits(text) {
  let sum = 0
  for (const cp of text) sum += charUnits(cp)
  return sum
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

const SENTENCE_END = /[。！？!?；;…]/
const CLAUSE_END = /[，,、：:]/

function splitAfter(text, re) {
  const parts = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (re.test(ch)) {
      parts.push(buf)
      buf = ''
    }
  }
  if (buf.trim()) parts.push(buf)
  return parts
}

function hardSplit(text, maxUnits) {
  const out = []
  let buf = ''
  let units = 0
  for (const ch of text) {
    const u = charUnits(ch)
    if (buf && units + u > maxUnits) {
      out.push(buf)
      buf = ''
      units = 0
    }
    buf += ch
    units += u
  }
  if (buf) out.push(buf)
  return out
}

function toDisplay(text) {
  return text
    .replace(/[，。]/g, ' ')
    .replace(/(?<!\d)[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function packCues(text, targetUnits, hardMaxUnits) {
  const clauses = []
  for (const sentence of splitAfter(normalize(text), SENTENCE_END)) {
    for (const clause of splitAfter(sentence, CLAUSE_END)) {
      if (!clause.trim()) continue
      if (textUnits(clause) > hardMaxUnits) clauses.push(...hardSplit(clause, hardMaxUnits))
      else clauses.push(clause)
    }
  }
  const cues = []
  let buf = ''
  let units = 0
  const flush = () => {
    if (buf.trim()) cues.push(buf.trim())
    buf = ''
    units = 0
  }
  for (const clause of clauses) {
    const u = textUnits(clause)
    if (u > targetUnits) {
      flush()
      cues.push(clause.trim())
      continue
    }
    if (buf && units + u > targetUnits) flush()
    buf += clause
    units += u
  }
  flush()
  return cues.filter(Boolean)
}

function wrapWords(text, maxUnits) {
  const lines = []
  let buffer = ''
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const candidate = buffer === '' ? word : `${buffer} ${word}`
    if (textUnits(candidate) <= maxUnits) {
      buffer = candidate
      continue
    }
    if (buffer !== '') {
      lines.push(buffer)
      buffer = ''
    }
    if (textUnits(word) > maxUnits) {
      const parts = hardSplit(word, maxUnits)
      lines.push(...parts.slice(0, -1))
      buffer = parts[parts.length - 1] ?? ''
    } else {
      buffer = word
    }
  }
  if (buffer) lines.push(buffer)
  return lines.filter(Boolean)
}

function breakLines(text, maxLineUnits) {
  const trimmed = text.trim()
  const total = textUnits(trimmed)
  if (total <= maxLineUnits) return [trimmed]
  // Latin text and CJK text with punctuation gaps should wrap on word boundaries.
  if (/\s/.test(trimmed)) return wrapWords(trimmed, maxLineUnits)

  const chars = [...trimmed]
  let units = 0
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < chars.length; i++) {
    units += charUnits(chars[i])
    const rest = total - units
    // A trailing space is a preferred break and should not consume the line budget.
    const before = chars[i] === ' ' ? units - 0.35 : units
    if (before <= maxLineUnits && rest <= maxLineUnits) {
      let score = Math.abs(before - total / 2)
      if (chars[i] === ' ') score -= maxLineUnits * 0.4
      else if (CLAUSE_END.test(chars[i]) || SENTENCE_END.test(chars[i])) score -= maxLineUnits * 0.35
      if (score < bestScore) {
        bestScore = score
        best = i + 1
      }
    }
  }
  if (best < 0) best = Math.max(1, Math.min(chars.length - 1, Math.round(chars.length / 2)))
  return [chars.slice(0, best).join('').trim(), chars.slice(best).join('').trim()].filter(Boolean)
}

function allocateDurations(total, weights, minDuration) {
  const n = weights.length
  if (n === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0) || n
  if (total <= n * minDuration) return Array(n).fill(total / n)
  const remaining = total - n * minDuration
  return weights.map((w) => minDuration + (remaining * w) / sum)
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const r = ms % 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(c)}`
}

function escapeAss(text) {
  return text
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

/**
 * Build subtitle cues from segments. Bilingual cues keep one cue per ASR
 * segment (original lines + translation lines); monolingual cues are re-cut
 * into cue-sized pieces with proportional timing, like video-notes.
 */
export function splitClauses(text) {
  const parts = []
  let buffer = ''
  for (const ch of text) {
    buffer += ch
    if (SENTENCE_END.test(ch) || CLAUSE_END.test(ch)) {
      if (buffer.trim()) parts.push(buffer.trim())
      buffer = ''
    }
  }
  if (buffer.trim()) parts.push(buffer.trim())
  return parts
}

function splitByRatios(text, targets) {
  const chars = [...text]
  const total = textUnits(text) || 1
  const candidates = []
  let units = 0
  for (let i = 0; i < chars.length; i++) {
    units += charUnits(chars[i])
    if (chars[i] === ' ' || CLAUSE_END.test(chars[i]) || SENTENCE_END.test(chars[i])) {
      candidates.push({ cut: i + 1, ratio: units / total })
    }
  }
  const cuts = []
  let previous = 0
  for (const target of targets) {
    let best = null
    let bestScore = Infinity
    for (const candidate of candidates) {
      if (candidate.cut <= previous) continue
      const score = Math.abs(candidate.ratio - target)
      if (score < bestScore) {
        bestScore = score
        best = candidate.cut
      }
    }
    if (best === null) best = Math.max(previous + 1, Math.round(chars.length * target))
    cuts.push(best)
    previous = best
  }
  const parts = []
  let start = 0
  for (const cut of cuts) {
    parts.push(chars.slice(start, cut).join('').trim())
    start = cut
  }
  parts.push(chars.slice(start).join('').trim())
  return parts.filter(Boolean)
}

function buildCueModel(segments, {
  width = DEFAULTS.width,
  height = DEFAULTS.height,
  bilingual = true,
  maxLineUnits = DEFAULTS.maxLineUnits,
  minDuration = DEFAULTS.minDuration,
  maxDuration = 0,
} = {}) {
  const w = width || DEFAULTS.width
  const h = height || DEFAULTS.height
  const fontSize = Math.round(Math.min(h * 0.045, w * 0.075))
  const marginX = Math.round(w * 0.05)
  const available = w - 2 * marginX
  const lineCapacity = Math.max(6, Math.min(maxLineUnits, Math.floor(available / Math.max(1, fontSize))))
  const cueTarget = lineCapacity
  const cueHardMax = lineCapacity * 2

  const cues = []
  for (const segment of segments) {
    const text = normalize(segment.text)
    if (!text) continue
    const translation = normalize(segment.translation)
    const hasTranslation = translation !== '' && translation !== text

    if (bilingual && hasTranslation) {
      let pairs = null
      const originalClauses = splitClauses(text).map(toDisplay).filter(Boolean)
      const translationClauses = splitClauses(translation).map(toDisplay).filter(Boolean)
      if (originalClauses.length > 0 && originalClauses.length === translationClauses.length) {
        pairs = originalClauses.map((part, index) => ({ original: part, translated: translationClauses[index] }))
      } else {
        const originalParts = packCues(text, cueTarget, cueHardMax).map(toDisplay).filter(Boolean)
        if (originalParts.length > 0) {
          const totalUnits = originalParts.reduce((sum, part) => sum + textUnits(part), 0) || 1
          const targets = []
          let accumulated = 0
          for (let index = 0; index < originalParts.length - 1; index++) {
            accumulated += textUnits(originalParts[index])
            targets.push(accumulated / totalUnits)
          }
          const translationParts = splitByRatios(translation, targets).map(toDisplay).filter(Boolean)
          if (translationParts.length === originalParts.length) {
            pairs = originalParts.map((part, index) => ({ original: part, translated: translationParts[index] }))
          }
        }
      }

      if (pairs && pairs.length > 0) {
        const durations = allocateDurations(
          Math.max(0, segment.end - segment.start),
          pairs.map((pair) => textUnits(pair.original)),
          minDuration,
        )
        let cursor = Number(segment.start) || 0
        pairs.forEach((pair, index) => {
          const start = cursor
          const end = index === pairs.length - 1
            ? Number(segment.end) || start
            : Math.min(Number(segment.end) || start, start + durations[index])
          cursor = end
          if (end - start < 0.15) return
          cues.push({
            start,
            end,
            text: pair.original,
            translation: pair.translated,
            lines: [
              ...breakLines(pair.original, lineCapacity),
              ...breakLines(pair.translated, lineCapacity),
            ].filter(Boolean),
          })
        })
        continue
      }

      const fallbackLines = [
        ...breakLines(toDisplay(text), lineCapacity),
        ...breakLines(toDisplay(translation), lineCapacity),
      ].filter(Boolean)
      if (fallbackLines.length > 0) {
        cues.push({
          start: Number(segment.start) || 0,
          end: Number(segment.end) || 0,
          text: toDisplay(text),
          translation: toDisplay(translation),
          lines: fallbackLines,
        })
      }
      continue
    }

    const display = toDisplay(hasTranslation ? translation : text)
    const parts = packCues(display, cueTarget, cueHardMax).map(toDisplay).filter(Boolean)
    if (parts.length === 0) continue
    const weights = parts.map((part) => Math.max(1, textUnits(part)))
    const durations = allocateDurations(Math.max(0, segment.end - segment.start), weights, minDuration)
    let cursor = Number(segment.start) || 0
    parts.forEach((part, index) => {
      const start = cursor
      const end = index === parts.length - 1
        ? Number(segment.end) || start
        : Math.min(Number(segment.end) || start, start + durations[index])
      cursor = end
      if (end - start < 0.15) return
      cues.push({ start, end, text: part, translation: '', lines: breakLines(part, lineCapacity) })
    })
  }

  const limited = maxDuration > 0
    ? cues
      .filter((cue) => cue.start < maxDuration)
      .map((cue) => ({ ...cue, end: Math.min(cue.end, maxDuration) }))
    : cues
  return limited.map((cue) => ({ ...cue, fontSize, lineCapacity }))
}

export function toSrt(cues) {
  return cues.map((cue, index) => {
    const body = cue.lines.join('\n')
    return `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${body}\n`
  }).join('\n')
}

export function toAss(cues, {
  width = DEFAULTS.width,
  height = DEFAULTS.height,
  font = DEFAULTS.font,
  marginV = DEFAULTS.marginV,
} = {}) {
  const w = width || DEFAULTS.width
  const h = height || DEFAULTS.height
  const size = cues[0]?.fontSize || Math.round(Math.min(h * 0.045, w * 0.075))
  const outline = Math.max(2, Math.round(size * 0.07))
  const marginFraction = marginV > 1 ? marginV / 100 : marginV
  const marginVpx = Math.round(h * Math.min(Math.max(marginFraction, 0.02), 0.2))
  const marginX = Math.round(w * 0.05)
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,${marginX},${marginX},${marginVpx},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const events = cues.map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${escapeAss(cue.lines.join('\n'))}`)
  return [...header, ...events, ''].join('\n')
}

export async function writeSubtitles({
  segments,
  outDir,
  width = DEFAULTS.width,
  height = DEFAULTS.height,
  bilingual = true,
  font = DEFAULTS.font,
  maxLineUnits = DEFAULTS.maxLineUnits,
  marginV = DEFAULTS.marginV,
  maxDuration = 0,
} = {}) {
  const cues = buildCueModel(segments, { width, height, bilingual, maxLineUnits, maxDuration })
  if (cues.length === 0) throw new Error('没有可生成的字幕（逐字稿为空？）')
  await fsp.mkdir(outDir, { recursive: true })
  const srtPath = path.join(outDir, 'subtitles.srt')
  const assPath = path.join(outDir, 'subtitles.ass')
  await fsp.writeFile(srtPath, toSrt(cues), 'utf8')
  await fsp.writeFile(assPath, toAss(cues, { width, height, font, marginV }), 'utf8')
  return { cues: cues.length, srtPath, assPath, fontSize: cues[0].fontSize, lineCapacity: cues[0].lineCapacity }
}
