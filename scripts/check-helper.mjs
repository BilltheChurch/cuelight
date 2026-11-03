#!/usr/bin/env node
/**
 * Checks the macOS helper against this Mac, without asking for any permission, taking any
 * input or capturing the screen:
 *
 *   status    reads what the system allows (no prompt)
 *   windows   lists on-screen windows
 *   OCR       reads apps/helper-mac/ocr-sample.png, English and Chinese, and finds part of a line
 *   AX        only if Accessibility is already allowed: walks Finder's windows, makes a locator
 *             for some elements the way the picker does, and checks it leads back to them;
 *             polls one element's frame and hit-tests its middle
 *
 * It never turns on click watching or picking, which would see the real mouse. Run with
 * `pnpm check:helper` (builds the helper first).
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Helper } from '../apps/desktop/src/main/helper.ts'
import { axLocatorFor, matchAx, matchOcr } from '../apps/desktop/src/main/native.ts'

const root = new URL('..', import.meta.url).pathname
execFileSync(process.execPath, [join(root, 'scripts/build-helper.mjs')], { stdio: 'inherit' })

const helper = new Helper([join(root, 'apps/helper-mac/build/cuelight-helper')])
let failed = 0
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}
const near = (a, b, tol) => a.every((v, k) => Math.abs(v - b[k]) <= tol)

const st = await helper.request('status')
ok(typeof st.trusted === 'boolean' && typeof st.screen === 'boolean', 'status', `accessibility=${st.trusted} screen-recording=${st.screen} v${st.version}`)

const { windows } = await helper.request('windows')
ok(Array.isArray(windows) && windows.every((w) => w.rect.length === 4 && typeof w.app === 'string'), 'windows', `${windows.length} on screen`)

// The sample was drawn at 1x: "Export as PDF" at (40, 40), "Save draft" at (40, 150),
// "新建备忘录" at (480, 150), 30 pt type.
const sample = join(root, 'apps/helper-mac/ocr-sample.png')
const t0 = performance.now()
// The first run after a restart loads the text models, which took 15 s or more here once.
const { lines } = await helper.request('ocr.file', { path: sample, find: 'pdf' }, 60_000)
const ms = Math.round(performance.now() - t0)
const texts = lines.map((l) => l.text)
ok(['Export as PDF', 'Save draft', '新建备忘录'].every((t) => texts.includes(t)), 'OCR reads English and Chinese', `${JSON.stringify(texts)} in ${ms} ms`)
const pdf = matchOcr({ kind: 'visual', text: 'pdf' }, lines)
ok(!!pdf && pdf[0] > 150 && pdf[0] < 200 && near([pdf[1]], [42], 8), 'OCR finds part of a line', JSON.stringify(pdf?.map(Math.round)))
const zh = matchOcr({ kind: 'visual', text: { exact: '新建备忘录' }, box: [-10, -6, 170, 50] }, lines)
ok(!!zh && near(zh, [470, 148, 170, 50], 10), 'OCR anchor with a box', JSON.stringify(zh?.map(Math.round)))

if (!st.trusted) console.log('skip AX: Accessibility is not allowed for the app this runs under')
else {
  const app = 'com.apple.finder'
  const { nodes, truncated } = await helper.request('ax.tree', { app }, 10_000)
  ok(Array.isArray(nodes), 'AX tree', `${nodes.length} elements${truncated ? ' (truncated)' : ''}`)
  const chainOf = (i) => {
    const out = []
    for (let k = i; k >= 0; k = nodes[k].parent) out.push(nodes[k])
    return out
  }
  const usable = nodes.map((n, i) => [n, i]).filter(([n]) => n.parent >= 0 && n.rect && n.rect[2] > 4 && n.rect[3] > 4)
  if (!usable.length) console.log('skip AX round trip: no Finder window open')
  let back = 0
  for (const [n, i] of usable.slice(0, 40)) {
    const loc = axLocatorFor(app, chainOf(i), nodes)
    if (loc && matchAx(loc, nodes) === n) back++
    else console.log('  no way back to', n.role, JSON.stringify(loc))
  }
  if (usable.length) ok(back === Math.min(40, usable.length), 'AX locators lead back to their element', `${back} of ${Math.min(40, usable.length)}`)
  const [first] = usable[0] ?? []
  if (first) {
    const f = await helper.request('ax.frame', { ref: first.ref })
    ok(near(f.rect, first.rect, 1), 'AX frame by handle', `${first.role} ${JSON.stringify(f.rect)}`)
    const mid = { x: first.rect[0] + first.rect[2] / 2, y: first.rect[1] + first.rect[3] / 2 }
    const hit = await helper.request('ax.hit', mid)
    ok(Array.isArray(hit.chain) && hit.chain.length > 0, 'AX hit test', `${hit.app} ${hit.chain[0]?.role} (${hit.chain.length} up to the window)`)
  }
}

const bad = await helper.request('nope').catch((e) => e.code)
ok(bad === 'unknown command', 'unknown commands fail cleanly')
helper.stop()
console.log(failed ? `${failed} FAILED` : 'PASS')
process.exitCode = failed ? 1 : 0
