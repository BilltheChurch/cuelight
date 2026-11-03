/**
 * Content script: finds the element for the current step, reports where it is on screen
 * every frame it moves, and tells the app when the presenter clicks it or when a wait
 * condition is met. Runs in the top frame of every page; only the tab the background
 * worker picked as the stage gets a target.
 */
import { inflate, contains, spotlightRect, urlMatches, type Rect, type Viewport, type WebTarget } from '@cuelight/schema'
import { isVisible, pageEnv, resolveTarget } from './locate.ts'
import type { Correction, ToContent, FromContent } from './messages.ts'
import { Picker } from './picker.ts'
import { describe, suggestLocators } from './suggest.ts'

/** Same padding the overlay puts around the spotlight, in screen points */
const PAD = 10
/** Clicks this close to the element still count (CSS px), as in the prototype */
const CLICK_SLOP = 6

let target: WebTarget | null = null
let zoom = 1
let el: Element | null = null
let resolvedAt = 0
let lastSent = ''
let lastRect: Rect | null = null
let untilSent = false
let untilAt = 0
let pointerInside: boolean | null = null
let raf = 0
/** Viewport origin learned from real pointer events, relative to window.screenX/Y */
let calib: { dx: number; dy: number } | null = null
/** What earlier pages in this window learned, until this page sees a pointer event itself */
let corr: Correction | null = null
let corrSent = ''
/** Until the background tells us the page zoom, a pointer event cannot be turned into an origin */
let zoomKnown = false

const send = (m: FromContent) => {
  try {
    void chrome.runtime.sendMessage(m).catch(() => {})
  } catch {
    // Extension was reloaded; this orphaned script just goes quiet.
    stop()
  }
}

/** Where outerHeight/innerHeight alone put the viewport: flush left, at the bottom of the window. */
const baseDy = () => outerHeight - innerHeight * zoom

function viewport(): Viewport {
  const dx = calib?.dx ?? corr?.x ?? 0
  const dy = calib?.dy ?? baseDy() + (corr?.y ?? 0)
  return { originX: screenX + dx, originY: screenY + dy, zoom, width: innerWidth, height: innerHeight }
}

function tick() {
  raf = 0
  if (!target) return
  const now = performance.now()
  // Re-resolve now and then even if the element is still there: a better match may have appeared.
  if (!el || !el.isConnected || now - resolvedAt > (el ? 600 : 200) || !isVisible(el)) {
    el = target.locators.length ? resolveTarget(target.locators, pageEnv()) : null
    resolvedAt = now
  }
  report()
  checkUntil(now)
  raf = requestAnimationFrame(tick)
}

function report() {
  if (!target) return
  let msg: FromContent
  if (document.visibilityState === 'hidden') {
    msg = { t: 'rect', seq: target.seq, rect: null, found: !!el, offscreen: null, url: location.href }
  } else if (el) {
    const r = el.getBoundingClientRect()
    const s = spotlightRect({ x: r.x, y: r.y, w: r.width, h: r.height }, viewport())
    msg = { t: 'rect', seq: target.seq, rect: s.rect && round(s.rect), found: true, offscreen: s.offscreen, url: location.href }
  } else {
    msg = { t: 'rect', seq: target.seq, rect: null, found: false, offscreen: null, url: location.href }
  }
  lastRect = msg.rect
  const key = JSON.stringify(msg)
  if (key !== lastSent) {
    lastSent = key
    send(msg)
  }
}

const round = (r: Rect): Rect => r.map((v) => Math.round(v * 2) / 2) as Rect

function checkUntil(now: number) {
  const u = target?.until
  if (!target || !u || untilSent || now - untilAt < 200) return
  untilAt = now
  const env = pageEnv()
  const ok =
    (u.url !== undefined && urlMatches(u.url, location.href)) ||
    (u.appear !== undefined && resolveTarget(u.appear, env) !== null) ||
    (u.gone !== undefined && resolveTarget(u.gone, env) === null)
  if (ok) {
    untilSent = true
    send({ t: 'until', seq: target.seq })
  }
}

function start(t: WebTarget | null, z: number) {
  const same = t && target && t.seq === target.seq
  target = t
  setZoom(z)
  if (!same) {
    el = null
    resolvedAt = 0
    lastSent = ''
    untilSent = false
    pointerInside = null
  }
  if (target && !raf) raf = requestAnimationFrame(tick)
  if (target) tick()
}

function stop() {
  target = null
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  picker.stop()
}

// ---------------------------------------------------------------- picking a target for the editor

const picker = new Picker(
  (el) => {
    const { label, role } = describe(el)
    send({ t: 'picked', pick: { locators: suggestLocators(el, pageEnv()), label, role, url: location.href, title: document.title } })
  },
  () => send({ t: 'pick-end' }),
)

// ---------------------------------------------------------------- presenter input

addEventListener(
  'pointerdown',
  (e) => {
    if (!target || target.act !== 'click' || !el || !e.isPrimary || e.button !== 0) return
    const r = el.getBoundingClientRect()
    const hit =
      (e.target instanceof Node && el.contains(e.target)) ||
      (e.clientX >= r.left - CLICK_SLOP && e.clientX <= r.right + CLICK_SLOP && e.clientY >= r.top - CLICK_SLOP && e.clientY <= r.bottom + CLICK_SLOP)
    if (hit) send({ t: 'click', seq: target.seq })
  },
  true,
)

addEventListener(
  'pointermove',
  (e) => {
    learnOrigin(e)
    if (!target) return
    // The app also watches the real cursor; this covers cases where the OS cursor and the
    // page disagree (e.g. input injected by automation), and is exact under page zoom.
    const vp = viewport()
    const sx = vp.originX + e.clientX * zoom
    const sy = vp.originY + e.clientY * zoom
    const inside = !!lastRect && contains(inflate(lastRect, PAD), sx, sy)
    if (inside !== pointerInside) {
      pointerInside = inside
      send({ t: 'pointer', seq: target.seq, inside })
    }
  },
  { capture: true, passive: true },
)

document.addEventListener('pointerleave', () => {
  if (target && pointerInside) {
    pointerInside = false
    send({ t: 'pointer', seq: target.seq, inside: false })
  }
})

/** Chrome also reports a "zoom change" on same-document navigations; only a real one voids calib. */
function setZoom(z: number) {
  if (z !== zoom) calib = null
  zoom = z
  zoomKnown = true
}

/**
 * MouseEvent.screenX/Y are screen points and clientX/Y are CSS pixels, so a real pointer
 * event tells us exactly where the viewport starts, including side panels and toolbars
 * that innerHeight/outerHeight cannot see.
 */
function learnOrigin(e: PointerEvent) {
  if (!zoomKnown || !e.isTrusted || e.pointerType !== 'mouse') return
  const dx = e.screenX - e.clientX * zoom - screenX
  const dy = e.screenY - e.clientY * zoom - screenY
  if (!(Math.abs(dx) < 600 && dy >= 0 && dy < 600)) return
  calib = { dx: Math.round(dx), dy: Math.round(dy) }
  // Share it as a correction to the base model, which stays valid on the next page in this window.
  const c = { x: calib.dx, y: Math.round((calib.dy - baseDy()) * 2) / 2 }
  const key = `${c.x},${c.y}`
  if (key !== corrSent) {
    corrSent = key
    corr = c
    send({ t: 'corr', ...c })
  }
}

document.addEventListener('visibilitychange', () => {
  if (target) report()
})

// ---------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((m: ToContent, _sender, reply) => {
  if (m.t === 'target') {
    if (m.corr) corr = m.corr
    start(m.target, m.zoom)
  }
  if (m.t === 'zoom') setZoom(m.zoom)
  if (m.t === 'pick') {
    if (m.on) picker.start()
    else picker.stop()
  }
  if (m.t === 'probe') reply({ ok: true })
  if (m.t === 'debug') reply({ calib, corr, zoom, screenX, screenY, outerHeight, innerHeight, innerWidth, outerWidth, dpr: devicePixelRatio, rect: lastRect })
})

send({ t: 'ready' })
