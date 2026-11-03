/**
 * Cuelight main process: wires the overlay, the player, the extension bridge, the macOS helper,
 * hotkeys and the control window together.
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
 *                           real cursor is ignored, so whoever is using the machine is not disturbed;
 *                           AI keys stay in memory, so the keychain is never asked
 *   CUELIGHT_DEV_STDIN=1    scripted checks drive the control window over stdin, one JSON command per
 *                           line: {"cmd":"eval","js":...} or {"cmd":"shot","path":...}; with
 *                           CUELIGHT_HEADLESS the window exists but is never shown (scripts/e2e-editor.mjs)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import readline from 'node:readline'
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, nativeTheme, safeStorage, screen, session, shell } from 'electron'
import {
  formatJson,
  langFromLocale,
  parseStoryboard,
  setCuePlatform,
  type Lang,
  type Locator,
  type Rect,
  type RecEvent,
  type Storyboard,
} from '@cuelight/schema'
import { AI_PROVIDERS, profileOf, type AiInfo, type AiRequest, type AiSetup } from '../shared/ai.ts'
import type { AppState, DocPayload, PickResult, SaveResult, SelftestResult } from '../shared/types.ts'
import { KeyStore, pingAi, runAi, type AiTarget } from './ai.ts'
import { Bridge } from './bridge.ts'
import { Helper, HelperError } from './helper.ts'
import { NativeTargets, axLocatorFor, axTitle, frontWindow, type AxNode, type LocalResult, type OcrLine, type WinInfo } from './native.ts'
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
const DEV_STDIN = !app.isPackaged && process.env.CUELIGHT_DEV_STDIN === '1'
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
let doc: DocPayload | null = null
let docRev = 0
/** A draft that came in mid-playback: loaded once the player is idle (null: it does not validate) */
let pending: Storyboard | null | undefined
/** Where the editor is waiting for a pick: in the browser, or in any app (native helper) */
let picking: 'web' | 'app' | null = null
/** A run being recorded in the browser, for a draft storyboard */
let recording: { typed: boolean; events: RecEvent[] } | null = null
let rehearsal: AppState['rehearsal'] = null
let loadError: AppState['loadError'] = null
let selftestRunning = false
let ticker: ReturnType<typeof setInterval> | null = null

const lang = (): Lang => (settings.data.lang === 'auto' ? langFromLocale(app.getPreferredSystemLanguages()[0] ?? app.getLocale()) : settings.data.lang)

// ---------------------------------------------------------------- non-DOM targets

function displaysInOrder() {
  const primary = screen.getPrimaryDisplay()
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)]
}

const helperPath = app.isPackaged ? join(process.resourcesPath, 'cuelight-helper') : resolve(app.getAppPath(), '..', 'helper-mac', 'build', 'cuelight-helper')
/** The macOS helper: app elements, text on screen, windows, clicks outside the browser */
const helper = process.platform === 'darwin' && existsSync(helperPath) ? new Helper([helperPath, '--owner-pid', String(process.pid)]) : null
let native: NativeTargets
let nativeStatus: AppState['native'] = { available: !!helper, trusted: null, screen: null }

async function refreshNativeStatus() {
  if (!helper) return
  try {
    const r = await helper.request<{ trusted: boolean; screen: boolean }>('status')
    if (r.trusted !== nativeStatus.trusted || r.screen !== nativeStatus.screen) {
      nativeStatus = { available: true, trusted: r.trusted, screen: r.screen }
      native.clear()
      pushState()
    }
  } catch {
    nativeStatus = { available: helper.usable, trusted: null, screen: null }
    pushState()
  }
}

/** Screen regions are worked out here; everything else goes through the helper. */
function resolveLocal(l: Locator): LocalResult {
  if (l.kind === 'dom') return 'unsupported'
  if (l.kind !== 'region' || l.relativeTo !== 'screen') return native.resolve(l)
  const d = displaysInOrder()[l.display ?? 0]
  if (!d) return null
  const b = d.bounds
  const [x, y, w, h] = l.rect
  return l.units === 'fraction' ? [b.x + x * b.width, b.y + y * b.height, w * b.width, h * b.height] : [b.x + x, b.y + y, w, h]
}

// ---------------------------------------------------------------- storyboards

const SCHEMA_URL = 'https://raw.githubusercontent.com/BilltheChurch/cuelight/main/packages/schema/storyboard.schema.json'

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

const isExample = (path: string) => resolve(path).startsWith(examplesDir + sep)
const remember = (path: string) => settings.update({ recent: [path, ...settings.data.recent.filter((p) => p !== path)].slice(0, 8) })

/**
 * Opens a file in the editor. Only unreadable JSON is refused: a storyboard that does not
 * validate still opens, so its problems can be fixed there.
 */
function openStoryboard(path: string): boolean {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a JSON object')
  } catch (e) {
    loadError = { path, issues: [String((e as Error).message)] }
    pushState()
    return false
  }
  setDoc({ path, example: isExample(path), rev: ++docRev, json })
  if (!doc!.example) remember(path)
  return parseStoryboard(json).ok
}

function setDoc(d: DocPayload | null) {
  doc = d
  loadError = null
  rehearsal = null
  if (d) applyDraft(d.json)
  else {
    pending = undefined
    player.unload()
  }
  pushState()
}

/** The player always plays what the editor shows, saved or not. */
function applyDraft(json: unknown) {
  const r = parseStoryboard(json)
  const sb = r.ok ? r.value : null
  if (player.phase !== 'idle') pending = sb
  else if (sb) player.load(sb)
  else player.unload()
}

function blank(): unknown {
  const zh = lang() === 'zh'
  return {
    $schema: SCHEMA_URL,
    cuelight: 1,
    title: zh ? '未命名分镜' : 'Untitled storyboard',
    language: zh ? 'zh-CN' : 'en',
    steps: [{ act: 'manual', say: zh ? '大家好，这是第一句。' : 'Hi! This is the first line.' }],
  }
}

async function save(json: unknown, saveAs: boolean): Promise<SaveResult> {
  if (!doc || !json || typeof json !== 'object') return { ok: false }
  let path = doc.path
  if (saveAs || !path || doc.example) {
    const title = (json as { title?: unknown }).title
    const name = (typeof title === 'string' && title.trim() ? title.trim() : 'storyboard').replace(/[/\\:*?"<>|]+/g, '-').slice(0, 80) + '.json'
    const opts = {
      defaultPath: join(path && !doc.example ? dirname(path) : app.getPath('documents'), name),
      filters: [{ name: 'Cuelight storyboard', extensions: ['json'] }],
    }
    const r = control ? await dialog.showSaveDialog(control, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    path = r.filePath
  }
  // A bundled example points at the schema by a path inside this repo; a copy elsewhere needs the URL.
  const out = doc.example && typeof (json as { $schema?: unknown }).$schema === 'string' ? { ...json, $schema: SCHEMA_URL } : json
  try {
    writeFileSync(path, formatJson(out))
  } catch (e) {
    return { ok: false, error: String((e as Error).message) }
  }
  doc = { ...doc, path, example: false, json: out }
  remember(path)
  pushState()
  return { ok: true, path }
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
  if (!playing && pending !== undefined) {
    if (pending) player.load(pending)
    else player.unload()
    pending = undefined
  }
  pushState()
}

// ---------------------------------------------------------------- AI

let keys: KeyStore
let aiRun: AbortController | null = null

const aiInfo = (): AiInfo => ({ ...settings.data.ai, keys: keys.status(), secure: keys.secure })

/**
 * Fetch for AI requests, in a session of its own so its proxy affects nothing else: the one set
 * in the app, else HTTPS_PROXY, else the system's. Loopback (Ollama, test servers) goes direct.
 */
async function aiFetch(proxy: string) {
  const ses = session.fromPartition('cuelight-ai')
  const rule = proxy.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || ''
  await ses.setProxy(rule ? { proxyRules: rule } : { mode: 'system' })
  return (input: string, init?: RequestInit) => ses.fetch(input, init)
}

/** The saved setup, or one being tried in the settings sheet; its key is decrypted only now. */
function aiTarget(s?: AiSetup): AiTarget {
  const c = settings.data.ai
  const provider = s?.provider ?? c.provider
  const prof = s?.profile ?? profileOf(c, provider)
  const key = s?.key === null ? null : typeof s?.key === 'string' && s.key.trim() ? s.key.trim() : keys.get(provider)
  return { provider, model: prof.model.trim(), baseUrl: prof.baseUrl.trim(), key }
}

// ---------------------------------------------------------------- outside the browser

let osClicks = false

/** Clicks outside the browser, only while a click step needs them. Test runs ignore real clicks. */
function watchOsClicks(on: boolean) {
  if (!helper || HEADLESS || on === osClicks) return
  osClicks = on
  helper.request('clicks', { on }).catch((e) => {
    osClicks = false
    log({ type: 'native', phase: 'clicks', error: e instanceof HelperError ? e.code : String(e) })
  })
}

function onHelperEvent(e: import('./helper.ts').HelperEvent) {
  if (e.ev === 'click') {
    log({ type: 'os-click', x: e.x, y: e.y })
    player.osClick(e.x, e.y)
  } else if (e.ev === 'pick') void finishAppPick(e.x, e.y)
  else if (e.ev === 'pick-cancel') endPick(null)
  else if (e.ev === 'exit') {
    // It forgot what it was asked to do; ask again once it is back.
    const want = osClicks
    osClicks = false
    if (want) setTimeout(() => watchOsClicks(player.wantsOsClicks), 3100)
    if (picking === 'app') endPick(null)
  }
}

type Hit = { app: string; pid: number; own: boolean; chain: AxNode[] }
let hoverTimer: ReturnType<typeof setInterval> | null = null

/** Picking in any app: the light follows the element under the cursor until the click. */
async function startAppPick(): Promise<{ ok: boolean; reason?: 'denied' | 'unavailable' }> {
  if (!helper || HEADLESS) return { ok: false, reason: 'unavailable' }
  try {
    await helper.request('pick', { on: true })
  } catch (e) {
    return { ok: false, reason: e instanceof HelperError && e.code === 'not-trusted' ? 'denied' : 'unavailable' }
  }
  picking = 'app'
  overlay.setCard(null)
  overlay.setLight(null)
  overlay.show()
  let busy = false
  hoverTimer = setInterval(async () => {
    if (busy) return
    busy = true
    const p = screen.getCursorScreenPoint()
    const hit = await helper.request<Hit>('ax.hit', { x: p.x, y: p.y }, 500).catch(() => null)
    busy = false
    if (picking !== 'app') return
    const el = hit && !hit.own ? hit.chain[0] : null
    overlay.setLight(el?.rect ?? null)
  }, 90)
  return { ok: true }
}

function stopHover() {
  if (hoverTimer) clearInterval(hoverTimer)
  hoverTimer = null
  if (picking === 'app' && player.phase === 'idle') {
    overlay.setLight(null)
    overlay.hide()
  }
}

/** `cancel`: the editor called it off, so whoever runs the picker is told to stop. */
function endPick(p: PickResult | null, cancel = false) {
  if (!picking) return
  if (picking === 'app') stopHover()
  if (cancel) {
    if (picking === 'web') bridge.send({ t: 'pick', on: false })
    else void helper?.request('pick', { on: false }).catch(() => {})
  }
  picking = null
  control?.webContents.send('pick:result', p)
  // Back to the editor to see what was picked.
  if (p && control && !HEADLESS) {
    if (control.isMinimized()) control.restore()
    app.focus({ steal: true })
    control.focus()
  }
  pushState()
}

const inflateBy = ([x, y, w, h]: Rect, d: number): Rect => [x - d, y - d, w + 2 * d, h + 2 * d]

/**
 * What the presenter clicked, as a fallback chain: the Accessibility element, the text on it
 * (for apps whose tree says little), and the same spot relative to the window.
 */
async function finishAppPick(x: number, y: number) {
  if (picking !== 'app' || !helper) return
  stopHover()
  const hit = await helper.request<Hit>('ax.hit', { x, y }, 1500).catch(() => null)
  if (!hit || hit.own) return endPick(null, true)
  const el = hit.chain[0]
  const elRect: Rect = el?.rect && el.rect[2] > 0 && el.rect[3] > 0 && el.rect[2] * el.rect[3] < 600 * 300 ? el.rect : [x - 40, y - 18, 80, 36]
  const winNode = hit.chain.findLast((n) => n.role === 'AXWindow')
  const locators: Locator[] = []
  const tree = await helper.request<{ nodes: AxNode[] }>('ax.tree', { app: hit.app }, 4000).catch(() => null)
  const ax = axLocatorFor(hit.app, hit.chain, tree?.nodes ?? null)
  if (ax && (ax.identifier || ax.title || ax.description || ax.path)) locators.push(ax)

  let text = ''
  if (nativeStatus.screen) {
    const lines = await helper
      .request<{ lines: OcrLine[] }>('ocr', { rect: inflateBy(elRect, 6) }, 5000)
      .then((r) => r.lines)
      .catch(() => [] as OcrLine[])
    const dist = (r: Rect) => Math.hypot(r[0] + r[2] / 2 - x, r[1] + r[3] / 2 - y)
    const line = lines.filter((l) => l.text.trim() && l.confidence > 0.2).sort((a, b) => dist(a.rect) - dist(b.rect))[0]
    if (line) {
      text = line.text.trim().slice(0, 48)
      const [tx, ty] = line.rect
      const box: Rect = [elRect[0] - tx, elRect[1] - ty, elRect[2], elRect[3]]
      const same = Math.abs(box[0]) < 3 && Math.abs(box[1]) < 3 && Math.abs(elRect[2] - line.rect[2]) < 6 && Math.abs(elRect[3] - line.rect[3]) < 6
      locators.push({ kind: 'visual', app: hit.app, text, ...(same ? {} : { box: box.map(Math.round) as Rect }) })
    }
  }

  const wins = await helper
    .request<{ windows: WinInfo[] }>('windows', { app: hit.app })
    .then((r) => r.windows)
    .catch(() => [] as WinInfo[])
  const win = wins.find((w) => x >= w.rect[0] && x <= w.rect[0] + w.rect[2] && y >= w.rect[1] && y <= w.rect[1] + w.rect[3]) ?? frontWindow(wins, hit.app, process.pid)
  if (win && win === frontWindow(wins, hit.app, process.pid)) {
    const r = elRect.map((v, k) => Math.round(k < 2 ? v - win.rect[k] : v)) as Rect
    locators.push({ kind: 'region', relativeTo: 'window', app: hit.app, rect: r, units: 'pt' })
  }
  if (!locators.length) return endPick(null)
  const label = (el && (axTitle(el) || el.description)) || text || el?.role?.replace(/^AX/, '') || hit.app
  endPick({ locators, label: label.trim().slice(0, 60), role: el?.role ?? null, url: '', title: winNode?.title ?? win?.title ?? '', app: hit.app })
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
    doc: doc && { path: doc.path, example: doc.example, rev: doc.rev },
    loadError,
    examples: examples(),
    recent: settings.data.recent,
    player: { phase: player.phase, n: player.i + 1, total: player.sb?.steps.length ?? 0, hidden: player.hidden },
    bridge: { port: bridge.port, code: bridge.code, browsers: bridge.browsers() },
    selftest: settings.data.selftest,
    selftestRunning,
    capturable: CAPTURABLE,
    picking: !!picking,
    native: nativeStatus,
    recording: recording && { typed: recording.typed, count: recording.events.filter((e) => e.k !== 'nav').length, last: lastAction() },
    rehearsal,
    ai: aiInfo(),
  }
}

function lastAction(): string | null {
  const e = recording?.events.findLast((x) => x.k !== 'nav')
  return e && 'label' in e ? e.label : null
}

/** `hidden`: scripted checks only (CUELIGHT_DEV_STDIN with CUELIGHT_HEADLESS); never shown. */
function createControl(hidden = false) {
  control = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    title: 'Cuelight',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f4f3ef',
    // A window that is never shown would otherwise be throttled, and its pictures lag the page.
    webPreferences: { preload: join(import.meta.dirname, '../preload/control.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: !hidden },
  })
  if (!hidden) control.once('ready-to-show', () => control?.show())
  control.on('closed', () => {
    control = null
  })
  // Permissions are switched on in System Settings, so look again whenever the presenter is back.
  control.on('focus', () => void refreshNativeStatus())
  // The editor holds back the close while it has unsaved changes; ask what to do.
  control.webContents.on('will-prevent-unload', (e) => {
    const zh = lang() === 'zh'
    const choice = dialog.showMessageBoxSync(control!, {
      type: 'question',
      buttons: zh ? ['放弃修改', '取消'] : ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: zh ? '分镜有未保存的修改' : 'The storyboard has unsaved changes',
      detail: zh ? '关掉的话，这些修改会丢失。' : 'If you close now, they are lost.',
    })
    if (choice === 0) e.preventDefault()
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
  ipcMain.handle('storyboard:new', (_e, json?: unknown) =>
    setDoc({ path: null, example: false, rev: ++docRev, json: json && typeof json === 'object' && !Array.isArray(json) ? json : blank() }),
  )
  ipcMain.handle('storyboard:close', () => setDoc(null))
  ipcMain.handle('storyboard:doc', () => doc)
  ipcMain.handle('storyboard:draft', (_e, json: unknown) => {
    if (!doc) return
    doc = { ...doc, json }
    applyDraft(json)
  })
  ipcMain.handle('storyboard:save', (_e, json: unknown, saveAs: boolean) => save(json, !!saveAs))
  ipcMain.handle('player:play', (_e, from?: number) => player.start(typeof from === 'number' ? from : 0))
  ipcMain.handle('player:rehearse', (_e, i: number) => {
    if (typeof i === 'number' && player.phase === 'idle') player.start(i, { single: true })
  })
  ipcMain.handle('player:stop', () => player.stop())
  ipcMain.handle('record', (_e, on: boolean, typed: boolean) => {
    if (on) {
      if (player.phase !== 'idle' || !bridge.connected()) return { ok: false, events: [] }
      // Starting again while recording only changes whether typed text is kept.
      recording = { typed: !!typed, events: recording?.events ?? [] }
      bridge.send({ t: 'record', on: true, typed: !!typed })
      pushState()
      return { ok: true, events: [] }
    }
    const events = recording?.events ?? []
    recording = null
    bridge.send({ t: 'record', on: false, typed: false })
    pushState()
    return { ok: true, events }
  })
  ipcMain.handle('pick', async (_e, on: boolean, where: 'web' | 'app' = 'web') => {
    if (!on) {
      endPick(null, true)
      return { ok: true }
    }
    if (picking || player.phase !== 'idle') return { ok: false }
    if (where === 'app') {
      const r = await startAppPick()
      pushState()
      return r
    }
    if (!bridge.connected()) return { ok: false }
    picking = 'web'
    bridge.send({ t: 'pick', on: true })
    pushState()
    return { ok: true }
  })
  ipcMain.handle('native:ask', async (_e, what: 'ax' | 'screen') => {
    if (!helper || HEADLESS || (what !== 'ax' && what !== 'screen')) return
    // The system shows its own prompt the first time; after that the switch is in System Settings.
    const r = await helper.request<{ granted: boolean }>('ask', { what }).catch(() => ({ granted: false }))
    if (!r.granted) {
      const pane = what === 'ax' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    }
    await refreshNativeStatus()
  })
  ipcMain.handle('selftest:run', () => selftest())
  ipcMain.handle('settings:lang', (_e, l: AppState['langSetting']) => {
    if (l === 'auto' || l === 'en' || l === 'zh') settings.update({ lang: l })
    pushState()
  })
  ipcMain.handle('bridge:code', () => bridge.newCode())
  ipcMain.handle('bridge:forget', (_e, id: string) => bridge.forget(id))
  ipcMain.handle('extension:reveal', () => shell.openPath(extensionDir))
  ipcMain.handle('ai:setup', (_e, s: AiSetup) => {
    if (!AI_PROVIDERS.includes(s?.provider)) return
    const c = settings.data.ai
    const profile = { model: String(s.profile?.model ?? '').trim(), baseUrl: String(s.profile?.baseUrl ?? '').trim() }
    settings.update({ ai: { provider: s.provider, proxy: String(s.proxy ?? '').trim(), profiles: { ...c.profiles, [s.provider]: profile } } })
    if (s.key !== undefined) keys.set(s.provider, s.key)
    log({ type: 'ai', phase: 'setup', provider: s.provider, model: profile.model, key: keys.has(s.provider) })
    pushState()
  })
  ipcMain.handle('ai:test', async (_e, s: AiSetup) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 60_000)
    try {
      const r = await pingAi(aiTarget(s), { fetch: await aiFetch(s.proxy ?? ''), signal: ctl.signal })
      log({ type: 'ai', phase: 'test', ...r })
      return r
    } finally {
      clearTimeout(timer)
    }
  })
  ipcMain.handle('ai:run', async (_e, req: AiRequest) => {
    if (aiRun) return { ok: false, error: 'busy' }
    const ctl = (aiRun = new AbortController())
    const t = aiTarget()
    log({ type: 'ai', phase: 'start', provider: t.provider, model: t.model, scope: req.scope })
    try {
      const r = await runAi(req, t, {
        fetch: await aiFetch(settings.data.ai.proxy),
        signal: ctl.signal,
        onProgress: (chars) => control?.webContents.send('ai:progress', chars),
      })
      log({ type: 'ai', phase: r.ok ? 'done' : 'error', ...(r.ok ? { model: r.model, steps: r.out.steps.length } : { error: r.error, detail: r.detail }) })
      return r
    } finally {
      aiRun = null
    }
  })
  ipcMain.handle('ai:cancel', () => aiRun?.abort())
}

// ---------------------------------------------------------------- startup

app.whenReady().then(async () => {
  if (HEADLESS) app.dock?.hide()
  settings = SettingsFile.in(app.getPath('userData'))
  // Test runs never touch the keychain: their keys live in memory only.
  keys = HEADLESS
    ? new KeyStore(null, null)
    : new KeyStore(join(app.getPath('userData'), 'ai-keys.json'), {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (k) => safeStorage.encryptString(k),
        decrypt: (b) => safeStorage.decryptString(b),
      })
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

  native = new NativeTargets({
    helper,
    now: () => performance.now(),
    ownPid: process.pid,
    screenAt: () => {
      const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
      return [b.x, b.y, b.width, b.height]
    },
  })
  helper?.onEvent(onHelperEvent)
  void refreshNativeStatus()

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
    activate: (bundle) => {
      if (!HEADLESS) void helper?.request('activate', { app: bundle }).catch(() => {})
    },
    lang,
    now: () => performance.now(),
    onEvent: (e) => {
      log(e)
      if (e.type === 'phase' || e.type === 'step') watchOsClicks(player.wantsOsClicks)
      if (e.type === 'phase') onPhase(e.phase)
      if (e.type === 'rehearsed') {
        rehearsal = { n: e.n, reason: e.reason, secs: e.secs, est: e.est, at: Date.now() }
        pushState()
      }
    },
  })
  bridge.on('message', (m) => {
    if (LOG && m.t !== 'rect' && m.t !== 'pointer') log({ type: 'web', m })
    if (LOG && m.t === 'rect') log({ type: 'rect', seq: m.seq, rect: m.rect, found: m.found, offscreen: m.offscreen })
    if (m.t === 'rec') {
      if (recording) {
        recording.events.push(m.ev)
        pushState()
      }
      return
    }
    if (m.t === 'picked' || m.t === 'pick-end') {
      if (picking === 'web') endPick(m.t === 'picked' ? m.pick : null)
      return
    }
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
  else if (DEV_STDIN) createControl(true)
  if (DEV_STDIN) devStdin()

  const file = opt('--open')
  if (file && openStoryboard(resolve(file)) && flag('--play')) player.start(Math.max(0, Number(opt('--from') ?? 1) - 1))
})

/** Development only: scripted checks drive the control window over stdin (see the header). */
function devStdin() {
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let c: { id?: number; cmd?: string; js?: string; path?: string }
    try {
      c = JSON.parse(line)
    } catch {
      return
    }
    try {
      if (!control) throw new Error('no control window')
      if (c.cmd === 'eval') log({ type: 'eval', id: c.id, ok: true, value: await control.webContents.executeJavaScript(String(c.js), true) })
      else if (c.cmd === 'shot') {
        // Paint what the page shows now, not the last frame painted.
        control.webContents.invalidate()
        await new Promise((r) => setTimeout(r, 150))
        writeFileSync(String(c.path), (await control.webContents.capturePage()).toPNG())
        log({ type: 'shot', id: c.id, ok: true, path: c.path })
      }
    } catch (e) {
      log({ type: c.cmd ?? 'stdin', id: c.id, ok: false, error: String((e as Error).message ?? e) })
    }
  })
}

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
  helper?.stop()
})
