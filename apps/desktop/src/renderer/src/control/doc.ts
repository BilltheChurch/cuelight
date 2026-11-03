/**
 * The storyboard being edited: plain JSON in the author's own shape (defaults are not filled in,
 * so saving writes back what was opened), pure edits on it, and the undo history. No React or
 * Electron here, so it runs under unit tests.
 */
import type { Act, StepInput, StoryboardInput } from '@cuelight/schema'
import type { PickResult } from '../../../shared/types.ts'

export type Doc = StoryboardInput
export type StepDoc = StepInput
type Obj = Record<string, unknown>

export const ACTS: Act[] = ['click', 'read', 'wait', 'manual']

/** Where a new key goes among the keys already there; the author's own order is never changed. */
export const ROOT_ORDER = ['$schema', 'cuelight', 'title', 'description', 'brief', 'language', 'start', 'pace', 'card', 'steps']
export const STEP_ORDER = ['id', 'act', 'say', 'tag', 'how', 'target', 'until', 'secs', 'optional', 'card', 'note']
export const LOCATOR_ORDER = ['kind', 'url', 'within', 'testId', 'role', 'name', 'text', 'css', 'nth', 'closest']
export const UNTIL_ORDER = ['appear', 'gone', 'url', 'timeoutSecs']

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v))

/** Set one key, or remove it when the value is empty. */
export function withKey<T extends object>(obj: T, key: string, value: unknown, order: readonly string[] = []): T {
  const entries = Object.entries(obj)
  const at = entries.findIndex(([k]) => k === key)
  if (isEmpty(value)) return at < 0 ? obj : (Object.fromEntries(entries.filter(([k]) => k !== key)) as T)
  if (at >= 0) {
    if (entries[at][1] === value) return obj
    entries[at] = [key, value]
    return Object.fromEntries(entries) as T
  }
  const rank = order.indexOf(key)
  let pos = entries.length
  if (rank >= 0) {
    const later = entries.findIndex(([k]) => order.indexOf(k) > rank)
    if (later >= 0) pos = later
  }
  entries.splice(pos, 0, [key, value])
  return Object.fromEntries(entries) as T
}

/** Make whatever JSON was opened safe to edit: a storyboard object with a steps array of objects. */
export function coerce(json: unknown): Doc {
  const d = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as Obj
  const steps = Array.isArray(d.steps) ? d.steps.map((s) => (s && typeof s === 'object' && !Array.isArray(s) ? s : { act: 'manual', say: String(s) })) : []
  return { ...d, steps } as Doc
}

export const setRootKey = (d: Doc, key: string, value: unknown): Doc => withKey(d, key, value, ROOT_ORDER)

export const setStep = (d: Doc, i: number, s: StepDoc): Doc => (d.steps[i] === s ? d : { ...d, steps: d.steps.map((x, k) => (k === i ? s : x)) })

export const setStepKey = (d: Doc, i: number, key: string, value: unknown): Doc => setStep(d, i, withKey(d.steps[i], key, value, STEP_ORDER))

export function insertStep(d: Doc, at: number, s: StepDoc): Doc {
  const steps = [...d.steps]
  steps.splice(at, 0, s)
  return { ...d, steps }
}

export const removeStep = (d: Doc, i: number): Doc => (d.steps.length <= 1 ? d : { ...d, steps: d.steps.filter((_, k) => k !== i) })

export function moveStep(d: Doc, from: number, to: number): Doc {
  if (from === to || to < 0 || to >= d.steps.length || from < 0 || from >= d.steps.length) return d
  const steps = [...d.steps]
  const [s] = steps.splice(from, 1)
  steps.splice(to, 0, s)
  return { ...d, steps }
}

/** A copy right after the original; a copied id would clash, so it is dropped. */
export const duplicateStep = (d: Doc, i: number): Doc => insertStep(d, i + 1, structuredClone(withKey(d.steps[i], 'id', undefined)))

/** Index a step lands on when dropped before (`after` false) or after list item `over`. */
export function dropIndex(from: number, over: number, after: boolean): number {
  const p = after ? over + 1 : over
  return p > from ? p - 1 : p
}

export function moveInList<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const out = [...list]
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x)
  return out
}

/**
 * A pick replaces the step's target. A click step with no action label of its own gets one
 * naming the element, and picking for the first step remembers where the run starts: the page,
 * or for a pick in an app (with no start page) that app, which playback brings forward.
 */
export function applyPick(d: Doc, i: number, p: PickResult, clickTag: (label: string) => string): { doc: Doc; startSet: 'url' | 'app' | null } {
  let out = setStepKey(d, i, 'target', p.locators)
  const st = out.steps[i]
  if (st.act === 'click' && !st.tag && p.label) out = setStepKey(out, i, 'tag', clickTag(p.label))
  if (i !== 0 || d.start?.url) return { doc: out, startSet: null }
  if (/^https?:/.test(p.url)) return { doc: setRootKey(out, 'start', { ...(d.start ?? {}), url: p.url }), startSet: 'url' }
  if (p.app && !d.start?.app) return { doc: setRootKey(out, 'start', { ...(d.start ?? {}), app: p.app }), startSet: 'app' }
  return { doc: out, startSet: null }
}

/** Problems from parseStoryboard, split into the storyboard's own and each step's. */
export function splitIssues(issues: string[]): { root: string[]; steps: Map<number, string[]> } {
  const root: string[] = []
  const steps = new Map<number, string[]>()
  for (const i of issues) {
    const m = /^steps\.(\d+)(?:\.(.*))?$/.exec(i.split(': ')[0])
    if (!m) {
      root.push(i)
      continue
    }
    const n = Number(m[1])
    steps.set(n, [...(steps.get(n) ?? []), i.slice(i.indexOf(': ') + 2) + (m[2] ? ` (${m[2]})` : '')])
  }
  return { root, steps }
}

// ---------------------------------------------------------------- undo history

export type History = { past: Doc[]; present: Doc; future: Doc[]; key: string | null; at: number }

export type HistoryAction =
  /** `key` groups a burst of typing in one field into a single undo step */
  | { type: 'edit'; fn: (d: Doc) => Doc; key?: string; at: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; doc: Doc }

const LIMIT = 300
const COALESCE_MS = 1000

export const freshHistory = (doc: Doc): History => ({ past: [], present: doc, future: [], key: null, at: 0 })

export function history(h: History, a: HistoryAction): History {
  switch (a.type) {
    case 'reset':
      return freshHistory(a.doc)
    case 'edit': {
      const next = a.fn(h.present)
      if (next === h.present) return h
      const merge = !!a.key && a.key === h.key && a.at - h.at < COALESCE_MS
      return { past: merge ? h.past : [...h.past, h.present].slice(-LIMIT), present: next, future: [], key: a.key ?? null, at: a.at }
    }
    case 'undo':
      if (!h.past.length) return h
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 }
    case 'redo':
      if (!h.future.length) return h
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 }
  }
}
