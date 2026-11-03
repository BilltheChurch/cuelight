/**
 * One transparent, click-through, always-on-top window per display, excluded from screen
 * capture with setContentProtection (NSWindowSharingNone on macOS, WDA_EXCLUDEFROMCAPTURE on
 * Windows). The windows only draw; all state lives here and in the player.
 */
import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { center, cue, inflate, type Lang, type Rect } from '@cuelight/schema'
import type { OverlayCard, OverlayView } from '../shared/types.ts'
import { PAD } from './player.ts'

type Win = { win: BrowserWindow; display: Display; ready: boolean; last: string; cursorSent: boolean }

export type OverlayOptions = {
  /** Debug only: leave the overlay visible to capture, with a warning badge on screen */
  capturable: boolean
  preload: string
  load: (w: BrowserWindow) => void
  lang: () => Lang
}

/** Guide line from the cursor to the light when the cursor is this far away (points) */
const GUIDE_MIN_DIST = 140

export class OverlayManager {
  private wins = new Map<number, Win>()
  private active = false
  private hidden = false
  private card: OverlayCard | null = null
  private light: Rect | null = null
  private inside = false
  private progress: number | null = null
  private pattern: { displayId: number; rect: Rect } | null = null
  private protect: boolean

  constructor(private o: OverlayOptions) {
    this.protect = !o.capturable
    const resync = () => {
      for (const w of this.wins.values()) w.win.destroy()
      this.wins.clear()
      this.sync()
    }
    screen.on('display-added', resync)
    screen.on('display-removed', resync)
    screen.on('display-metrics-changed', resync)
    ipcMain.on('overlay:ready', (e) => {
      for (const w of this.wins.values())
        if (w.win.webContents === e.sender) {
          w.ready = true
          w.last = ''
        }
      this.push()
    })
  }

  get protectedFromCapture() {
    return this.protect
  }

  show() {
    this.active = true
    this.hidden = false
    this.sync()
    this.push()
  }

  hide() {
    this.active = false
    this.card = null
    this.light = null
    this.progress = null
    this.sync()
  }

  toggle(): boolean {
    this.hidden = !this.hidden
    this.push()
    return this.hidden
  }

  setCard(c: OverlayCard | null) {
    this.card = c
    this.push()
  }

  setLight(r: Rect | null) {
    this.light = r
    this.push()
  }

  setInside(b: boolean) {
    this.inside = b
    this.push()
  }

  setProgress(v: number | null) {
    this.progress = v
    this.push()
  }

  setProtection(on: boolean) {
    this.protect = on
    for (const w of this.wins.values()) w.win.setContentProtection(on)
    this.push()
  }

  /** Self-test: draw a known pattern (global rect) on one display, even when not playing. */
  showPattern(displayId: number, rect: Rect | null) {
    this.pattern = rect ? { displayId, rect } : null
    this.sync()
    this.push()
  }

  /** Resolves once every overlay window has loaded and received its first view. */
  async whenReady(timeoutMs = 5000) {
    const t0 = Date.now()
    while ([...this.wins.values()].some((w) => !w.ready) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 30))
  }

  windowsFor(displayId: number) {
    return this.wins.get(displayId)?.win ?? null
  }

  cursor(p: { x: number; y: number }) {
    const light = this.light
    let target: number | null = null
    let local: { x: number; y: number } | null = null
    if (this.active && !this.hidden && light && !this.inside) {
      const c = center(light)
      const d = screen.getDisplayNearestPoint({ x: Math.round(c.x), y: Math.round(c.y) })
      const b = d.bounds
      const onDisplay = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (onDisplay && Math.hypot(p.x - c.x, p.y - c.y) > GUIDE_MIN_DIST) {
        target = d.id
        local = { x: p.x - b.x, y: p.y - b.y }
      }
    }
    for (const [id, w] of this.wins) {
      if (!w.ready) continue
      if (id === target) {
        w.win.webContents.send('overlay:cursor', local)
        w.cursorSent = true
      } else if (w.cursorSent) {
        w.win.webContents.send('overlay:cursor', null)
        w.cursorSent = false
      }
    }
  }

  // ---------------------------------------------------------------- windows

  private sync() {
    const want = this.active || this.pattern !== null
    const displays = want ? screen.getAllDisplays() : []
    for (const [id, w] of this.wins)
      if (!displays.some((d) => d.id === id)) {
        w.win.destroy()
        this.wins.delete(id)
      }
    for (const d of displays) if (!this.wins.has(d.id)) this.wins.set(d.id, this.create(d))
  }

  private create(display: Display): Win {
    const { x, y, width, height } = display.bounds
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      // An NSPanel can float above full-screen apps without stealing focus.
      type: process.platform === 'darwin' ? 'panel' : 'toolbar',
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      roundedCorners: false,
      webPreferences: { preload: this.o.preload, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    })
    // Before anything is drawn, so no frame ever reaches a recorder.
    win.setContentProtection(this.protect)
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.setBounds(display.bounds)
    const w: Win = { win, display, ready: false, last: '', cursorSent: false }
    win.once('ready-to-show', () => win.showInactive())
    this.o.load(win)
    return w
  }

  // ---------------------------------------------------------------- views

  private targetDisplay(): Display {
    if (this.light) {
      const c = center(this.light)
      return screen.getDisplayNearestPoint({ x: Math.round(c.x), y: Math.round(c.y) })
    }
    return screen.getPrimaryDisplay()
  }

  private push() {
    if (!this.wins.size) return
    const target = this.targetDisplay()
    const lang = this.o.lang()
    for (const w of this.wins.values()) {
      if (!w.ready) continue
      const b = w.display.bounds
      const mine = w.display.id === target.id
      const hole = this.light && mine ? (inflate(this.light, PAD).map((v, i) => (i === 0 ? v - b.x : i === 1 ? v - b.y : v)) as Rect) : null
      const pat = this.pattern?.displayId === w.display.id ? this.pattern.rect : null
      const view: OverlayView = {
        visible: (this.active && !this.hidden) || pat !== null,
        dim: !this.active || !this.light ? 'none' : mine ? 'around' : 'full',
        hole,
        inside: this.inside,
        card: this.active && mine ? this.card : null,
        progress: this.active && mine ? this.progress : null,
        capturable: !this.protect,
        capturableLabel: cue(lang, 'capturable'),
        pattern: pat && ([pat[0] - b.x, pat[1] - b.y, pat[2], pat[3]] as Rect),
        topInset: w.display.workArea.y - b.y,
      }
      const key = JSON.stringify(view)
      if (key === w.last) continue
      w.last = key
      w.win.webContents.send('overlay:view', view)
    }
  }
}
