/**
 * Targets outside the browser: elements of desktop apps (the macOS Accessibility tree), text
 * found on screen with OCR, and rectangles relative to an app's window. The helper only reports
 * what it sees; matching locators against that happens here, so it runs under unit tests.
 *
 * The player asks for a target's rect about 60 times a second and cannot wait, so answers come
 * from a cache that is refreshed in the background: an element's frame several times a second,
 * a fresh look through the app's tree or the screen's text less often.
 */
import {
  normalizeSpace,
  textMatcher,
  type AxLocator,
  type Locator,
  type Rect,
  type RegionLocator,
  type TextMatch,
  type VisualLocator,
} from '@cuelight/schema'
import { HelperError, type HelperLike } from './helper.ts'

/** One element from the helper's walk of an app's windows, in tree order (windows front first). */
export type AxNode = {
  role: string
  subrole?: string
  title?: string
  description?: string
  identifier?: string
  value?: string
  rect?: Rect
  /** Index of the parent in the same list; -1 for a window */
  parent: number
  depth: number
  window: number
  /** The helper's handle, for polling this element's frame */
  ref: number
}

export type WinInfo = { app: string; pid: number; title: string; rect: Rect }

export type OcrLine = { text: string; rect: Rect; confidence: number; sub?: Rect }

/** What resolving a local target can say: where it is, not (yet) found, can't be done, or not allowed. */
export type LocalResult = Rect | null | 'unsupported' | 'denied'

// ---------------------------------------------------------------- Accessibility

const fits = (m: TextMatch | undefined, v: string | undefined) => m === undefined || (v !== undefined && textMatcher(m)(normalizeSpace(v)))

/** The visible name: AXTitle, or AXValue for elements without one (static text, say). */
export const axTitle = (n: Pick<AxNode, 'title' | 'value'>) => n.title ?? n.value

type AxQuery = { role?: string; subrole?: string; title?: TextMatch; identifier?: string; description?: TextMatch }

const nodeFits = (n: AxNode, q: AxQuery) =>
  (q.role === undefined || n.role === q.role) &&
  (q.subrole === undefined || n.subrole === q.subrole) &&
  (q.identifier === undefined || n.identifier === q.identifier) &&
  fits(q.title, axTitle(n)) &&
  fits(q.description, n.description)

const visible = (r: Rect | undefined): r is Rect => !!r && r[2] > 0 && r[3] > 0

const overlaps = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/** Each node's position among its parent's children of the same role. */
function sameRoleIndex(nodes: AxNode[]): number[] {
  const seen = new Map<string, number>()
  return nodes.map((n) => {
    const k = `${n.parent}:${n.role}`
    const i = seen.get(k) ?? 0
    seen.set(k, i + 1)
    return i
  })
}

/** Ancestors from the window down, not including the node itself. */
function ancestors(nodes: AxNode[], i: number): number[] {
  const out: number[] = []
  for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) out.unshift(p)
  return out
}

/**
 * Every element the locator describes, in tree order. `path` lists ancestors from the window
 * down; they have to appear in that order, but others may sit between them, so an app that
 * wraps its views in one more group does not lose the target.
 */
export function matchAxAll(l: AxLocator, nodes: AxNode[]): number[] {
  const idx = l.path?.some((p) => p.index !== undefined) ? sameRoleIndex(nodes) : null
  const out: number[] = []
  nodes.forEach((n, i) => {
    if (!nodeFits(n, l) || !visible(n.rect)) return
    const up = ancestors(nodes, i)
    const win = nodes[up[0] ?? i]
    if (l.window !== undefined && !fits(l.window, win.title)) return
    if (up.length && visible(win.rect) && !overlaps(n.rect, win.rect)) return
    if (l.path?.length) {
      let k = 0
      for (const a of up) {
        const p = l.path[k]
        if (p && nodeFits(nodes[a], p) && (p.index === undefined || idx![a] === p.index)) k++
      }
      if (k < l.path.length) return
    }
    out.push(i)
  })
  return out
}

export function matchAx(l: AxLocator, nodes: AxNode[]): AxNode | null {
  const all = matchAxAll(l, nodes)
  return nodes[all[l.nth ?? 0]] ?? null
}

/** Identifiers AppKit makes up on its own (`_NS:123`) change between launches. */
const madeUp = (id: string | undefined) => !id || /^_NS:\d+$/.test(id) || /^[0-9a-f-]{20,}$/i.test(id) || /^\d+$/.test(id)

const short = (s: string) => {
  const t = normalizeSpace(s)
  return t.length <= 48 ? { exact: t } : t.slice(0, 48)
}

const sameRect = (a: Rect | undefined, b: Rect | undefined, tol = 0.5) => !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) <= tol)

/**
 * A locator for an element the presenter clicked. `chain` is the element and its ancestors up
 * to the window, as a hit test reports them; `nodes`, the app's tree right now, is used to make
 * the locator point at that element and not one like it (more ancestors, the window, or nth).
 */
export function axLocatorFor(app: string, chain: AxNode[], nodes: AxNode[] | null): AxLocator | null {
  const el = chain[0]
  if (!el?.role) return null
  const loc: AxLocator = { kind: 'ax', app, role: el.role }
  if (el.subrole) loc.subrole = el.subrole
  if (!madeUp(el.identifier)) loc.identifier = el.identifier
  const name = axTitle(el)
  if (name?.trim()) loc.title = short(name)
  else if (el.description?.trim()) loc.description = short(el.description)
  if (!nodes) return loc
  const self = nodes.findIndex((n) => n.role === el.role && sameRect(n.rect, el.rect))
  if (self < 0) return loc
  let all = matchAxAll(loc, nodes)
  if (all[0] === self) return loc

  /** Keeps a narrowing step only when it rules something out. */
  const narrow = (apply: () => void, undo: () => void) => {
    apply()
    const m = matchAxAll(loc, nodes)
    if (m.length < all.length && m.includes(self)) all = m
    else undo()
    return all[0] === self
  }
  // Named ancestors, nearest first, then the window title, then nth.
  const win = chain.findLast((n) => n.role === 'AXWindow')
  const named = chain.slice(1).filter((n) => n !== win && n.role && (!madeUp(n.identifier) || axTitle(n)?.trim()))
  for (const a of named.slice(0, 3)) {
    const item: NonNullable<AxLocator['path']>[number] = { role: a.role }
    if (!madeUp(a.identifier)) item.identifier = a.identifier
    else item.title = short(axTitle(a)!)
    const before = loc.path
    const done = narrow(
      () => (loc.path = [item, ...(before ?? [])]),
      () => (before ? (loc.path = before) : delete loc.path),
    )
    if (done) return loc
  }
  if (win?.title?.trim() && narrow(() => (loc.window = short(win.title!)), () => delete loc.window)) return loc
  const k = all.indexOf(self)
  if (k > 0) loc.nth = k
  return loc
}

// ---------------------------------------------------------------- text on screen

const readingOrder = (a: OcrLine, b: OcrLine) => (Math.abs(a.rect[1] - b.rect[1]) > Math.min(a.rect[3], b.rect[3]) / 2 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0])

/**
 * Where a text anchor is: the first line (top to bottom, left to right) whose text matches. A
 * plain string spotlights just that part of the line; `box` places the light relative to it.
 */
export function matchOcr(l: VisualLocator, lines: OcrLine[]): Rect | null {
  if (l.text === undefined) return null
  const m = textMatcher(l.text)
  const hit = [...lines].sort(readingOrder).find((line) => m(normalizeSpace(line.text)))
  if (!hit) return null
  const a = typeof l.text === 'string' && hit.sub ? hit.sub : hit.rect
  return l.box ? [a[0] + l.box[0], a[1] + l.box[1], l.box[2], l.box[3]] : a
}

// ---------------------------------------------------------------- windows

/** The app's front window, or with no app the front window of any app but ours. */
export function frontWindow(wins: WinInfo[], app: string | undefined, ownPid: number): WinInfo | null {
  return wins.find((w) => (app ? w.app === app : w.pid !== ownPid) && visible(w.rect)) ?? null
}

export function regionIn(l: Pick<RegionLocator, 'rect' | 'units'>, [bx, by, bw, bh]: Rect): Rect {
  const [x, y, w, h] = l.rect
  return l.units === 'fraction' ? [bx + x * bw, by + y * bh, w * bw, h * bh] : [bx + x, by + y, w, h]
}

// ---------------------------------------------------------------- the cache

/** How often to refresh, in ms */
export const REFRESH = { frame: 120, tree: 1000, windows: 250, ocr: 1000, denied: 3000 }
/** Entries nobody asked about for this long are dropped */
const STALE_MS = 10_000

type Entry = {
  result: LocalResult
  /** When it was last refreshed, and whether a refresh is under way */
  at: number
  busy: boolean
  used: number
  /** Accessibility: the element found last time, polled by its handle until it goes away */
  ref?: number
  treeAt?: number
}

export type NativeDeps = {
  /** null: no helper on this system, so only screen regions work */
  helper: HelperLike | null
  now: () => number
  ownPid: number
  /** Where to look for text when a visual locator names no app (the display with the cursor) */
  screenAt: () => Rect
  onChange?: () => void
}

export class NativeTargets {
  private cache = new Map<string, Entry>()
  private d: NativeDeps

  constructor(d: NativeDeps) {
    this.d = d
  }

  /** The latest answer for a locator, and a refresh in the background when it is due. */
  resolve(l: Exclude<Locator, { kind: 'dom' }>): LocalResult {
    if (l.kind === 'visual' && l.text === undefined) return 'unsupported'
    if (!this.d.helper) return 'unsupported'
    const key = JSON.stringify(l)
    const now = this.d.now()
    let e = this.cache.get(key)
    if (!e) {
      e = { result: null, at: -Infinity, busy: false, used: now }
      this.cache.set(key, e)
    }
    e.used = now
    if (!e.busy && now - e.at >= this.interval(l, e)) void this.refresh(l, e)
    return e.result
  }

  /** Forget everything, say when a new storyboard is loaded or permissions changed. */
  clear() {
    this.cache.clear()
  }

  private interval(l: Locator, e: Entry) {
    if (e.result === 'denied') return REFRESH.denied
    if (l.kind === 'ax') return e.ref !== undefined ? REFRESH.frame : REFRESH.tree
    return l.kind === 'visual' ? REFRESH.ocr : REFRESH.windows
  }

  private async refresh(l: Exclude<Locator, { kind: 'dom' }>, e: Entry) {
    e.busy = true
    const before = e.result
    try {
      e.result = l.kind === 'ax' ? await this.ax(l, e) : l.kind === 'visual' ? await this.ocr(l) : await this.region(l)
    } catch (err) {
      const code = err instanceof HelperError ? err.code : 'failed'
      e.result = code === 'not-trusted' || code === 'no-screen-permission' ? 'denied' : code === 'unavailable' ? 'unsupported' : null
    } finally {
      e.busy = false
      e.at = this.d.now()
    }
    for (const [k, x] of this.cache) if (e.at - x.used > STALE_MS) this.cache.delete(k)
    if (!sameResult(before, e.result)) this.d.onChange?.()
  }

  private async ax(l: AxLocator, e: Entry): Promise<Rect | null> {
    const h = this.d.helper!
    const now = this.d.now()
    // A known element: just its frame, unless it is time for a fresh look at the tree.
    if (e.ref !== undefined && now - (e.treeAt ?? 0) < 5 * REFRESH.tree) {
      try {
        const r = await h.request<{ rect: Rect }>('ax.frame', { ref: e.ref }, 1000)
        if (visible(r.rect)) return r.rect
      } catch (err) {
        if (!(err instanceof HelperError) || err.code !== 'gone') throw err
      }
    }
    e.ref = undefined
    const t = await h.request<{ nodes: AxNode[] }>('ax.tree', { app: l.app }, 3000).catch((err) => {
      if (err instanceof HelperError && err.code === 'no-app') return { nodes: [] }
      throw err
    })
    e.treeAt = this.d.now()
    const n = matchAx(l, t.nodes)
    e.ref = n?.ref
    return n?.rect ?? null
  }

  private async ocr(l: VisualLocator): Promise<Rect | null> {
    const h = this.d.helper!
    let area = this.d.screenAt()
    if (l.app) {
      const w = frontWindow((await h.request<{ windows: WinInfo[] }>('windows', { app: l.app })).windows, l.app, this.d.ownPid)
      if (!w) return null
      area = w.rect
    }
    const find = typeof l.text === 'string' ? l.text : undefined
    // The first look loads the text models, which can take a while.
    const r = await h.request<{ lines: OcrLine[] }>('ocr', { rect: area, find }, 20_000)
    return matchOcr(l, r.lines)
  }

  private async region(l: RegionLocator): Promise<Rect | null> {
    const r = await this.d.helper!.request<{ windows: WinInfo[] }>('windows', l.app ? { app: l.app } : {})
    const w = frontWindow(r.windows, l.app, this.d.ownPid)
    return w ? regionIn(l, w.rect) : null
  }
}

const sameResult = (a: LocalResult, b: LocalResult) => a === b || (Array.isArray(a) && Array.isArray(b) && sameRect(a, b, 0))
