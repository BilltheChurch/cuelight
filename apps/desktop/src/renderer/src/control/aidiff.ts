/**
 * An AI answer as a list of changes the author takes or leaves one by one, the storyboard with
 * the chosen ones applied, and a word-level diff of a line for showing what changed. No React or
 * Electron here, so it runs under unit tests.
 */
import { Step } from '@cuelight/schema'
import type { AiOutput, AiStep } from '../../../shared/ai.ts'
import { STEP_ORDER, setRootKey, withKey, type Doc, type StepDoc } from './doc.ts'

export type AiRow =
  | { kind: 'title'; before: string; after: string }
  /** One step of the answer; `from` (0-based) has more than one entry when steps were merged */
  | { kind: 'step'; from: number[]; before: StepDoc[]; after: StepDoc; changed: boolean }
  | { kind: 'drop'; from: number[]; before: StepDoc[] }

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** The act the model asked for, unless the step would not be valid with it (a click with no target, say). */
function actFor(base: StepDoc, act: AiStep['act']): StepDoc['act'] {
  if (act === base.act) return base.act
  return Step.safeParse({ ...base, act }).success ? act : base.act
}

/** The first original step, with the model's act and words. Its target and everything else stay. */
function merged(base: StepDoc, s: AiStep): StepDoc {
  let out = withKey(base, 'act', actFor(base, s.act), STEP_ORDER)
  // A silent step keeps an explicit empty line if it had one.
  out = 'say' in out ? { ...out, say: s.say.trim() } : withKey(out, 'say', s.say.trim(), STEP_ORDER)
  out = withKey(out, 'tag', s.tag.trim(), STEP_ORDER)
  return withKey(out, 'how', s.how.trim(), STEP_ORDER)
}

const sameWords = (a: StepDoc, b: StepDoc) => a.act === b.act && text(a.say) === text(b.say) && text(a.tag) === text(b.tag) && text(a.how) === text(b.how)

function stepRow(d: Doc, from: number[], s: AiStep): AiRow {
  const before = from.map((i) => d.steps[i])
  const after = merged(before[0], s)
  return { kind: 'step', from, before, after, changed: from.length > 1 || !sameWords(before[0], after) }
}

/**
 * Rows in storyboard order. The answer was checked first (see checkAiOutput), so its steps are in
 * order, each original step is in at most one of them, and merges are runs of neighbours.
 */
export function aiRows(d: Doc, scope: number[] | null, out: AiOutput): AiRow[] {
  const rows: AiRow[] = []
  const title = out.title.trim()
  if (!scope && title && title !== text(d.title)) rows.push({ kind: 'title', before: text(d.title), after: title })
  if (scope) {
    for (const s of out.steps) rows.push(stepRow(d, [s.from[0] - 1], s))
    return rows
  }
  const byFirst = new Map(out.steps.map((s) => [s.from[0] - 1, s]))
  for (let i = 0; i < d.steps.length; ) {
    const s = byFirst.get(i)
    if (s) {
      const from = s.from.map((x) => x - 1)
      rows.push(stepRow(d, from, s))
      i = from[from.length - 1] + 1
    } else {
      rows.push({ kind: 'drop', from: [i], before: [d.steps[i]] })
      i++
    }
  }
  return rows
}

/** Whether taking a row changes anything: unchanged steps need no say. */
export const isChange = (r: AiRow) => r.kind !== 'step' || r.changed

/** The storyboard with the rows marked `on` applied; rows left off keep the original steps. */
export function applyAiRows(d: Doc, rows: AiRow[], on: boolean[]): Doc {
  const steps: StepDoc[] = []
  let out = d
  let next = 0
  rows.forEach((r, k) => {
    if (r.kind === 'title') {
      if (on[k]) out = setRootKey(out, 'title', r.after)
      return
    }
    while (next < r.from[0]) steps.push(d.steps[next++])
    if (r.kind === 'step') steps.push(...(on[k] ? [r.after] : r.before))
    else if (!on[k]) steps.push(...r.before)
    next = r.from[r.from.length - 1] + 1
  })
  while (next < d.steps.length) steps.push(d.steps[next++])
  return { ...out, steps }
}

// ---------------------------------------------------------------- word diff

export type DiffPart = { op: '=' | '+' | '-'; t: string }

const CJK = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af'
/** CJK characters one by one (there are no spaces to split on), other words whole, spaces kept. */
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'g')
const MAX_CELLS = 60_000

/** What changed between two versions of a line, word by word (character by character in CJK). */
export function wordDiff(a: string, b: string): DiffPart[] {
  if (a === b) return a ? [{ op: '=', t: a }] : []
  const x = a.match(TOKEN) ?? []
  const y = b.match(TOKEN) ?? []
  if (x.length * y.length > MAX_CELLS) return [...(a ? [{ op: '-' as const, t: a }] : []), ...(b ? [{ op: '+' as const, t: b }] : [])]
  // Longest common subsequence, filled from the end so the walk below goes forwards.
  const w = y.length + 1
  const lcs = new Uint16Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
  const parts: DiffPart[] = []
  const push = (op: DiffPart['op'], t: string) => {
    const last = parts[parts.length - 1]
    if (last?.op === op) last.t += t
    else parts.push({ op, t })
  }
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (push('=', x[i]), i++, j++)
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) push('-', x[i++])
    else push('+', y[j++])
  }
  while (i < x.length) push('-', x[i++])
  while (j < y.length) push('+', y[j++])
  return parts
}

const visible = (s: string) => s.replace(/\s+/g, '').length

/**
 * A diff worth reading: word by word when the two versions share most of their words, else the
 * old one struck out and the new one after it, which reads better than a patchwork.
 */
export function readableDiff(a: string, b: string): DiffPart[] {
  const parts = wordDiff(a, b)
  if (!a || !b) return parts
  const same = parts.reduce((n, p) => n + (p.op === '=' ? visible(p.t) : 0), 0)
  return same / Math.max(visible(a), visible(b)) >= 0.5 ? parts : [{ op: '-', t: a }, { op: '+', t: b }]
}
