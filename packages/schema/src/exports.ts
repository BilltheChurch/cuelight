/**
 * What a storyboard turns into for the edit: a voice-over script with timecodes (Markdown),
 * subtitles (SRT) and chapter marks (the "0:00 Title" lines video sites read from a
 * description). Times come from a rehearsal where there is one, and from the reading pace
 * everywhere else. Time 0 is when the first step starts, after the preroll.
 */
import { defaultTag, howTo, type Lang } from './cues.ts'
import { readSecs, speechUnits, stepSecs } from './pacing.ts'
import type { Step, Storyboard } from './storyboard.ts'

/**
 * Identifies a storyboard's steps by what is done and said, so a rehearsal's times are only
 * used while the steps they were measured on are still the same.
 */
export const runSig = (steps: Pick<Step, 'act' | 'say'>[]) => JSON.stringify(steps.map((s) => [s.act, s.say ?? '']))

export type Slot = { start: number; secs: number; measured: boolean }

/** Where each step starts and how long it lasts. `measured[i]`: seconds from a rehearsal, or null. */
export function timeline(sb: Storyboard, measured: (number | null | undefined)[] = []): Slot[] {
  let t = 0
  return sb.steps.map((s, i) => {
    const m = measured[i]
    const secs = typeof m === 'number' && m >= 0 ? m : stepSecs(s, sb.pace)
    const slot = { start: t, secs, measured: typeof m === 'number' && m >= 0 }
    t += secs
    return slot
  })
}

export const totalSecs = (tl: Slot[]) => (tl.length ? tl[tl.length - 1].start + tl[tl.length - 1].secs : 0)

/** 0:05, 1:23, 1:02:03 */
export function clock(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 00:01:02,345 */
export function srtTime(secs: number): string {
  const ms = Math.max(0, Math.round(secs * 1000))
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}

const LABELS = {
  en: { steps: 'steps', measured: 'timed from a rehearsal', estimated: 'estimated from the lines', mixed: 'partly timed from a rehearsal', silent: '(no line)', note: 'Note' },
  zh: { steps: '步', measured: '按排练实测计时', estimated: '按台词估算', mixed: '部分按排练实测计时', silent: '（不说话）', note: '备注' },
} as const

const hasCjk = (s: string) => /[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(s)

/** A short name for a step: its own label, else the start of its line, else the generic label. */
export function stepTitle(s: Step, lang: Lang, max = 48): string {
  if (s.tag?.trim()) return s.tag.trim()
  const line = s.say.trim().replace(/\s+/g, ' ')
  if (!line) return defaultTag(s, lang)
  const first = line.split(/(?<=[.!?。！？])\s*/)[0]
  return first.length <= max ? first : first.slice(0, max - 1).trimEnd() + '…'
}

/** The voice-over script: one section per step with its timecode, what to do and what to say. */
export function toScript(sb: Storyboard, tl: Slot[], lang: Lang): string {
  const L = LABELS[lang]
  const all = tl.every((x) => x.measured)
  const some = tl.some((x) => x.measured)
  const out = [`# ${sb.title}`, '', `${sb.steps.length} ${L.steps} · ${clock(totalSecs(tl))} · ${all ? L.measured : some ? L.mixed : L.estimated}`]
  if (sb.description) out.push('', sb.description)
  sb.steps.forEach((s, i) => {
    const slot = tl[i]
    out.push('', `## ${clock(slot.start)}  ${i + 1}. ${defaultTag(s, lang)}`, '', `${howTo(s, lang)} (${slot.secs.toFixed(1)} s)`, '', s.say.trim() || L.silent)
    if (s.note?.trim()) out.push('', `${L.note}: ${s.note.trim()}`)
  })
  return out.join('\n') + '\n'
}

/** Pieces of a line a subtitle can hold, split at sentence ends, then at commas, then by length. */
function pieces(text: string): string[] {
  const cjk = hasCjk(text)
  const max = cjk ? 36 : 84
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?。！？])\s*/).filter(Boolean)) {
    if (sentence.length <= max) {
      out.push(sentence)
      continue
    }
    let cur = ''
    for (const part of sentence.split(/(?<=[,;:，；：、])\s*/)) {
      if (cur && (cur + part).length > max) (out.push(cur), (cur = ''))
      if (part.length <= max) cur += (cur && !cjk ? ' ' : '') + part
      else {
        // One long run with nothing to split at: by words, or by characters in CJK.
        const units = cjk ? [...part] : part.split(' ')
        for (const u of units) {
          if (cur && (cur.length + u.length + 1 > max)) (out.push(cur), (cur = ''))
          cur += (cur && !cjk ? ' ' : '') + u
        }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

/**
 * Two lines at most on screen, broken near the middle: at a space, or in CJK right after a
 * punctuation mark (a line never starts with one).
 */
function wrap(s: string): string {
  const cjk = hasCjk(s)
  if (s.length <= (cjk ? 18 : 42)) return s
  const mid = Math.floor(s.length / 2)
  const closest = (ks: number[]) => ks.filter((k) => k > 0 && k < s.length).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]
  if (cjk) {
    const after = closest([...s.matchAll(/[，、；：。！？,;:]/g)].map((m) => m.index! + 1).filter((k) => Math.abs(k - mid) <= 6))
    let at = after ?? mid
    while (at < s.length && /[，、；：。！？,;:）」』]/.test(s[at])) at++
    return s.slice(0, at) + '\n' + s.slice(at)
  }
  const at = closest([s.lastIndexOf(' ', mid), s.indexOf(' ', mid)])
  return at === undefined ? s : s.slice(0, at) + '\n' + s.slice(at + 1)
}

/**
 * Subtitles. Each line starts with its step and lasts as long as it takes to say (not as long
 * as the presenter then waited for a page); a long line is shown in pieces, timed by length.
 */
export function toSrt(sb: Storyboard, tl: Slot[]): string {
  const cues: string[] = []
  sb.steps.forEach((s, i) => {
    const line = s.say.trim().replace(/\s+/g, ' ')
    if (!line) return
    const slot = tl[i]
    const span = Math.max(0.8, Math.min(slot.secs, readSecs({ say: line }, sb.pace)))
    const parts = pieces(line)
    const weights = parts.map((p) => Math.max(0.5, speechUnits(p)))
    const sum = weights.reduce((a, b) => a + b, 0)
    let t = slot.start
    parts.forEach((p, k) => {
      const d = (span * weights[k]) / sum
      cues.push(`${cues.length + 1}\n${srtTime(t)} --> ${srtTime(t + d)}\n${wrap(p)}\n`)
      t += d
    })
  })
  return cues.join('\n')
}

/**
 * Chapter marks. Steps are merged until each chapter runs at least `minSecs` (video sites ask
 * for 10 s); a chapter is named after its first step.
 */
export function toChapters(sb: Storyboard, tl: Slot[], lang: Lang, minSecs = 10): string {
  const chapters: { start: number; end: number; title: string }[] = []
  sb.steps.forEach((s, i) => {
    const slot = tl[i]
    const last = chapters[chapters.length - 1]
    if (last && last.end - last.start < minSecs) last.end = slot.start + slot.secs
    else chapters.push({ start: slot.start, end: slot.start + slot.secs, title: stepTitle(s, lang) })
  })
  // A short tail joins the chapter before it.
  const tail = chapters[chapters.length - 1]
  if (chapters.length > 1 && tail.end - tail.start < minSecs) chapters[chapters.length - 2].end = chapters.pop()!.end
  return chapters.map((c) => `${clock(c.start)} ${c.title}`).join('\n') + '\n'
}
