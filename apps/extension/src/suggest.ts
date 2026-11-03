/**
 * Locator suggestions for an element the presenter picked: a short fallback chain, most stable
 * signal first (test id, ARIA role and name, id, visible text, CSS), where every entry resolves
 * back to that same element on this page. A signal that is not unique on its own is scoped to the
 * nearest ancestor that is (`within`), and only as a last resort narrowed with `nth`.
 */
import type { DomLocator, DomQuery } from '@cuelight/schema'
import { TEST_ID_ATTRS, accessibleName, queryAll, resolveTarget, roleOf, textOf, type LocateEnv } from './locate.ts'

/** Longer names and texts make brittle, unreadable locators */
const MAX_TEXT = 60
/** How far up to look for an ancestor to scope a locator within */
const MAX_SCOPE_DEPTH = 6
const MAX_PATH = 7

type Cand = { q: DomQuery; score: number; unique: boolean }

const testIdOf = (e: Element) => {
  for (const a of TEST_ID_ATTRS) {
    const v = e.getAttribute(a)
    if (v) return v
  }
  return null
}

/** Ids and classes that look generated (React's :r1:, CSS-in-JS hashes) change between builds. */
export function stableToken(s: string): boolean {
  if (!/^[A-Za-z][\w-]*$/.test(s) || s.length > 40) return false
  if (/^(css|sc|jsx|emotion|styled|svelte|ember|react|radix|headlessui|mui|chakra)-/i.test(s)) return false
  const last = s.split(/[-_]+/).at(-1) ?? s
  return !(last.length >= 5 && /\d/.test(last) && /[a-z]/i.test(last))
}

const stableClasses = (e: Element) => [...e.classList].filter(stableToken).slice(0, 2)

/** Queries built from the element's own signals, best first. */
function own(el: Element): Omit<Cand, 'unique'>[] {
  const out: Omit<Cand, 'unique'>[] = []
  const tid = testIdOf(el)
  const role = roleOf(el)
  const name = accessibleName(el)
  const text = textOf(el)
  const shortText = text && text.length <= MAX_TEXT ? text : null
  const cls = stableClasses(el)
  const tagSel = el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('')
  if (tid) {
    out.push({ q: { testId: tid }, score: 100 })
    if (shortText) out.push({ q: { testId: tid, text: { exact: shortText } }, score: 95 })
  }
  if (role && role !== 'presentation' && role !== 'none') {
    if (name && name.length <= MAX_TEXT) {
      out.push({ q: { role, name }, score: 90 })
      out.push({ q: { role, name: { exact: name } }, score: 88 })
    }
    out.push({ q: { role }, score: 60 })
  }
  const id = el.getAttribute('id')
  if (id && stableToken(id)) out.push({ q: { css: '#' + CSS.escape(id) }, score: 85 })
  if (shortText) {
    out.push({ q: { text: shortText }, score: 75 })
    out.push({ q: { text: { exact: shortText } }, score: 74 })
    out.push({ q: { css: tagSel, text: { exact: shortText } }, score: 70 })
  }
  if (cls.length) out.push({ q: { css: tagSel }, score: 65 })
  return out
}

/** How a query fares at finding `el` under `root`: unique, or only with an `nth`. */
function rank(root: ParentNode, c: Omit<Cand, 'unique'>, el: Element, env: LocateEnv): Cand | null {
  const list = queryAll(root, c.q, env)
  const i = list.indexOf(el)
  if (i < 0) return null
  if (list.length === 1) return { ...c, unique: true }
  return { q: { ...c.q, nth: i }, score: c.score - 40 - Math.min(i, 10), unique: false }
}

/**
 * The element's own signals, scoped to an ancestor that one of the ancestor's own signals pins
 * down. The weaker of the two signals sets the score, and every level up costs a little.
 */
function scoped(el: Element, env: LocateEnv, doc: Document): Cand[] {
  const inner = own(el)
  const out: Cand[] = []
  let a = el.parentElement
  for (let d = 0; a && d < MAX_SCOPE_DEPTH && a !== doc.body && a !== doc.documentElement; d++, a = a.parentElement) {
    const unique = inner.map((ic) => rank(a!, ic, el, env)).filter((r): r is Cand => !!r?.unique)
    if (!unique.length) continue
    for (const sc of own(a)) {
      const scope = rank(doc, sc, a, env)
      if (scope?.unique) for (const ic of unique) out.push({ q: { ...ic.q, within: scope.q } as DomQuery, score: Math.min(scope.score, ic.score) - 8 - d, unique: true })
    }
  }
  return out
}

/** A CSS path from the nearest stable id (or the root) down, with :nth-of-type only where siblings tie. */
function cssPath(el: Element, env: LocateEnv, doc: Document): Cand | null {
  const parts: string[] = []
  for (let e: Element | null = el; e && e !== doc.documentElement && parts.length < MAX_PATH; e = e.parentElement) {
    const id = e.getAttribute('id')
    const anchored = !!id && stableToken(id)
    if (anchored) parts.unshift('#' + CSS.escape(id!))
    else {
      const cur = e
      let part = cur.tagName.toLowerCase() + stableClasses(cur).map((c) => '.' + CSS.escape(c)).join('')
      const p = cur.parentElement
      if (p) {
        const sameTag = [...p.children].filter((c) => c.tagName === cur.tagName)
        const tied = [...p.children].filter((c) => c.matches(part)).length > 1
        if (tied) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
      }
      parts.unshift(part)
    }
    const css = parts.join(' > ')
    const list = queryAll(doc, { css }, env)
    if (list.length === 1 && list[0] === el) return { q: { css }, score: 50, unique: true }
    if (anchored) break
  }
  return null
}

const family = (q: DomQuery) => (q.testId ? 'testId' : q.role ? 'role' : q.css && !q.text ? 'css' : 'text')

export function suggestLocators(el: Element, env: LocateEnv, doc: Document = el.ownerDocument, max = 3): DomLocator[] {
  const all: Cand[] = []
  for (const c of own(el)) {
    const r = rank(doc, c, el, env)
    if (r) all.push(r)
  }
  if (!all.some((c) => c.unique && c.score >= 70)) all.push(...scoped(el, env, doc))
  const path = cssPath(el, env, doc)
  if (path) all.push(path)
  all.sort((a, b) => Number(b.unique) - Number(a.unique) || b.score - a.score)

  // One per signal family, so the chain still holds when one kind of signal breaks.
  const out: DomLocator[] = []
  const families = new Set<string>()
  for (const c of all) {
    const fam = family(c.q)
    if (families.has(fam)) continue
    const l = { kind: 'dom', ...c.q } as DomLocator
    if (resolveTarget([l], env, doc) !== el) continue
    families.add(fam)
    out.push(l)
    if (out.length >= max) break
  }
  return out
}

/** A short label for the picked element, for the card's action line. */
export function describe(el: Element): { label: string; role: string | null } {
  const raw = accessibleName(el) || textOf(el) || el.getAttribute('placeholder') || el.tagName.toLowerCase()
  return { label: raw.length > 40 ? raw.slice(0, 39) + '…' : raw, role: roleOf(el) }
}

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label', '[role]',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]',
  ...TEST_ID_ATTRS.map((a) => `[${a}]`),
].join(',')

/**
 * The element a hover means: the nearest interactive ancestor of what is under the pointer, so
 * the icon inside a button picks the button. Without one, the element itself (or its whole SVG).
 */
export function pickable(el: Element): Element {
  const svg = el.closest('svg')
  let e: Element | null = svg ?? el
  for (let d = 0; e && d < 4; d++, e = e.parentElement) if (e.matches(INTERACTIVE)) return e
  return svg ?? el
}
