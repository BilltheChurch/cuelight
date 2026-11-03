// Shared pieces of the end-to-end checks: the app under test with a throwaway settings folder,
// a throwaway browser profile with the extension in it, pairing through the real popup, and
// Playwright equivalents of storyboard DOM locators.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
export const root = new URL('..', import.meta.url).pathname
const WebSocket = require(join(root, 'apps/desktop/node_modules/ws'))
export const ext = join(root, 'apps/extension/dist')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const arg = (k) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : undefined
}

/**
 * Starts the desktop app with --log and collects its event lines. Headless unless `headed`:
 * no windows, no Dock icon, no global hotkeys, the real cursor ignored. With `stdin`, the
 * control window still exists (never shown) and `evalIn` and `shot` drive it.
 */
export function startApp({ args = [], env = {}, headed = false, stdin = false, lang, quiet = ['rect'] } = {}) {
  const devToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const userData = mkdtempSync(join(tmpdir(), 'cuelight-e2e-app-'))
  if (lang) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ lang }))
  const proc = spawn(join(root, 'apps/desktop/node_modules/.bin/electron'), ['.', '--log', ...args], {
    cwd: join(root, 'apps/desktop'),
    env: {
      ...process.env,
      CUELIGHT_DEV_TOKEN: devToken,
      CUELIGHT_USER_DATA: userData,
      CUELIGHT_HEADLESS: headed ? '0' : '1',
      ...(stdin ? { CUELIGHT_DEV_STDIN: '1' } : {}),
      ...env,
    },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'inherit'],
  })
  const events = []
  const waiters = []
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    if (!l.startsWith('CUELIGHT ')) return
    const e = JSON.parse(l.slice(9))
    events.push(e)
    if (!quiet.includes(e.type)) console.log('  app:', JSON.stringify(e))
    for (const w of [...waiters]) if (w.test(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e))
  })
  const waitEvent = (test, ms = 30_000, what = 'event') =>
    new Promise((resolve, reject) => {
      const hit = events.find(test)
      if (hit) return resolve(hit)
      const w = { test, resolve }
      waiters.push(w)
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    })
  const waitNext = (test, ms, what) => {
    const from = events.length
    return waitEvent((e) => events.indexOf(e) >= from && test(e), ms, what)
  }

  // A scripted "browser" on the bridge with the dev token, for the popup's play/next controls.
  let ctl
  async function control(cmd) {
    if (!ctl) {
      const { port } = events.find((e) => e.type === 'bridge')
      ctl = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://cuelight-e2e' })
      await new Promise((r, j) => (ctl.once('open', r), ctl.once('error', j)))
      ctl.send(JSON.stringify({ t: 'hello', v: 1, token: devToken, browser: 'e2e', ext: '0' }))
      await new Promise((r) => ctl.once('message', r))
    }
    ctl.send(JSON.stringify({ t: 'control', cmd }))
  }

  let nextId = 1
  async function command(cmd, extra) {
    const id = nextId++
    const reply = waitEvent((e) => e.id === id, 15_000, `${cmd} #${id}`)
    proc.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n')
    const e = await reply
    if (!e.ok) throw new Error(`${cmd} failed: ${e.error}`)
    return e
  }

  return {
    proc,
    events,
    waitEvent,
    waitNext,
    control,
    /** Runs JavaScript in the control window and returns its (JSON-able) value */
    evalIn: (js) => command('eval', { js }).then((e) => e.value),
    /** Saves a PNG of the control window, rendered off screen */
    shot: (path) => command('shot', { path }),
    /** Quits the app, then deletes its settings folder once it has stopped writing there */
    async close() {
      ctl?.close()
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r))
      proc.kill()
      await Promise.race([exited, sleep(5000)])
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

/**
 * A browser in a throwaway profile with the extension loaded. CHROMIUM must be a build that still
 * honours --load-extension (Chromium or Chrome for Testing); CHROME is a branded Chrome or Edge,
 * which gets the extension through CDP instead (see launchBranded). E2E_PROXY=http://host:port
 * if the browser needs a proxy to reach the example site; loopback, and so the bridge, bypasses it.
 */
export async function launchBrowser({ headed = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cuelight-e2e-'))
  // A raw flag rather than Playwright's proxy option, which would also route loopback through it.
  const args = [
    '--window-position=80,90',
    '--window-size=1360,880',
    '--no-first-run',
    '--no-default-browser-check',
    // The translate bubble pops up over English pages in a non-English Chrome and covers the shots.
    '--disable-features=Translate',
    ...(process.env.E2E_PROXY ? [`--proxy-server=${process.env.E2E_PROXY}`] : []),
  ]
  let ctx
  if (process.env.CHROME) ctx = await launchBranded(process.env.CHROME, profile, headed, args)
  else
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM,
      headless: !headed,
      viewport: null,
      chromiumSandbox: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...args],
    })
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await ctx.waitForEvent('serviceworker'))
  const extId = new URL(sw.url()).host
  console.log('extension', extId)
  return {
    ctx,
    sw,
    extId,
    async close() {
      await ctx.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

/**
 * Branded Chrome and Edge ignore --load-extension since 137, but still install an unpacked
 * extension through CDP Extensions.loadUnpacked. That call only answers on the
 * --remote-debugging-pipe connection, which is the one Playwright launches with anyway.
 */
async function launchBranded(exe, profile, headed, args) {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: exe,
    headless: !headed,
    viewport: null,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', ...args],
  })
  const cdp = await ctx.browser().newBrowserCDPSession()
  const { product } = await cdp.send('Browser.getVersion')
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: ext })
  console.log(`loaded unpacked into ${product}:`, id)
  return ctx
}

/** Pair exactly like a person would: open the popup, type the code from the app. */
export async function pair(ctx, extId, code) {
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/popup.html`)
  await popup.waitForSelector('#status[data-state=unpaired]')
  await popup.fill('#code', code)
  await popup.click('#pair-btn')
  await popup.waitForSelector('#status[data-state=connected]', { timeout: 10_000 })
  console.log('paired')
  await popup.close()
}

export function esc(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function textArg(m) {
  if (typeof m === 'string') return { v: m, exact: false }
  if ('exact' in m) return { v: m.exact, exact: true }
  return { v: new RegExp(m.re, m.flags), exact: false }
}

/** Playwright equivalent of the subset of DOM locators the examples and the picker use. */
export function pw(page, l, scope = page) {
  if (!l) return null
  if (l.within) scope = pw(page, l.within, scope)
  let loc
  if (l.testId) loc = scope.getByTestId(l.testId)
  else if (l.css) loc = scope.locator(l.css)
  else if (l.role) {
    const nm = l.name && textArg(l.name)
    loc = scope.getByRole(l.role, nm ? { name: nm.v, exact: nm.exact } : {})
  } else {
    const t = textArg(l.text)
    loc = scope.getByText(t.v, { exact: t.exact })
  }
  if (l.text && (l.testId || l.css || l.role)) {
    const t = textArg(l.text)
    loc = loc.filter({ hasText: t.exact ? new RegExp(`^\\s*${esc(t.v)}\\s*$`) : t.v })
  }
  return loc.nth(l.nth ?? 0)
}

/** The browser window's frame in screen points, as the browser itself reports it. */
export async function windowBounds(page) {
  const cdp = await page.context().newCDPSession(page)
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId })
  await cdp.detach()
  return bounds
}
