// End-to-end check of the desktop app and the extension together, in a throwaway Chromium
// profile (never your daily browser). It pairs through the real popup, plays a bundled
// example storyboard, performs each step with trusted input, and fails unless the app walks
// every step to the end.
//
//   pnpm --filter @cuelight/desktop build && pnpm --filter @cuelight/extension build
//   CHROMIUM=/path/to/Chromium node scripts/e2e-web.mjs [todomvc|wikipedia-tour] [--zoom 1.25] [--lang en|zh] [--headed] [--shots <dir>]
//
// By default the run is invisible: a headless browser, and an app with no windows, no Dock icon
// and no global hotkeys that ignores the real cursor, so it can run while someone uses the machine.
// --headed shows the real browser window and overlay (needed for --shots, and to catch window
// insets such as Edge's, which a headless window does not have). The app always runs with a
// throwaway settings folder, so test pairings never pile up in your real one.
//
// CHROMIUM must be a build that still honours --load-extension (Chromium or Chrome for Testing).
// To test the browser people actually use, set CHROME instead to a branded Chrome or Edge binary,
// e.g. CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": it still runs in a
// fresh throwaway profile, and the extension goes in through CDP (see launchBranded).
// Set E2E_PROXY=http://host:port if the browser needs a proxy to reach the example site;
// loopback, and so the app bridge, always bypasses it.
//
// --shots leaves the overlay capturable (debug badge on), raises the test window and saves a grab
// of it per step, so you can check by eye that the spotlight sits on the element. With --docs the
// badge stays off (README screenshots); with --recorded the overlay stays protected, so the grabs
// show what a screen recorder gets.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url).pathname
const WebSocket = require(join(root, 'apps/desktop/node_modules/ws'))
const arg = (k) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : undefined
}
const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'todomvc'
const zoom = Number(arg('--zoom') ?? 1)
const shots = arg('--shots')
const shotMode = process.argv.includes('--recorded') ? 'recorded' : process.argv.includes('--docs') ? 'docs' : 'debug'
const headed = process.argv.includes('--headed') || !!shots
const file = join(root, 'examples', `${name}.json`)
const sb = JSON.parse(readFileSync(file, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const devToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
const userData = mkdtempSync(join(tmpdir(), 'cuelight-e2e-app-'))
if (arg('--lang')) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ lang: arg('--lang') }))

// ---------------------------------------------------------------- app
const events = []
const waiters = []
const app = spawn(join(root, 'apps/desktop/node_modules/.bin/electron'), ['.', '--log', '--open', file], {
  cwd: join(root, 'apps/desktop'),
  env: { ...process.env, CUELIGHT_DEV_TOKEN: devToken, CUELIGHT_USER_DATA: userData, CUELIGHT_HEADLESS: headed ? '0' : '1', CUELIGHT_CAPTURABLE: !shots || shotMode === 'recorded' ? '0' : shotMode === 'docs' ? 'docs' : '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
readline.createInterface({ input: app.stdout }).on('line', (l) => {
  if (!l.startsWith('CUELIGHT ')) return
  const e = JSON.parse(l.slice(9))
  events.push(e)
  if (e.type !== 'rect') console.log('  app:', JSON.stringify(e))
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

// ---------------------------------------------------------------- browser
const ext = join(root, 'apps/extension/dist')
const profile = mkdtempSync(join(tmpdir(), 'cuelight-e2e-'))
// A raw flag rather than Playwright's proxy option, which would also route loopback through it.
const browserArgs = [
  '--window-position=80,90',
  '--window-size=1360,880',
  '--no-first-run',
  '--no-default-browser-check',
  // The translate bubble pops up over English pages in a non-English Chrome and covers the shots.
  '--disable-features=Translate',
  ...(process.env.E2E_PROXY ? [`--proxy-server=${process.env.E2E_PROXY}`] : []),
]
let ctx
let viewOrigin = null
let closeBrowser = async () => {}
const failures = []
try {
  const bridge = await waitEvent((e) => e.type === 'bridge', 20_000, 'app bridge')
  if (process.env.CHROME) {
    const b = await launchBranded(process.env.CHROME)
    ctx = b.ctx
    closeBrowser = b.close
  } else {
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM,
      headless: !headed,
      viewport: null,
      chromiumSandbox: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...browserArgs],
    })
    closeBrowser = () => ctx.close()
  }
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await ctx.waitForEvent('serviceworker'))
  const extId = new URL(sw.url()).host
  console.log('extension', extId)

  // Pair exactly like a person would: open the popup, type the code from the app.
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/popup.html`)
  await popup.waitForSelector('#status[data-state=unpaired]')
  await popup.fill('#code', bridge.code)
  await popup.click('#pair-btn')
  await popup.waitForSelector('#status[data-state=connected]', { timeout: 10_000 })
  console.log('paired')
  await popup.close()

  const page = ctx.pages()[0]
  await page.bringToFront()
  if (sb.start?.url) await page.goto(sb.start.url, { waitUntil: 'domcontentloaded' })
  if (zoom !== 1)
    await sw.evaluate(async (z) => {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      await chrome.tabs.setZoom(t.id, z)
    }, zoom)
  // Once the content script is in (document_idle), this first mouse move also stands in for the
  // presenter's: it is what lets the extension learn insets such as Edge's (see Correction).
  await page.waitForLoadState('load').catch(() => {})
  await sleep(300)
  viewOrigin = await probeOrigin(page)

  await control('play')
  await waitEvent((e) => e.type === 'phase' && e.phase === 'preroll', 10_000, 'preroll')
  await sleep(500)
  await control('next')

  for (let i = 0; i < sb.steps.length; i++) {
    const st = sb.steps[i]
    const n = i + 1
    const entered = await waitEvent((e) => e.type === 'step' && e.n === n, 20_000, `step ${n}`)
    const seq = entered.seq
    const loc = st.target && pw(page, st.target.find((l) => l.kind === 'dom' && (!l.url || new RegExp('^' + l.url.split('*').map(esc).join('.*') + '$').test(page.url()))))
    let rect = null
    if (loc) {
      rect = await waitEvent((e) => e.type === 'rect' && e.seq === seq && e.found, 15_000, `step ${n} spotlight`).catch(() => null)
      if (!rect && !st.optional) {
        const last = events.findLast((e) => e.type === 'rect' && e.seq === seq)
        const ext = await sw
          .evaluate(async () => ({
            bg: globalThis.__cuelight?.(),
            tabs: (await chrome.tabs.query({})).map((t) => ({ id: t.id, active: t.active, status: t.status, url: t.url })),
          }))
          .catch((e) => String(e))
        failures.push(`step ${n}: spotlight never found the element (page ${page.url()}, last report ${JSON.stringify(last ?? null)}, extension ${JSON.stringify(ext)})`)
      }
      if (rect) {
        // Off-screen targets show a strip first; scroll like a presenter would.
        if (rect.offscreen) {
          console.log(`step ${n} target is off-screen (${rect.offscreen}), light shows an edge strip at`, rect.rect, '; scrolling')
          await loc.scrollIntoViewIfNeeded()
          rect = await waitEvent((e) => e.type === 'rect' && e.seq === seq && e.found && !e.offscreen, 10_000, `step ${n} on screen`)
        }
        const { latest, truth } = await settled(page, loc, seq)
        rect = latest
        const err = Math.max(...rect.rect.map((v, k) => Math.abs(v - truth[k])))
        console.log(`step ${n} ${st.act} rect`, rect.rect, 'expected', truth.map((v) => Math.round(v * 2) / 2), `max err ${err.toFixed(1)}pt`)
        if (err > 3) {
          const state = await sw
            .evaluate(async () => {
              const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
              return { tabZoom: await chrome.tabs.getZoom(t.id), content: await chrome.tabs.sendMessage(t.id, { t: 'debug' }) }
            })
            .catch((e) => String(e))
          failures.push(`step ${n}: spotlight off by ${err.toFixed(1)}pt (extension ${JSON.stringify(state)})`)
        }
      }
    }
    if (shots && rect) {
      // Raise the test window and grab only its bounds, not the rest of the desktop.
      mkdirSync(shots, { recursive: true })
      await page.bringToFront()
      await sleep(450)
      const b = await windowBounds(page)
      const region = [b.left, b.top, b.width, b.height].join(',')
      execFileSync('/usr/sbin/screencapture', ['-x', '-R', region, join(shots, `${name}-z${zoom}-${shotMode}-${String(n).padStart(2, '0')}.png`)])
    }
    const next = waitNext((e) => e.type === 'advance' || (e.type === 'phase' && e.phase === 'done'), 60_000, `step ${n} to finish`)
    if (st.act === 'click' && loc && rect) await loc.click()
    // Read steps only need the cursor inside the light; skip the hit-test, since a neighbour
    // (TodoMVC's filter bar over the counter) may sit on top of the element's centre.
    else if (st.act === 'read' && loc && rect) {
      await loc.hover({ force: true })
      // A real mouse passing over the test window also moves the page pointer; put it back.
      for (let settledRead = false; !settledRead; ) {
        settledRead = await Promise.race([next.then(() => true), sleep(700).then(() => false)])
        if (!settledRead && events.findLast((e) => e.type === 'inside')?.inside === false) await loc.hover({ force: true }).catch(() => {})
      }
    }
    else if (st.act === 'wait') {
      const text = /“(.+?)”/.exec(st.how ?? '')?.[1]
      if (text) {
        await page.keyboard.type(text, { delay: 30 })
        await page.keyboard.press('Enter')
      }
    } else if (st.act === 'manual') await control('next')
    else if (st.optional && !rect) {
      // optional step whose target is absent: the app skips it on its own
    }
    const done = await next
    console.log(`step ${n} done:`, done.reason ?? done.phase)
  }
  await waitEvent((e) => e.type === 'phase' && e.phase === 'done', 10_000, 'done card')
  await control('next')
  await waitEvent((e) => e.type === 'phase' && e.phase === 'idle', 5_000, 'idle')
} catch (e) {
  failures.push(String(e.message ?? e))
} finally {
  ctl?.close()
  await closeBrowser().catch(() => {})
  app.kill()
  rmSync(profile, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}

if (failures.length) {
  console.error('\nFAIL\n' + failures.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log(`\nPASS ${name} (zoom ${zoom}, ${headed ? 'headed' : 'headless'}): ${sb.steps.length} steps`)

// ---------------------------------------------------------------- helpers

function esc(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function textArg(m) {
  if (typeof m === 'string') return { v: m, exact: false }
  if ('exact' in m) return { v: m.exact, exact: true }
  return { v: new RegExp(m.re, m.flags), exact: false }
}

/** Playwright equivalent of the subset of DOM locators the examples use. */
function pw(page, l, scope = page) {
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

/**
 * Where the element really is on screen: the viewport origin Chromium itself uses (see
 * probeOrigin), or failing that the window frame from CDP with the viewport at its bottom,
 * plus the element box scaled by page zoom.
 */
async function groundTruth(page, loc) {
  const box = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight }
  })
  let o = viewOrigin
  if (!o) {
    const b = await windowBounds(page)
    o = { x: b.left, y: b.top + b.height - box.ih * zoom }
  }
  const x1 = Math.max(0, box.x), y1 = Math.max(0, box.y)
  const x2 = Math.min(box.iw, box.x + box.w), y2 = Math.min(box.ih, box.y + box.h)
  return [o.x + x1 * zoom, o.y + y1 * zoom, (x2 - x1) * zoom, (y2 - y1) * zoom]
}

/**
 * The viewport origin on screen as Chromium places it: the screen position it gives a
 * synthetic mouse event, minus the event's page position. Window bounds alone miss content
 * insets (branded Edge draws its page a few points inside the window frame). Also logs how far
 * this is from the window-edge model, which is what the extension assumes until it sees a mouse move.
 */
async function probeOrigin(page) {
  const got = page.evaluate(
    () => new Promise((r) => addEventListener('mousemove', (e) => r({ sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY }), { once: true, capture: true })),
  )
  await sleep(150)
  await page.mouse.move(40, 40)
  const e = await got
  const o = { x: e.sx - e.cx * zoom, y: e.sy - e.cy * zoom }
  const b = await windowBounds(page)
  const ih = await page.evaluate(() => innerHeight)
  const edge = { x: b.left, y: b.top + b.height - ih * zoom }
  console.log('viewport origin', o, 'window-edge model', edge, 'difference', { x: o.x - edge.x, y: o.y - edge.y })
  return o
}

/**
 * Compare like with like: wait until the page has loaded and the element has stopped moving
 * (two measurements 400ms apart agree), then take the extension's latest report for this step.
 */
async function settled(page, loc, seq) {
  await page.waitForLoadState('load').catch(() => {})
  let truth = await groundTruth(page, loc)
  for (let k = 0; k < 15; k++) {
    await sleep(400)
    const again = await groundTruth(page, loc)
    const still = again.every((v, i) => Math.abs(v - truth[i]) < 0.5)
    truth = again
    if (still) break
  }
  const latest = events.findLast((e) => e.type === 'rect' && e.seq === seq && e.found && e.rect)
  return { latest, truth }
}

/**
 * Branded Chrome and Edge ignore --load-extension since 137, but still install an unpacked
 * extension through CDP Extensions.loadUnpacked. That call only answers on the
 * --remote-debugging-pipe connection, which is the one Playwright launches with anyway.
 */
async function launchBranded(exe) {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: exe,
    headless: !headed,
    viewport: null,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', ...browserArgs],
  })
  const cdp = await ctx.browser().newBrowserCDPSession()
  const { product } = await cdp.send('Browser.getVersion')
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: ext })
  console.log(`loaded unpacked into ${product}:`, id)
  return { ctx, close: () => ctx.close() }
}

/** The browser window's frame in screen points, as the browser itself reports it. */
async function windowBounds(page) {
  const cdp = await page.context().newCDPSession(page)
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId })
  await cdp.detach()
  return bounds
}
