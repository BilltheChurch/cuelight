#!/usr/bin/env node
/**
 * Targets outside the browser, end to end and invisible: the app runs headless and plays a
 * storyboard whose steps point at Finder (an Accessibility element, then a spot in its window),
 * and the light has to land where the helper says those are right now. Read-only: nothing is
 * clicked, nothing captures the screen, no permission is asked for. Needs a Finder window open
 * and Accessibility already allowed for whatever runs this (it skips otherwise).
 *
 *   pnpm e2e:native [--lang zh] [--shots <dir>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Helper } from '../apps/desktop/src/main/helper.ts'
import { axLocatorFor, matchAx } from '../apps/desktop/src/main/native.ts'
import { DOM_HELPERS, arg, root, sleep, startApp } from './e2e-lib.mjs'

const lang = arg('--lang') ?? 'en'
const shots = arg('--shots')
execFileSync(process.execPath, [join(root, 'scripts/build-helper.mjs')], { stdio: 'inherit' })
execFileSync('pnpm', ['--filter', '@cuelight/desktop', 'build'], { cwd: root, stdio: 'ignore' })

const helper = new Helper([join(root, 'apps/helper-mac/build/cuelight-helper')])
const st = await helper.request('status')
if (!st.trusted) {
  console.log('SKIP: Accessibility is not allowed for the app this runs under')
  process.exit(0)
}
const APP = 'com.apple.finder'
const { nodes } = await helper.request('ax.tree', { app: APP }, 10_000)
const { windows } = await helper.request('windows', { app: APP })
const pickable = nodes.findIndex((n) => n.window === 0 && n.parent >= 0 && n.rect?.[2] > 20 && n.rect?.[3] > 10 && (n.identifier || n.title || n.value))
if (pickable < 0 || !windows.length) {
  console.log('SKIP: no Finder window open')
  process.exit(0)
}
const chain = []
for (let k = pickable; k >= 0; k = nodes[k].parent) chain.push(nodes[k])
const ax = axLocatorFor(APP, chain, nodes)
if (matchAx(ax, nodes) !== nodes[pickable]) throw new Error('the locator does not lead back to its element')
console.log('target:', nodes[pickable].role, JSON.stringify(ax))

const dir = mkdtempSync(join(tmpdir(), 'cuelight-e2e-native-'))
const file = join(dir, 'finder.json')
writeFileSync(
  file,
  JSON.stringify({
    cuelight: 1,
    title: 'Finder',
    steps: [
      { act: 'wait', secs: 2, say: 'An element in Finder.', target: [ax] },
      { act: 'wait', secs: 2, say: 'A spot in its window.', target: [{ kind: 'region', relativeTo: 'window', app: APP, rect: [20, 10, 120, 30] }] },
      { act: 'wait', secs: 1, say: 'Then nothing.', target: [{ kind: 'visual', image: 'missing.png' }] },
    ],
  }),
)

const a = startApp({ args: ['--open', file], stdin: true, lang, quiet: ['rect', 'inside'] })
let failed = 0
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}
const near = (x, y, tol = 1) => !!x && !!y && x.every((v, k) => Math.abs(v - y[k]) <= tol)
try {
  await a.waitEvent((e) => e.type === 'bridge', 20_000, 'bridge')
  await a.evalIn(DOM_HELPERS)
  const native = await a.evalIn('window.cuelight.getState().then((s) => s.native)')
  ok(native.available && native.trusted === true, 'the app sees the helper', JSON.stringify(native))

  await a.control('play')
  await a.waitEvent((e) => e.type === 'phase' && e.phase === 'preroll', 10_000, 'preroll')
  await a.control('next')
  const l1 = await a.waitEvent((e) => e.type === 'light' && e.from === 'local', 10_000, 'light on the element')
  const now1 = (await helper.request('ax.tree', { app: APP }, 10_000)).nodes
  const want1 = matchAx(ax, now1)?.rect
  ok(near(l1.rect, want1), 'light on the Accessibility element', `${JSON.stringify(l1.rect)} vs ${JSON.stringify(want1)}`)

  const l2 = await a.waitNext((e) => e.type === 'light' && e.from === 'local', 10_000, 'light in the window')
  const w = (await helper.request('windows', { app: APP })).windows[0].rect
  const want2 = [w[0] + 20, w[1] + 10, 120, 30]
  ok(near(l2.rect, want2), 'light on a spot in the window', `${JSON.stringify(l2.rect)} vs ${JSON.stringify(want2)}`)
  const step3 = await a.waitEvent((e) => e.type === 'step' && e.n === 3, 10_000, 'step 3')
  ok(!!step3, 'an image anchor (not supported yet) does not stop the run')
  await a.waitEvent((e) => e.type === 'phase' && e.phase === 'done', 10_000, 'done')
  ok(true, 'reached the end')

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await a.evalIn('window.cuelight.stop()')
    await sleep(300)
    await a.shot(join(shots, `native-${lang}-home.png`))
    await a.evalIn(`__t.click('.sl-item', 0)`)
    await sleep(300)
    await a.shot(join(shots, `native-${lang}-step.png`))
  }
} catch (e) {
  failed++
  console.log('FAIL', e.message)
} finally {
  await a.close()
  helper.stop()
}
console.log(failed ? `${failed} FAILED` : 'PASS')
process.exitCode = failed ? 1 : 0
