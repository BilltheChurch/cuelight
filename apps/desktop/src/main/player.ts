/**
 * Playback engine. Walks a storyboard step by step: tells the browser extension what to find,
 * puts the spotlight and the card on the overlay, and decides when a step is done
 * (a click inside the spotlight, a read timer that only runs while the cursor rests in the
 * light, a wait condition, or the hotkey). No Electron imports, so it runs under unit tests.
 */
import {
  contains,
  cue,
  defaultTag,
  howKind,
  howTo,
  inflate,
  readSecs,
  stepId,
  type DomLocator,
  type ExtMessage,
  type HintKind,
  type Lang,
  type Locator,
  type Offscreen,
  type Rect,
  type Step,
  type Storyboard,
  type WebTarget,
} from '@cuelight/schema'
import type { OverlayCard } from '../shared/types.ts'

/** Same padding the prototype used around the target */
export const PAD = 10
const OPTIONAL_WAIT_MS = 3000
const NOT_FOUND_AFTER_MS = 4000
const CLICK_SETTLE_MS = 250

export type Phase = 'idle' | 'preroll' | 'step' | 'done'

export type PlayerEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'step'; n: number; id: string; act: Step['act']; seq: number }
  | { type: 'advance'; from: number; reason: 'click' | 'read' | 'until' | 'timeout' | 'secs' | 'key' | 'skip-optional' }
  | { type: 'inside'; inside: boolean; by: 'page' | 'os' }

export type PlayerDeps = {
  overlay: {
    show(): void
    hide(): void
    toggle(): boolean
    card(c: OverlayCard | null): void
    light(rect: Rect | null): void
    inside(b: boolean): void
    progress(v: number | null): void
  }
  web: {
    target(t: WebTarget | null): void
    navigate(url: string): void
    status(s: { playing: boolean; n: number; total: number; title: string; loaded: boolean }): void
    connected(): boolean
  }
  /** Resolves non-DOM locators (regions now; Accessibility and OCR in M5). */
  local: (l: Locator) => Rect | null | 'unsupported'
  lang: () => Lang
  now: () => number
  onEvent?: (e: PlayerEvent) => void
}

type Light = { rect: Rect | null; found: boolean; offscreen: Offscreen; from: 'web' | 'local' | null }

const isDom = (l: Locator): l is DomLocator => l.kind === 'dom'

export class Player {
  sb: Storyboard | null = null
  phase: Phase = 'idle'
  i = 0
  seq = 0
  hidden = false

  private dir: 1 | -1 = 1
  private startedAt = 0
  private lastTick = 0
  private light: Light = { rect: null, found: false, offscreen: null, from: null }
  private everFound = false
  private inside = false
  private pageInside = false
  private pageAt = -1
  private osMovedAt = 0
  private cursor: { x: number; y: number } | null = null
  private acc = 0
  private lastProgress = -1
  private advanceAt: number | null = null
  private hint: HintKind | null = null
  private card: OverlayCard | null = null

  constructor(private d: PlayerDeps) {}

  get step(): Step | null {
    return this.phase === 'step' && this.sb ? this.sb.steps[this.i] : null
  }

  load(sb: Storyboard) {
    this.stop()
    this.sb = sb
    this.status()
  }

  start(from = 0) {
    if (!this.sb) return
    this.i = Math.max(0, Math.min(from, this.sb.steps.length - 1))
    this.hidden = false
    this.d.overlay.show()
    this.setPhase('preroll')
    this.seq++
    this.d.web.target(null)
    if (this.sb.start?.url && from === 0) this.d.web.navigate(this.sb.start.url)
    const lang = this.d.lang()
    const first = this.sb.steps[this.i]
    this.showCard({
      key: this.seq,
      n: this.i + 1,
      total: this.sb.steps.length,
      tag: cue(lang, 'preroll.tag', { title: this.sb.title, n: this.sb.steps.length }),
      how: '',
      kind: 'preroll',
      say: cue(lang, 'preroll.say'),
      next: cue(lang, 'next') + (first.say || defaultTag(first, lang)),
      hint: null,
      hintKind: null,
      placement: this.sb.card === 'bottom' ? 'bottom' : 'top',
    })
    this.d.overlay.light(null)
    this.d.overlay.progress(null)
    this.status()
  }

  stop() {
    if (this.phase === 'idle') return
    this.seq++
    this.d.web.target(null)
    this.d.overlay.card(null)
    this.d.overlay.light(null)
    this.d.overlay.hide()
    this.setPhase('idle')
    this.status()
  }

  next() {
    if (this.phase === 'preroll') this.enter(this.i, 1)
    else if (this.phase === 'step') this.advance(1, 'key')
    else if (this.phase === 'done') this.stop()
  }

  prev() {
    if (!this.sb) return
    if (this.phase === 'step') {
      if (this.i > 0) this.enter(this.i - 1, -1)
    } else if (this.phase === 'done') this.enter(this.sb.steps.length - 1, -1)
  }

  toggleHidden() {
    if (this.phase === 'idle') return
    this.hidden = this.d.overlay.toggle()
  }

  /** The extension (re)connected mid-step: give it the current target again. */
  resendTarget() {
    if (this.phase === 'step') this.d.web.target(this.webTarget())
    this.status()
  }

  onWeb(m: ExtMessage) {
    const now = this.d.now()
    switch (m.t) {
      case 'rect':
        if (m.seq !== this.seq || this.phase !== 'step') return
        if (!m.found) {
          const local = this.resolveLocal()
          if (local) {
            this.setLight({ rect: local, found: true, offscreen: null, from: 'local' })
            return
          }
        }
        this.setLight({ rect: m.rect, found: m.found, offscreen: m.offscreen, from: 'web' })
        return
      case 'click':
        if (m.seq === this.seq && this.step?.act === 'click' && this.advanceAt === null) this.advanceAt = now + CLICK_SETTLE_MS
        return
      case 'until':
        if (m.seq === this.seq && this.step?.act === 'wait') this.advance(1, 'until')
        return
      case 'pointer':
        if (m.seq !== this.seq) return
        this.pageInside = m.inside
        this.pageAt = now
        return
      case 'control':
        if (m.cmd === 'play') {
          if (this.phase === 'idle') this.start(0)
        } else if (m.cmd === 'next') this.next()
        else if (m.cmd === 'prev') this.prev()
        else if (m.cmd === 'hide') this.toggleHidden()
        else this.stop()
        return
    }
  }

  /** Call ~60 times a second with the real cursor position (screen points). */
  tick(cursor: { x: number; y: number }) {
    const now = this.d.now()
    const dt = Math.max(0, Math.min(0.25, (now - this.lastTick) / 1000))
    this.lastTick = now
    if (!this.cursor || this.cursor.x !== cursor.x || this.cursor.y !== cursor.y) this.osMovedAt = now
    this.cursor = cursor
    const st = this.step
    if (!st || !this.sb) return

    const hole = this.light.rect && this.light.found && !this.light.offscreen ? inflate(this.light.rect, PAD) : null
    const osInside = !!hole && contains(hole, cursor.x, cursor.y)
    // Whichever moved last wins: the OS cursor, or a pointer the page saw (exact under zoom).
    const byPage = this.pageAt > this.osMovedAt
    const inside = !!hole && (byPage ? this.pageInside : osInside)
    if (inside !== this.inside) {
      this.inside = inside
      this.d.overlay.inside(inside)
      this.d.onEvent?.({ type: 'inside', inside, by: byPage ? 'page' : 'os' })
    }

    const age = now - this.startedAt
    if (st.optional && !this.everFound && age > OPTIONAL_WAIT_MS) return this.advance(this.dir, 'skip-optional')
    if (this.advanceAt !== null && now >= this.advanceAt) return this.advance(1, 'click')

    if (st.act === 'read') {
      const need = readSecs(st, this.sb.pace)
      const running = st.target ? inside : true
      if (running) this.acc += dt
      const p = Math.min(1, this.acc / need)
      if (Math.abs(p - this.lastProgress) >= 0.004 || (p === 1 && this.lastProgress !== 1)) {
        this.lastProgress = p
        this.d.overlay.progress(p)
      }
      if (this.acc >= need) return this.advance(1, 'read')
    }
    if (st.act === 'wait') {
      if (!st.until && st.secs !== undefined && age >= st.secs * 1000) return this.advance(1, 'secs')
      if (st.until?.timeoutSecs !== undefined && age >= st.until.timeoutSecs * 1000) return this.advance(1, 'timeout')
    }
    this.refreshHint(now)
  }

  // ---------------------------------------------------------------- internals

  private advance(d: 1 | -1, reason: Extract<PlayerEvent, { type: 'advance' }>['reason']) {
    if (!this.sb) return
    this.d.onEvent?.({ type: 'advance', from: this.i + 1, reason })
    const ni = this.i + d
    if (ni >= this.sb.steps.length) return this.finish()
    this.enter(Math.max(0, ni), d)
  }

  private enter(i: number, dir: 1 | -1) {
    const sb = this.sb!
    const st = sb.steps[i]
    this.i = i
    this.dir = dir
    this.seq++
    this.setPhase('step')
    this.startedAt = this.d.now()
    this.lastTick = this.startedAt
    this.acc = 0
    this.lastProgress = -1
    this.advanceAt = null
    this.everFound = false
    this.inside = false
    this.pageInside = false
    this.pageAt = -1
    this.hint = null
    this.light = { rect: null, found: false, offscreen: null, from: null }
    this.d.overlay.inside(false)
    this.d.overlay.light(null)
    this.d.overlay.progress(st.act === 'read' ? 0 : null)
    this.d.web.target(this.webTarget())

    const lang = this.d.lang()
    const next = sb.steps[i + 1]
    this.showCard({
      key: this.seq,
      n: i + 1,
      total: sb.steps.length,
      tag: defaultTag(st, lang),
      how: howTo(st, lang),
      kind: howKind(st),
      say: st.say,
      next: next ? cue(lang, 'next') + (next.say || defaultTag(next, lang)) : '',
      hint: null,
      hintKind: null,
      placement: (st.card ?? sb.card) === 'bottom' ? 'bottom' : 'top',
    })
    if (st.target && !st.target.some(isDom)) {
      const local = this.resolveLocal()
      if (local) this.setLight({ rect: local, found: true, offscreen: null, from: 'local' })
    }
    this.d.onEvent?.({ type: 'step', n: i + 1, id: stepId(st, i), act: st.act, seq: this.seq })
    this.refreshHint(this.startedAt)
    this.status()
  }

  private finish() {
    const lang = this.d.lang()
    this.seq++
    this.setPhase('done')
    this.d.web.target(null)
    this.d.overlay.light(null)
    this.d.overlay.progress(null)
    this.showCard({
      key: this.seq,
      n: this.sb!.steps.length,
      total: this.sb!.steps.length,
      tag: cue(lang, 'done.tag'),
      how: cue(lang, 'done.how'),
      kind: 'done',
      say: cue(lang, 'done.say'),
      next: '',
      hint: null,
      hintKind: null,
      placement: 'top',
    })
    this.status()
  }

  private webTarget(): WebTarget | null {
    const st = this.step
    if (!st) return null
    const locators = (st.target ?? []).filter(isDom)
    const u = st.until
    const until = u && {
      url: u.url,
      timeoutSecs: u.timeoutSecs,
      appear: u.appear?.filter(isDom),
      gone: u.gone?.filter(isDom),
    }
    const hasUntil = !!until && (until.url !== undefined || !!until.appear?.length || !!until.gone?.length)
    if (!locators.length && !hasUntil) return null
    return { seq: this.seq, act: st.act, locators, until: hasUntil ? until : undefined }
  }

  private resolveLocal(): Rect | null {
    for (const l of this.step?.target ?? []) {
      if (isDom(l)) continue
      const r = this.d.local(l)
      if (r && r !== 'unsupported') return r
    }
    return null
  }

  private setLight(l: Light) {
    this.light = l
    if (l.found) this.everFound = true
    this.d.overlay.light(l.rect)
    this.refreshHint(this.d.now())
  }

  private refreshHint(now: number) {
    const st = this.step
    let h: HintKind | null = null
    if (st?.target) {
      const kinds = st.target.map((l) => l.kind)
      const hasDom = kinds.includes('dom')
      const anyLocal = st.target.some((l) => !isDom(l) && this.d.local(l) !== 'unsupported')
      if (this.light.offscreen === 'below') h = 'scroll-down'
      else if (this.light.offscreen === 'above') h = 'scroll-up'
      else if (!this.light.found) {
        if (!hasDom && !anyLocal) h = 'unsupported'
        else if (hasDom && !this.d.web.connected() && !anyLocal) h = 'no-browser'
        else h = now - this.startedAt > NOT_FOUND_AFTER_MS && !st.optional ? 'not-found' : 'waiting-page'
      }
    }
    if (h === this.hint) return
    this.hint = h
    if (this.card) this.showCard({ ...this.card, hint: h && cue(this.d.lang(), `hint.${h}`), hintKind: h })
  }

  private showCard(c: OverlayCard) {
    this.card = c
    this.d.overlay.card(c)
  }

  private setPhase(p: Phase) {
    this.phase = p
    this.d.onEvent?.({ type: 'phase', phase: p })
  }

  private status() {
    const sb = this.sb
    this.d.web.status({
      playing: this.phase !== 'idle',
      n: this.phase === 'step' ? this.i + 1 : this.phase === 'done' ? (sb?.steps.length ?? 0) : 0,
      total: sb?.steps.length ?? 0,
      title: sb?.title ?? '',
      loaded: !!sb,
    })
  }
}
