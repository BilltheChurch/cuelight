/**
 * Local bridge to the browser extension: a WebSocket server on 127.0.0.1 only.
 *
 * Who may connect: the Origin must be a browser extension (web pages cannot fake that), and
 * the first message must carry either a saved token or the 6-digit pairing code shown in
 * the app. Five wrong codes in a row replace the code. Tokens are 32 random bytes.
 */
import { EventEmitter } from 'node:events'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { BRIDGE_PORTS, PROTOCOL_VERSION, type AppMessage, type ExtMessage } from '@cuelight/schema'
import type { BrowserInfo } from '../shared/types.ts'

export type PairedBrowser = { id: string; token: string; browser: string; createdAt: string; lastSeen?: string }

export type BridgeStore = {
  browsers(): PairedBrowser[]
  save(browsers: PairedBrowser[]): void
}

type Client = { ws: WebSocket; id: string | null; browser: string; focusedAt: number }

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[\w.-]+$/
const HELLO_TIMEOUT_MS = 5000
const MAX_FAILURES = 5

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class Bridge extends EventEmitter<{ message: [ExtMessage]; change: []; authed: [] }> {
  port: number | null = null
  code = newCode()
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private failures = 0

  constructor(
    private store: BridgeStore,
    private appName: string,
    /** Development only: an extra token accepted without pairing (for scripted tests) */
    private devToken?: string,
  ) {
    super()
  }

  async start(): Promise<number> {
    for (const port of BRIDGE_PORTS) {
      const ok = await new Promise<boolean>((resolve) => {
        const wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          maxPayload: 64 * 1024,
          verifyClient: ({ origin }: { origin?: string }) => !!origin && EXTENSION_ORIGIN.test(origin),
        })
        wss.once('listening', () => {
          this.wss = wss
          resolve(true)
        })
        wss.once('error', () => {
          wss.close()
          resolve(false)
        })
      })
      if (ok) {
        this.port = port
        this.wss!.on('connection', (ws) => this.accept(ws))
        this.wss!.on('error', (e) => console.error('[bridge]', e))
        return port
      }
    }
    throw new Error(`no free port in ${BRIDGE_PORTS.join(', ')}`)
  }

  stop() {
    for (const c of this.clients) c.ws.close()
    this.wss?.close()
  }

  /** The browser the presenter used last: its messages drive the spotlight. */
  private get active(): Client | null {
    let best: Client | null = null
    for (const c of this.clients) if (c.id && (!best || c.focusedAt > best.focusedAt)) best = c
    return best
  }

  connected() {
    return this.active !== null
  }

  send(m: AppMessage) {
    const data = JSON.stringify(m)
    for (const c of this.clients) if (c.id) c.ws.send(data)
  }

  newCode() {
    this.code = newCode()
    this.failures = 0
    this.emit('change')
  }

  forget(id: string) {
    this.store.save(this.store.browsers().filter((b) => b.id !== id))
    for (const c of this.clients) if (c.id === id) c.ws.close()
    this.emit('change')
  }

  browsers(): BrowserInfo[] {
    const active = this.active
    return this.store.browsers().map((b) => {
      const live = [...this.clients].find((c) => c.id === b.id)
      return { id: b.id, browser: live?.browser ?? b.browser, connected: !!live, active: !!live && live === active, lastSeen: b.lastSeen ?? null }
    })
  }

  private accept(ws: WebSocket) {
    const c: Client = { ws, id: null, browser: '', focusedAt: Date.now() }
    this.clients.add(c)
    const timer = setTimeout(() => !c.id && ws.close(), HELLO_TIMEOUT_MS)
    ws.on('message', (raw) => {
      let m: ExtMessage
      try {
        m = JSON.parse(String(raw)) as ExtMessage
      } catch {
        return
      }
      if (!c.id) return this.hello(c, m)
      if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' } satisfies AppMessage))
      if (m.t === 'focus') {
        if (m.focused) c.focusedAt = Date.now()
        this.emit('change')
        return
      }
      // Only the active browser drives the spotlight; hotkey-style controls, picks and recordings come from any.
      if (c === this.active || m.t === 'control' || m.t === 'picked' || m.t === 'pick-end' || m.t === 'rec') this.emit('message', m)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      this.clients.delete(c)
      if (c.id) this.emit('change')
    })
    ws.on('error', () => ws.close())
  }

  private hello(c: Client, m: ExtMessage) {
    const reply = (r: AppMessage) => c.ws.send(JSON.stringify(r))
    if (m.t !== 'hello') return c.ws.close()
    if (m.v !== PROTOCOL_VERSION) {
      reply({ t: 'denied', reason: 'version' })
      return c.ws.close()
    }
    const browsers = this.store.browsers()
    let entry: PairedBrowser | undefined
    let issued: string | undefined
    if (m.token) {
      entry = browsers.find((b) => same(b.token, m.token!))
      if (!entry && this.devToken && same(this.devToken, m.token)) entry = { id: 'dev', token: m.token, browser: m.browser, createdAt: new Date().toISOString() }
      if (!entry) {
        reply({ t: 'denied', reason: 'bad-token' })
        return c.ws.close()
      }
    } else if (m.code) {
      if (!same(m.code, this.code)) {
        this.failures++
        const locked = this.failures >= MAX_FAILURES
        if (locked) this.newCode()
        reply({ t: 'denied', reason: locked ? 'locked' : 'bad-code' })
        return c.ws.close()
      }
      issued = randomBytes(32).toString('hex')
      entry = { id: randomBytes(6).toString('hex'), token: issued, browser: m.browser, createdAt: new Date().toISOString() }
      browsers.push(entry)
      this.newCode()
    } else {
      reply({ t: 'denied', reason: 'bad-token' })
      return c.ws.close()
    }
    entry.lastSeen = new Date().toISOString()
    entry.browser = m.browser
    if (entry.id !== 'dev') this.store.save(browsers)
    c.id = entry.id
    c.browser = m.browser
    // A scripted dev client never takes the spotlight away from a real browser.
    c.focusedAt = entry.id === 'dev' ? 0 : Date.now()
    reply({ t: 'welcome', v: PROTOCOL_VERSION, token: issued, app: this.appName })
    this.emit('change')
    this.emit('authed')
  }
}
