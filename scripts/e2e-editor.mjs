// End-to-end check of the editor, as invisible as e2e-web.mjs: the app runs headless with its
// control window hidden and driven over stdin, and a headless browser with the extension supplies
// the picks. On a copy of the TodoMVC storyboard it cancels a pick with Esc, picks a new target for
// one step by clicking in the page (the page must not see that click), edits a line, undoes and
// redoes, reorders by drag and drop, saves, and rehearses the step it picked for. Then it records a
// run in the page into a draft, rehearses a recorded step, records one more step into the open
// draft, and starts a new storyboard.
//
//   pnpm --filter @cuelight/desktop build && pnpm --filter @cuelight/extension build
//   node scripts/e2e-editor.mjs [--lang en|zh] [--shots <dir>]
//
// CHROMIUM, CHROME and E2E_PROXY work as in e2e-web.mjs. --shots saves pictures of the editor,
// rendered off screen, and of the page while picking, so they can be checked by eye; nothing is
// ever shown on the screen.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_HELPERS, arg, launchBrowser, pair, pw, root, sleep, startApp } from './e2e-lib.mjs'

const lang = arg('--lang') ?? 'en'
const shots = arg('--shots')
const work = mkdtempSync(join(tmpdir(), 'cuelight-e2e-editor-'))
const board = join(work, 'todomvc.json')
copyFileSync(join(root, 'examples', 'todomvc.json'), board)
const sb = JSON.parse(readFileSync(board, 'utf8'))
const PICK_STEP = 4 // "Tick it off when it is done." (0-based)

const app = startApp({ args: ['--open', board], stdin: true, lang, quiet: ['rect', 'eval'] })
const { waitEvent, waitNext, evalIn } = app
const failures = []
const check = (ok, what) => {
  console.log((ok ? 'ok    ' : 'FAIL  ') + what)
  if (!ok) failures.push(what)
}
/** Re-run some JavaScript in the editor until its value passes `test` */
async function until(js, test, what, ms = 8000) {
  const end = Date.now() + ms
  let v
  while (Date.now() < end) {
    v = await evalIn(js).catch((e) => String(e))
    if (test(v)) return v
    await sleep(120)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(v)})`)
}
const shot = async (n) => shots && (mkdirSync(shots, { recursive: true }), await app.shot(join(shots, `editor-${lang}-${n}.png`)))

let browser
try {
  const bridge = await waitEvent((e) => e.type === 'bridge', 20_000, 'app bridge')
  browser = await launchBrowser()
  await pair(browser.ctx, browser.extId, bridge.code)
  const page = browser.ctx.pages()[0]
  await page.bringToFront()
  await page.goto(sb.start.url, { waitUntil: 'domcontentloaded' })
  for (const todo of ['Write the storyboard', 'Rehearse the demo']) {
    await page.locator('.new-todo').fill(todo)
    await page.keyboard.press('Enter')
  }
  const toggle = page.locator('li', { hasText: 'Write the storyboard' }).locator('.toggle')

  await evalIn(DOM_HELPERS)
  await until(`__t.qa('.sl-item').length`, (n) => n === sb.steps.length, 'the step list')
  check(true, `editor lists all ${sb.steps.length} steps`)
  await until(`__t.text('.dot.on').length`, (n) => n > 0, 'the browser to show as connected')

  // ---------------------------------------------------------------- pick: cancel, then for real
  await evalIn(`__t.click('.sl-item', ${PICK_STEP})`)
  await until(`document.querySelector('.detail-head h2')?.textContent`, (v) => /5/.test(v), 'step 5 selected')
  await evalIn(`__t.click('.pick-btn')`)
  await until(`!!document.querySelector('.picking')`, Boolean, 'picking banner')
  await page.waitForSelector('cuelight-picker', { state: 'attached', timeout: 8000 })
  const cancelled = waitNext((e) => e.type === 'web' && e.m.t === 'pick-end', 8000, 'Esc to cancel the pick')
  await page.keyboard.press('Escape')
  await cancelled
  await until(`!document.querySelector('.picking')`, Boolean, 'banner gone after Esc')
  check((await page.locator('cuelight-picker').count()) === 0, 'Esc cancels the pick and removes the picker from the page')

  await evalIn(`__t.click('.pick-btn')`)
  await page.waitForSelector('cuelight-picker', { state: 'attached', timeout: 8000 })
  const box = await toggle.boundingBox()
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await sleep(250)
  if (shots) await page.screenshot({ path: join(shots, `editor-${lang}-0-picking-page.png`) })
  const picked = waitNext((e) => e.type === 'web' && e.m.t === 'picked', 8000, 'the pick')
  await page.mouse.down()
  await page.mouse.up()
  const pick = (await picked).m.pick
  console.log('picked', JSON.stringify(pick))
  await sleep(300)
  check(!(await toggle.isChecked()), 'the page never saw the picking click (checkbox still unticked)')
  check((await page.locator('cuelight-picker').count()) === 0, 'the picker closes after a pick')
  check(pick.locators.length >= 2, `suggested ${pick.locators.length} locators`)
  for (const l of pick.locators) {
    const same = await pw(page, l)
      .evaluate((el) => el.classList.contains('toggle') && el.closest('li').textContent.includes('Write the storyboard'))
      .catch(() => false)
    check(same, `locator resolves to the picked checkbox: ${JSON.stringify(l)}`)
  }
  check(pick.locators[0].role === 'checkbox' && !!pick.locators[0].within, 'first suggestion is the checkbox scoped to its list item')
  await until(`__t.qa('.locator').length`, (n) => n === pick.locators.length, 'the new target in the editor')
  const sums = await evalIn(`__t.text('.loc-sum')`)
  check(sums[0].includes('checkbox'), `editor shows the pick: ${sums[0]}`)
  await shot('1-picked')

  // ---------------------------------------------------------------- edit, undo, redo
  const before = await evalIn(`document.querySelector('textarea.say').value`)
  await evalIn(`__t.type('textarea.say', 'Tick off the first one.')`)
  await until(`__t.text('.sl-item .text .muted')[${PICK_STEP}]`, (v) => v === 'Tick off the first one.', 'the list to show the new line')
  await evalIn(`__t.key('z', { metaKey: true })`)
  check((await until(`document.querySelector('textarea.say').value`, (v) => v === before, 'undo')) === before, 'undo brings the old line back')
  await evalIn(`__t.key('z', { metaKey: true, shiftKey: true })`)
  await until(`document.querySelector('textarea.say').value`, (v) => v === 'Tick off the first one.', 'redo')
  check(true, 'redo puts the new line back')
  check(await evalIn(`!!document.querySelector('.chip.warn')`), 'shows unsaved changes')

  // ---------------------------------------------------------------- drag and drop
  const says = await evalIn(`__t.text('.sl-item .text .muted')`)
  await evalIn(`(async () => {
    const items = __t.qa('.sl-item')
    const dt = new DataTransfer()
    const tick = () => new Promise((r) => setTimeout(r, 60))
    items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    await tick()
    const r = items[2].getBoundingClientRect()
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.bottom - 4 }
    items[2].dispatchEvent(new DragEvent('dragover', at))
    await tick()
    items[2].dispatchEvent(new DragEvent('drop', at))
    items[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await tick()
    return true
  })()`)
  const moved = await until(`__t.text('.sl-item .text .muted')`, (v) => v[1] === says[2], 'the drop')
  check(moved[2] === says[1], 'dragging step 2 below step 3 swaps them')
  await evalIn(`__t.key('z', { metaKey: true })`)
  await until(`__t.text('.sl-item .text .muted')`, (v) => v[1] === says[1], 'undo of the move')
  check(true, 'undo puts the step back')
  await evalIn(`__t.click('.sl-item', ${PICK_STEP})`)

  // ---------------------------------------------------------------- save
  await evalIn(`__t.click('.toolbar .secondary', 0)`)
  await until(`!!document.querySelector('.chip.ok')`, Boolean, 'the saved chip')
  const saved = JSON.parse(readFileSync(board, 'utf8'))
  check(JSON.stringify(saved.steps[PICK_STEP].target) === JSON.stringify(pick.locators), 'the saved file has the picked target')
  check(saved.steps[PICK_STEP].say === 'Tick off the first one.', 'the saved file has the new line')
  check(saved.steps.length === sb.steps.length && saved.steps[1].say === sb.steps[1].say, 'the saved file keeps the step order')
  check(Object.keys(saved.steps[1]).join() === Object.keys(sb.steps[1]).join(), 'untouched steps keep their key order')

  // ---------------------------------------------------------------- rehearse the picked step
  const started = waitNext((e) => e.type === 'step' && e.n === PICK_STEP + 1, 10_000, 'the rehearsal to start')
  await evalIn(`__t.click('.detail-head .secondary', 0)`)
  const entered = await started
  await waitEvent((e) => e.type === 'rect' && e.seq === entered.seq && e.found, 10_000, 'the spotlight on the picked checkbox')
  await sleep(300)
  const ended = waitNext((e) => e.type === 'rehearsed', 10_000, 'the rehearsal to end')
  const idle = waitNext((e) => e.type === 'phase' && e.phase === 'idle', 10_000, 'idle after the rehearsal')
  await toggle.click()
  const done = await ended
  check(done.n === PICK_STEP + 1 && done.reason === 'click', `rehearsal ends on the click (${done.secs} s)`)
  await idle
  check(await toggle.isChecked(), 'this time the page got the click')
  const toast = await until(`document.querySelector('.toast')?.textContent ?? ''`, (v) => /took|用了/.test(v), 'the rehearsal toast')
  console.log('toast:', toast)
  await shot('2-rehearsed')
  await evalIn(`__t.click('.sl-settings')`)
  await until(`document.querySelector('.detail-head h2')?.textContent`, (v) => !/5/.test(v), 'storyboard settings')
  await shot('3-settings')

  // ---------------------------------------------------------------- record a run, get a draft
  await evalIn(`__t.click('.toolbar > button:last-of-type')`)
  await until(`__t.qa('.choice').length`, (n) => n >= 3, 'the picker screen')
  await evalIn(`__t.click('.choice', 1)`)
  await until(`!!document.querySelector('.recording')`, Boolean, 'the recording bar')
  await page.waitForTimeout(400)
  await page.locator('.new-todo').click()
  await page.keyboard.type('Record me', { delay: 20 })
  await page.keyboard.press('Enter')
  await page.locator('li', { hasText: 'Record me' }).locator('.toggle').click()
  await page.getByRole('link', { name: 'Completed' }).click()
  await page.getByRole('link', { name: 'All' }).click()
  const bar = await until(`document.querySelector('.recording')?.textContent ?? ''`, (v) => /[:：] ?All/.test(v), 'the last recorded action')
  console.log('bar:', bar)
  await evalIn(`__t.click('.recording .primary')`)
  const tags = await until(`__t.text('.sl-item .text strong')`, (v) => Array.isArray(v) && v.length === 4, 'the draft in the editor')
  console.log('draft steps:', tags)
  check(/What needs to be done/.test(tags[0]) && /Toggle Todo|勾选|Toggle/.test(tags[1]) && /Completed/.test(tags[2]) && /All/.test(tags[3]), 'the draft has one step per action: type, tick, Completed, All')
  check(await evalIn(`!document.querySelector('.ed-head .primary').disabled`), 'the draft is ready to play as is')
  check((await evalIn(`document.querySelector('.ed-title .path').textContent`)) !== '', 'the draft is a new unsaved storyboard')
  await shot('4-draft')
  // The recorded locators work: rehearse the recorded tick.
  await evalIn(`__t.click('.sl-item', 1)`)
  const recStarted = waitNext((e) => e.type === 'step' && e.n === 2, 10_000, 'rehearsing the recorded tick')
  await evalIn(`__t.click('.detail-head .secondary', 0)`)
  const recEntered = await recStarted
  await waitEvent((e) => e.type === 'rect' && e.seq === recEntered.seq && e.found, 10_000, 'the spotlight on the recorded checkbox')
  const recEnded = waitNext((e) => e.type === 'rehearsed', 10_000, 'the recorded step to end')
  await page.locator('li', { hasText: 'Record me' }).locator('.toggle').click()
  check((await recEnded).reason === 'click', 'a recorded click step plays back')
  await waitNext((e) => e.type === 'phase' && e.phase === 'idle', 5000, 'idle').catch(() => {})

  // Record more steps into an open storyboard: they land after the selected step.
  await evalIn(`__t.click('.sl-item', 3)`)
  // The window hears that the rehearsal ended a moment after the app does.
  await until(`!document.querySelector('.toolbar .icon-btn').disabled`, Boolean, 'the record button')
  await evalIn(`__t.click('.toolbar .icon-btn', 0)`)
  await until(`!!document.querySelector('.recording')`, Boolean, 'recording into the open storyboard')
  await page.waitForTimeout(400)
  await page.getByRole('link', { name: 'Active' }).click()
  await until(`document.querySelector('.recording')?.textContent ?? ''`, (v) => /1/.test(v), 'one more action')
  await evalIn(`__t.click('.recording .primary')`)
  const more = await until(`__t.text('.sl-item .text strong')`, (v) => Array.isArray(v) && v.length === 5, 'the added step')
  check(/Active/.test(more[4]), 'recording into an open storyboard adds the step after the selected one')

  // ---------------------------------------------------------------- close, then a new storyboard
  await evalIn(`window.confirm = () => true; __t.click('.toolbar > button:last-of-type')`)
  await until(`__t.qa('.choice').length`, (n) => n >= 3, 'the picker screen')
  await evalIn(`__t.click('.choice', 0)`)
  const fresh = await until(`__t.qa('.sl-item').length`, (n) => n === 1, 'a new one-step storyboard')
  check(fresh === 1, 'New storyboard opens with one step')
  await shot('5-new')
} catch (e) {
  failures.push(String(e.message ?? e))
  const ui = await evalIn(`({ toast: document.querySelector('.toast')?.textContent ?? null, tools: __t.qa('.toolbar button').map((b) => [b.getAttribute('aria-label') ?? b.textContent, b.disabled]) })`).catch(() => null)
  console.error('editor state at failure:', JSON.stringify(ui))
} finally {
  await browser?.close()
  await app.close()
  rmSync(work, { recursive: true, force: true })
}

if (failures.length) {
  console.error('\nFAIL\n' + failures.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('\nPASS editor (headless)')
