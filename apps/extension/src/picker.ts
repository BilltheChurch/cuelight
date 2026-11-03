/**
 * Element picker for the editor. While it is on, hovering outlines the element the spotlight
 * would use, and clicking picks it; the page never sees those clicks or the keys used here.
 * Esc cancels, ↑ widens the pick to the parent element and ↓ narrows it back, Enter picks.
 */
import { langFromLocale } from '@cuelight/schema'
import { accessibleName, roleOf } from './locate.ts'
import { pickable } from './suggest.ts'

const TEXT = {
  en: { bar: 'Cuelight: click the element for this step', keys: '↑ parent · ↓ child · Esc cancel' },
  zh: { bar: 'Cuelight：点一下这一步要高亮的元素', keys: '↑ 上一层 · ↓ 下一层 · Esc 取消' },
}

const MOUSE = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const

const STYLE = `
  .box { position: fixed; display: none; border: 2px solid #d6a84a; border-radius: 6px;
    background: rgba(214, 168, 74, 0.14); box-shadow: 0 0 0 4000px rgba(0, 0, 0, 0.18); transition: all 60ms ease-out; }
  .tip { position: fixed; display: none; max-width: 420px; padding: 4px 9px; border-radius: 8px; background: #141414; color: #f6ecd6;
    font: 12px/1.4 ui-monospace, 'SF Mono', Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: center;
    padding: 9px 16px; border-radius: 999px; background: #141414; color: #fff; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
    font: 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
  .bar i { width: 9px; height: 9px; border-radius: 50%; background: #d6a84a; box-shadow: 0 0 0 4px rgba(214, 168, 74, 0.3); }
  .bar span { color: #c9c6bd; font-size: 12px; }
`

export class Picker {
  private host: HTMLElement | null = null
  private box: HTMLDivElement | null = null
  private tip: HTMLDivElement | null = null
  private el: Element | null = null
  private trail: Element[] = []
  /** After a pick, keep eating that press's mouseup and click so the page does not act on it */
  private draining = false
  private raf = 0

  constructor(
    private onPick: (el: Element) => void,
    private onCancel: () => void,
  ) {}

  get on() {
    return this.host !== null
  }

  start() {
    if (this.host) return
    const host = document.createElement('cuelight-picker')
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    this.box = Object.assign(document.createElement('div'), { className: 'box' })
    this.tip = Object.assign(document.createElement('div'), { className: 'tip' })
    const t = TEXT[langFromLocale(navigator.language)]
    const bar = Object.assign(document.createElement('div'), { className: 'bar' })
    bar.append(document.createElement('i'), t.bar, Object.assign(document.createElement('span'), { textContent: t.keys }))
    root.append(style, this.box, this.tip, bar)
    document.documentElement.append(host)
    this.host = host
    addEventListener('pointermove', this.move, { capture: true, passive: true })
    for (const type of MOUSE) addEventListener(type, this.swallow, true)
    addEventListener('keydown', this.key, true)
    addEventListener('scroll', this.redraw, { capture: true, passive: true })
    addEventListener('resize', this.redraw, { passive: true })
  }

  stop() {
    if (!this.host) return
    this.host.remove()
    this.host = this.box = this.tip = null
    this.el = null
    this.trail = []
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    removeEventListener('pointermove', this.move, true)
    if (!this.draining) for (const type of MOUSE) removeEventListener(type, this.swallow, true)
    removeEventListener('keydown', this.key, true)
    removeEventListener('scroll', this.redraw, true)
    removeEventListener('resize', this.redraw)
  }

  private pick(el: Element) {
    this.stop()
    this.onPick(el)
  }

  private at(x: number, y: number): Element | null {
    const hit = document.elementFromPoint(x, y)
    return hit && hit !== document.documentElement && hit !== document.body ? pickable(hit) : null
  }

  private move = (e: PointerEvent) => {
    const el = this.at(e.clientX, e.clientY)
    if (el === this.el || (el && this.trail.length && this.el?.contains(el))) return
    this.el = el
    this.trail = []
    this.redraw()
  }

  private swallow = (e: Event) => {
    if (!this.host && !this.draining) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const p = e as PointerEvent
    if (e.type === 'pointerdown' && this.host && p.button === 0) {
      const el = this.el ?? this.at(p.clientX, p.clientY)
      if (!el) return
      this.draining = true
      setTimeout(this.drained, 800)
      this.pick(el)
    } else if (e.type === 'click' && this.draining) this.drained()
  }

  private drained = () => {
    if (!this.draining) return
    this.draining = false
    if (!this.host) for (const type of MOUSE) removeEventListener(type, this.swallow, true)
  }

  private key = (e: KeyboardEvent) => {
    if (!this.host) return
    if (e.key === 'Escape') {
      this.stop()
      this.onCancel()
    } else if (e.key === 'ArrowUp' && this.el?.parentElement && this.el.parentElement !== document.body) {
      this.trail.push(this.el)
      this.el = this.el.parentElement
      this.redraw()
    } else if (e.key === 'ArrowDown' && this.trail.length) {
      this.el = this.trail.pop()!
      this.redraw()
    } else if (e.key === 'Enter' && this.el) this.pick(this.el)
    else return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  private redraw = () => {
    if (!this.raf && this.host) this.raf = requestAnimationFrame(this.draw)
  }

  private draw = () => {
    this.raf = 0
    const { box, tip, el } = this
    if (!box || !tip) return
    if (!el?.isConnected) {
      box.style.display = tip.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` })
    const name = accessibleName(el)
    tip.textContent = (roleOf(el) ?? el.tagName.toLowerCase()) + (name ? ` “${name.length > 50 ? name.slice(0, 49) + '…' : name}”` : '')
    const below = r.bottom + 8 + 26 < innerHeight
    Object.assign(tip.style, { display: 'block', left: `${Math.max(8, Math.min(innerWidth - 300, r.left))}px`, top: `${below ? r.bottom + 8 : Math.max(8, r.top - 34)}px` })
  }
}
