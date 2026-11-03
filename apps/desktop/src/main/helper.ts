/**
 * The macOS helper (apps/helper-mac) as a child process: requests and replies as JSON lines on
 * its stdin and stdout, plus what it sends unasked (clicks, picks). Started on first use, and
 * again after it dies, but not more than once every few seconds. No Electron imports, so it runs
 * under unit tests with a stand-in helper.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'

export type HelperEvent =
  | { ev: 'ready'; version: string }
  | { ev: 'click'; x: number; y: number }
  | { ev: 'pick'; x: number; y: number }
  | { ev: 'pick-cancel' }
  /** Not from the helper: it went away, and anything it was asked to keep doing stopped */
  | { ev: 'exit' }

/** `code` is the helper's own error ('not-trusted', 'gone', ...), or 'unavailable' or 'timeout'. */
export class HelperError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`helper: ${code}`)
    this.code = code
  }
}

export type HelperLike = {
  request<T = Record<string, unknown>>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

type Waiting = { resolve: (v: never) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const RESPAWN_MS = 3000

export class Helper implements HelperLike {
  private proc: ChildProcess | null = null
  private nextId = 1
  private waiting = new Map<number, Waiting>()
  private diedAt = -Infinity
  /** The binary could not be started at all: no point trying again */
  private broken = false
  private listeners: ((e: HelperEvent) => void)[] = []
  private command: string[]
  private now: () => number

  // Plain fields rather than parameter properties, so scripts can load this file with Node's own
  // TypeScript support (scripts/check-helper.mjs).
  constructor(command: string[], now: () => number = () => performance.now()) {
    this.command = command
    this.now = now
  }

  onEvent(fn: (e: HelperEvent) => void) {
    this.listeners.push(fn)
  }

  get usable() {
    return !this.broken
  }

  request<T = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const p = this.start()
    if (!p?.stdin?.writable) return Promise.reject(new HelperError('unavailable'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new HelperError('timeout'))
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject, timer })
      p.stdin!.write(JSON.stringify({ ...args, id, cmd }) + '\n')
    })
  }

  stop() {
    const p = this.proc
    if (!p) return
    p.stdin?.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n')
    p.stdin?.end()
    // It exits on its own when its stdin closes; this is in case it hangs.
    setTimeout(() => p.exitCode === null && p.kill(), 1000).unref()
  }

  private start(): ChildProcess | null {
    if (this.proc) return this.proc
    if (this.broken || this.now() - this.diedAt < RESPAWN_MS) return null
    const [bin, ...args] = this.command
    let p: ChildProcess
    try {
      p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    } catch {
      this.broken = true
      return null
    }
    this.proc = p
    p.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'EACCES') this.broken = true
      this.died(p)
    })
    p.on('exit', () => this.died(p))
    p.stdin?.on('error', () => {})
    readline.createInterface({ input: p.stdout! }).on('line', (line) => this.line(line))
    return p
  }

  private died(p: ChildProcess) {
    if (this.proc !== p) return
    this.proc = null
    this.diedAt = this.now()
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer)
      w.reject(new HelperError('unavailable'))
    }
    this.waiting.clear()
    this.emit({ ev: 'exit' })
  }

  private line(line: string) {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (typeof m.ev === 'string') return this.emit(m as HelperEvent)
    const w = typeof m.id === 'number' ? this.waiting.get(m.id) : undefined
    if (!w) return
    this.waiting.delete(m.id as number)
    clearTimeout(w.timer)
    if (m.ok === false) w.reject(new HelperError(String(m.error ?? 'failed')))
    else w.resolve(m as never)
  }

  private emit(e: HelperEvent) {
    for (const fn of this.listeners) fn(e)
  }
}
