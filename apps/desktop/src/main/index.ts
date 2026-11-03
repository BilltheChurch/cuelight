/**
 * Cuelight main process: wires the overlay, the player, the extension bridge, hotkeys and the
 * control window together.
 *
 * Command line (also handy for scripted checks):
 *   --selftest [--selftest-out <dir>]   run the capture self-test, print JSON, exit 0 on pass
 *   --open <storyboard.json> [--play [--from <n>]]
 *   --log                                print player events as JSON lines on stdout
 * Environment (development only):
 *   CUELIGHT_CAPTURABLE=1   leave the overlay visible to screen capture (a red badge says so)
 *   CUELIGHT_CAPTURABLE=docs  the same without the badge, for screenshots in the README
 *   CUELIGHT_DEV_TOKEN=...  accept this bridge token without pairing (scripts/e2e-web.mjs uses it)
 *   CUELIGHT_USER_DATA=...  keep settings and pairings in this folder instead (throwaway test runs)
 *   CUELIGHT_HEADLESS=1     invisible test runs: no windows, no Dock icon, no global hotkeys, and the
 *                           real cursor is ignored, so whoever is using the machine is not disturbed
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, nativeTheme, screen, shell } from 'electron'
import {
  estimateSecs,
  langFromLocale,
  parseStoryboard,
  setCuePlatform,
  defaultTag,
  type Lang,
  type Locator,
  type Rect,
  type Storyboard,
} from '@cuelight/schema'
import type { AppState, LoadedStoryboard, SelftestResult } from '../shared/types.ts'
import { Bridge } from './bridge.ts'
import { OverlayManager } from './overlay.ts'
import { Player } from './player.ts'
import { runSelftest } from './selftest.ts'
import { SettingsFile } from './settings.ts'

const argv = process.argv
const flag = (k: string) => argv.includes(k)
const opt = (k: string) => {
  const i = argv.indexOf(k)
  return i > 0 ? argv[i + 1] : undefined
}
const SELFTEST = flag('--selftest')
const LOG = flag('--log')
const CAPTURABLE = !app.isPackaged && (process.env.CUELIGHT_CAPTURABLE === '1' || process.env.CUELIGHT_CAPTURABLE === 'docs')
const DEV_TOKEN = !app.isPackaged ? process.env.CUELIGHT_DEV_TOKEN : undefined
const HEADLESS = !app.isPackaged && process.env.CUELIGHT_HEADLESS === '1'
/** Headless runs feed the player a cursor that never moves, so only page pointer events count. */
const NO_CURSOR = { x: -1e6, y: -1e6 }

const log = (o: object) => {
  if (LOG) process.stdout.write('CUELIGHT ' + JSON.stringify(o) + '\n')
}

if (!app.isPackaged && process.env.CUELIGHT_USER_DATA) app.setPath('userData', process.env.CUELIGHT_USER_DATA)
if (!SELFTEST && !app.requestSingleInstanceLock()) app.exit(0)
setCuePlatform(process.platform)
app.setName('Cuelight')

const resourcesDir = app.isPackaged ? process.resourcesPath : resolve(app.getAppPath(), '..', '..')
const examplesDir = join(resourcesDir, 'examples')
const extensionDir = app.isPackaged ? join(process.resourcesPath, 'extension') : resolve(app.getAppPath(), '..', 'extension', 'dist')

function loadPage(win: BrowserWindow, page: 'control' | 'overlay') {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) void win.loadURL(`${dev}/${page}.html`)
  else void win.loadFile(join(import.meta.dirname, '../renderer', `${page}.html`))
}

let settings: SettingsFile
let bridge: Bridge
let overlay: OverlayManager
let player: Player
let control: BrowserWindow | null = null
let loaded: LoadedStoryboard | null = null
let loadError: AppState['loadError'] = null
let selftestRunning = false
let ticker: ReturnType<typeof setInterval> | null = null

const lang = (): Lang => (settings.data.lang === 'auto' ? langFromLocale(app.getPreferredSystemLanguages()[0] ?? app.getLocale()) : settings.data.lang)

// ---------------------------------------------------------------- non-DOM targets

function displaysInOrder() {
  const primary = screen.getPrimaryDisplay()
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)]
}

/** Regions relative to a screen work now; windows, Accessibility and OCR need the native helper (M5). */
function resolveLocal(l: Locator): Rect | null | 'unsupported' {
  if (l.kind !== 'region' || l.relativeTo !== 'screen') return 'unsupported'
  const d = displaysInOrder()[l.display ?? 0]
  if (!d) return null
  const b = d.bounds
  const [x, y, w, h] = l.rect
  return l.units === 'fraction' ? [b.x + x * b.width, b.y + y * b.height, w * b.width, h * b.height] : [b.x + x, b.y + y, w, h]
}

// ---------------------------------------------------------------- storyboards

function summarize(path: string, sb: Storyboard): LoadedStoryboard {
  return {
    path,
    title: sb.title,
    description: sb.description ?? null,
    language: sb.language ?? null,
    estSecs: Math.round(estimateSecs(sb)),
    steps: sb.steps.map((s, i) => ({
      n: i + 1,
      act: s.act,
      tag: defaultTag(s, lang()),
      say: s.say,
      hasTarget: !!s.target,
      kinds: [...new Set((s.target ?? []).map((l) => l.kind))],
    })),
  }
}

function readStoryboard(path: string): { ok: true; sb: Storyboard } | { ok: false; issues: string[] } {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { ok: false, issues: [String((e as Error).message)] }
  }
  const r = parseStoryboard(json)
  return r.ok ? { ok: true, sb: r.value } : { ok: false, issues: r.issues }
}

function openStoryboard(path: string): boolean {
  const r = readStoryboard(path)
  if (!r.ok) {
    loadError = { path, issues: r.issues }
    pushState()
    return false
  }
  player.load(r.sb)
  loaded = summarize(path, r.sb)
  loadError = null
  if (!path.startsWith(examplesDir)) settings.update({ recent: [path, ...settings.data.recent.filter((p) => p !== path)].slice(0, 8) })
  pushState()
  return true
}

function examples(): AppState['examples'] {
  try {
    return readdirSync(examplesDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const r = readStoryboard(join(examplesDir, f))
        return r.ok ? [{ id: basename(f, '.json'), title: r.sb.title, description: r.sb.description ?? '', steps: r.sb.steps.length }] : []
      })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- playback lifecycle

const HOTKEYS: [string, () => void][] = [
  ['Alt+CommandOrControl+Right', () => player.next()],
  ['Alt+CommandOrControl+Left', () => player.prev()],
  ['Alt+CommandOrControl+H', () => player.toggleHidden()],
]

function onPhase(phase: Player['phase']) {
  const playing = phase !== 'idle'
  if (playing && !ticker) {
    if (!HEADLESS) {
      for (const [acc, fn] of HOTKEYS) if (!globalShortcut.register(acc, fn)) console.warn(`[hotkey] could not register ${acc}`)
      log({ type: 'hotkeys', registered: HOTKEYS.map(([a]) => [a, globalShortcut.isRegistered(a)]) })
    }
    ticker = setInterval(() => {
      if (HEADLESS) return player.tick(NO_CURSOR)
      const p = screen.getCursorScreenPoint()
      player.tick(p)
      overlay.cursor(p)
    }, 16)
  } else if (!playing && ticker) {
    clearInterval(ticker)
    ticker = null
    for (const [acc] of HOTKEYS) globalShortcut.unregister(acc)
  }
  pushState()
}

// ---------------------------------------------------------------- control window

let statePending = false
function pushState() {
  if (statePending) return
  statePending = true
  setTimeout(() => {
    statePending = false
    control?.webContents.send('app:state', state())
  }, 30)
}

function state(): AppState {
  return {
    version: app.getVersion(),
    platform: process.platform,
    lang: lang(),
    langSetting: settings.data.lang,
    storyboard: loaded,
    loadError,
    examples: examples(),
    recent: settings.data.recent,
    player: { phase: player.phase, n: player.i + 1, total: player.sb?.steps.length ?? 0, hidden: player.hidden },
    bridge: { port: bridge.port, code: bridge.code, browsers: bridge.browsers() },
    selftest: settings.data.selftest,
    selftestRunning,
    capturable: CAPTURABLE,
  }
}

function createControl() {
  control = new BrowserWindow({
    width: 1140,
    height: 800,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: 'Cuelight',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f4f3ef',
    webPreferences: { preload: join(import.meta.dirname, '../preload/control.cjs'), sandbox: true, contextIsolation: true },
  })
  control.once('ready-to-show', () => control?.show())
  control.on('closed', () => {
    control = null
  })
  control.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadPage(control, 'control')
}

async function selftest(outDir?: string): Promise<SelftestResult> {
  selftestRunning = true
  pushState()
  try {
    const r = await runSelftest(overlay, { outDir, keepProtection: !CAPTURABLE })
    settings.update({ selftest: r })
    return r
  } finally {
    selftestRunning = false
    pushState()
  }
}

function ipc() {
  ipcMain.handle('app:state', () => state())
  ipcMain.handle('storyboard:dialog', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Cuelight storyboard', extensions: ['json'] }] })
    if (!r.canceled && r.filePaths[0]) openStoryboard(r.filePaths[0])
  })
  ipcMain.handle('storyboard:example', (_e, id: string) => {
    if (/^[\w-]+$/.test(id)) openStoryboard(join(examplesDir, `${id}.json`))
  })
  ipcMain.handle('storyboard:path', (_e, p: string) => {
    if (settings.data.recent.includes(p)) openStoryboard(p)
  })
  ipcMain.handle('player:play', (_e, from?: number) => player.start(typeof from === 'number' ? from : 0))
  ipcMain.handle('player:stop', () => player.stop())
  ipcMain.handle('selftest:run', () => selftest())
  ipcMain.handle('settings:lang', (_e, l: AppState['langSetting']) => {
    if (l === 'auto' || l === 'en' || l === 'zh') settings.update({ lang: l })
    if (loaded) {
      const r = readStoryboard(loaded.path)
      if (r.ok) loaded = summarize(loaded.path, r.sb)
    }
    pushState()
  })
  ipcMain.handle('bridge:code', () => bridge.newCode())
  ipcMain.handle('bridge:forget', (_e, id: string) => bridge.forget(id))
  ipcMain.handle('extension:reveal', () => shell.openPath(extensionDir))
}

// ---------------------------------------------------------------- startup

app.whenReady().then(async () => {
  if (HEADLESS) app.dock?.hide()
  settings = SettingsFile.in(app.getPath('userData'))
  overlay = new OverlayManager({
    capturable: CAPTURABLE,
    quiet: process.env.CUELIGHT_CAPTURABLE === 'docs',
    headless: HEADLESS,
    preload: join(import.meta.dirname, '../preload/overlay.cjs'),
    load: (w) => loadPage(w, 'overlay'),
    lang,
  })

  if (SELFTEST) {
    const r = await runSelftest(overlay, { outDir: opt('--selftest-out') })
    process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    app.exit(r.pass ? 0 : 1)
    return
  }

  bridge = new Bridge(
    { browsers: () => settings.data.browsers, save: (browsers) => settings.update({ browsers }) },
    `Cuelight ${app.getVersion()}`,
    DEV_TOKEN,
  )
  player = new Player({
    overlay: {
      show: () => overlay.show(),
      hide: () => overlay.hide(),
      toggle: () => overlay.toggle(),
      card: (c) => overlay.setCard(c),
      light: (r) => overlay.setLight(r),
      inside: (b) => overlay.setInside(b),
      progress: (v) => overlay.setProgress(v),
    },
    web: {
      target: (target) => bridge.send({ t: 'target', target }),
      navigate: (url) => bridge.send({ t: 'navigate', url }),
      status: (s) => {
        bridge.send({ t: 'status', ...s })
        pushState()
      },
      connected: () => bridge.connected(),
    },
    local: resolveLocal,
    lang,
    now: () => performance.now(),
    onEvent: (e) => {
      log(e)
      if (e.type === 'phase') onPhase(e.phase)
    },
  })
  bridge.on('message', (m) => {
    if (LOG && m.t !== 'rect' && m.t !== 'pointer') log({ type: 'web', m })
    if (LOG && m.t === 'rect') log({ type: 'rect', seq: m.seq, rect: m.rect, found: m.found, offscreen: m.offscreen })
    player.onWeb(m)
  })
  bridge.on('authed', () => player.resendTarget())
  bridge.on('change', () => pushState())
  try {
    const port = await bridge.start()
    log({ type: 'bridge', port, code: LOG ? bridge.code : undefined })
  } catch (e) {
    dialog.showErrorBox('Cuelight', `Could not open the local bridge: ${(e as Error).message}`)
  }

  ipc()
  if (!HEADLESS) createControl()

  const file = opt('--open')
  if (file && openStoryboard(resolve(file)) && flag('--play')) player.start(Math.max(0, Number(opt('--from') ?? 1) - 1))
})

app.on('second-instance', () => {
  if (HEADLESS) return
  if (control) {
    if (control.isMinimized()) control.restore()
    control.focus()
  } else createControl()
})
app.on('activate', () => {
  if (!control && !HEADLESS) createControl()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  bridge?.stop()
})
