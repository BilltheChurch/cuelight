/**
 * Background service worker: the one WebSocket to the Cuelight app, and the router between
 * the app and the content script of the "stage" tab (the active tab of the last focused
 * browser window).
 */
import { BRIDGE_PORTS, PROTOCOL_VERSION, type AppMessage, type ExtMessage, type WebTarget } from '@cuelight/schema'
import type { BridgeStatus, Correction, FromContent, FromPopup, PopupState, ToContent } from './messages.ts'

const VERSION = chrome.runtime.getManifest().version

let ws: WebSocket | null = null
let status: BridgeStatus = 'connecting'
let port: number | null = null
let error: string | null = null
let appName: string | null = null
let show: PopupState['show'] = null
let target: WebTarget | null = null
let stageTab: number | null = null
let pendingCode: string | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let ping: ReturnType<typeof setInterval> | null = null
let backoff = 1000
/**
 * Viewport correction per browser window, as last learned by a content script there, plus the
 * latest one overall (kept across restarts) as the default for windows that have not seen a
 * mouse move yet.
 */
const corrByWindow = new Map<number, Correction>()
let lastCorr: Correction | null | undefined
/** Latest zoom per tab, set the moment Chrome reports a change, so a slow read cannot go stale */
const zoomByTab = new Map<number, number>()
const zoomOf = async (tabId: number) => {
  const read = await chrome.tabs.getZoom(tabId).catch(() => 1)
  // A change reported while that read was in flight is newer than the read.
  return zoomByTab.get(tabId) ?? read
}

const send = (m: ExtMessage) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
}

function setStatus(s: BridgeStatus, err: string | null = error) {
  status = s
  error = err
  void chrome.action.setBadgeText({ text: s === 'unpaired' || s === 'denied' ? '!' : '' })
  void chrome.action.setBadgeBackgroundColor({ color: '#D6A84A' })
  chrome.runtime.sendMessage({ t: 'popup-state', state: popupState() }).catch(() => {})
}

const popupState = (): PopupState => ({ status, port, error, app: appName, show })

function browserName() {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } }).userAgentData?.brands ?? []
  const b = brands.find((x) => !/Not.?A.?Brand|Chromium/i.test(x.brand)) ?? brands.find((x) => x.brand === 'Chromium')
  return b ? `${b.brand} ${b.version}` : 'Chromium'
}

function tryOpen(p: number): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let s: WebSocket
    try {
      s = new WebSocket(`ws://127.0.0.1:${p}`)
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      s.close()
      resolve(null)
    }, 1500)
    s.onopen = () => {
      clearTimeout(timer)
      resolve(s)
    }
    s.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

let connecting = false
async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return
  connecting = true
  try {
    if (retry) clearTimeout(retry)
    retry = null
    const { token } = (await chrome.storage.local.get('token')) as { token?: string }
    if (!token && !pendingCode) {
      setStatus('unpaired', null)
      return
    }
    if (status !== 'connected') setStatus('connecting')
    for (const p of BRIDGE_PORTS) {
      const sock = await tryOpen(p)
      if (!sock) continue
      ws = sock
      port = p
      sock.onmessage = (ev) => {
        try {
          onApp(JSON.parse(String(ev.data)) as AppMessage)
        } catch {
          // ignore malformed frames
        }
      }
      sock.onclose = () => {
        if (ws !== sock) return
        ws = null
        if (ping) clearInterval(ping)
        ping = null
        if (status === 'connected' || status === 'connecting') setStatus('offline')
        scheduleRetry()
      }
      send({ t: 'hello', v: PROTOCOL_VERSION, token: pendingCode ? undefined : token, code: pendingCode ?? undefined, browser: browserName(), ext: VERSION })
      return
    }
    setStatus('offline')
    scheduleRetry()
  } finally {
    connecting = false
  }
}

function scheduleRetry() {
  if (retry || status === 'unpaired' || status === 'denied') return
  retry = setTimeout(() => {
    retry = null
    void connect()
  }, backoff)
  backoff = Math.min(backoff * 2, 5000)
}

function onApp(m: AppMessage) {
  switch (m.t) {
    case 'welcome':
      if (m.token) void chrome.storage.local.set({ token: m.token })
      pendingCode = null
      appName = m.app
      backoff = 1000
      setStatus('connected', null)
      if (ping) clearInterval(ping)
      // Messages keep an MV3 service worker alive; 20 s is under the 30 s idle limit.
      ping = setInterval(() => send({ t: 'ping' }), 20_000)
      void refreshStage(true)
      return
    case 'denied':
      pendingCode = null
      if (m.reason === 'bad-token') void chrome.storage.local.remove('token')
      setStatus(m.reason === 'bad-token' ? 'unpaired' : 'denied', m.reason)
      ws?.close()
      return
    case 'target':
      target = m.target
      void pushTarget()
      return
    case 'navigate':
      void navigate(m.url)
      return
    case 'status':
      show = { playing: m.playing, n: m.n, total: m.total, title: m.title, loaded: m.loaded }
      setStatus(status)
      return
    case 'pong':
      return
  }
}

// ---------------------------------------------------------------- the stage tab

async function tell(tabId: number, m: ToContent): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, m)
    return true
  } catch {
    return false
  }
}

async function refreshStage(force = false) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  if (!win?.id) return
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
  const id = tab?.id ?? null
  if (id === stageTab && !force) return
  const old = stageTab
  stageTab = id
  if (old !== null && old !== id) void tell(old, { t: 'target', target: null, zoom: 1, corr: null })
  if (target) send({ t: 'rect', seq: target.seq, rect: null, found: false, offscreen: null, url: tab?.url ?? '' })
  await pushTarget()
}

async function pushTarget() {
  if (stageTab === null) await refreshStage()
  if (stageTab === null) return
  const tabId = stageTab
  const win = await chrome.tabs.get(tabId).then((t) => t.windowId).catch(() => null)
  lastCorr ??= ((await chrome.storage.local.get('corr')) as { corr?: Correction }).corr ?? null
  const corr = (win !== null && corrByWindow.get(win)) || lastCorr
  // Read zoom last: a change that lands during the awaits above must not be overwritten.
  const ok = await tell(tabId, { t: 'target', target, zoom: await zoomOf(tabId), corr })
  // Tabs opened before the extension was installed have no content script yet.
  if (!ok && target) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {})
}

async function navigate(url: string) {
  if (stageTab === null) await refreshStage()
  if (stageTab === null) {
    await chrome.tabs.create({ url })
    return
  }
  // Already there: don't reload a page the presenter may have set up.
  const tab = await chrome.tabs.get(stageTab).catch(() => null)
  if (tab?.url === url) await chrome.tabs.update(stageTab, { active: true }).catch(() => {})
  else await chrome.tabs.update(stageTab, { url, active: true }).catch(() => {})
}

chrome.tabs.onActivated.addListener(() => void refreshStage())
chrome.tabs.onRemoved.addListener((id) => {
  zoomByTab.delete(id)
  if (id === stageTab) {
    stageTab = null
    void refreshStage()
  }
})
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === stageTab && info.status === 'loading' && target) {
    send({ t: 'rect', seq: target.seq, rect: null, found: false, offscreen: null, url: info.url ?? '' })
  }
})
// Every tab, not just the stage: a page calibrates from mouse moves before it is ever on stage.
chrome.tabs.onZoomChange.addListener((z) => {
  zoomByTab.set(z.tabId, z.newZoomFactor)
  void tell(z.tabId, { t: 'zoom', zoom: z.newZoomFactor })
})
chrome.windows.onRemoved.addListener((windowId) => corrByWindow.delete(windowId))
chrome.windows.onFocusChanged.addListener((windowId) => {
  const focused = windowId !== chrome.windows.WINDOW_ID_NONE
  send({ t: 'focus', focused })
  if (focused) void refreshStage()
})

// ---------------------------------------------------------------- content scripts and popup

const EXT_ORIGIN = chrome.runtime.getURL('')

chrome.runtime.onMessage.addListener((m: FromContent | FromPopup, sender, reply) => {
  // The popup can also be open as a tab, so tell extension pages apart by URL, not by sender.tab.
  const fromPage = sender.tab?.id !== undefined && !sender.url?.startsWith(EXT_ORIGIN)
  if (fromPage && sender.tab?.id !== undefined) {
    const msg = m as FromContent
    if (msg.t === 'ready') {
      const id = sender.tab.id
      if (id === stageTab) void pushTarget()
      else {
        void zoomOf(id).then((zoom) => tell(id, { t: 'zoom', zoom }))
        if (stageTab === null) void refreshStage()
      }
      return
    }
    if (msg.t === 'corr') {
      lastCorr = { x: msg.x, y: msg.y }
      corrByWindow.set(sender.tab.windowId, lastCorr)
      void chrome.storage.local.set({ corr: lastCorr })
      return
    }
    if (sender.tab.id === stageTab) send(msg)
    return
  }
  const p = m as FromPopup
  switch (p.t) {
    case 'state':
      void connect()
      reply(popupState())
      return
    case 'pair':
      pendingCode = p.code.replace(/\D/g, '')
      error = null
      ws?.close()
      ws = null
      status = 'connecting'
      void connect()
      reply(popupState())
      return
    case 'unpair':
      void chrome.storage.local.remove('token')
      ws?.close()
      ws = null
      setStatus('unpaired', null)
      reply(popupState())
      return
    case 'control':
      send({ t: 'control', cmd: p.cmd })
      reply(popupState())
      return
  }
})

// For debugging from the service worker console: __cuelight()
;(globalThis as { __cuelight?: () => object }).__cuelight = () => ({ status, port, error, stageTab, target, pendingCode: !!pendingCode, ws: ws?.readyState ?? null })

chrome.alarms.create('cuelight-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
void connect()
