// End-to-end check of writing lines with AI, invisible like the other checks and with no real AI
// service: a local server stands in for both the Anthropic Messages API (streamed) and an
// OpenAI-style chat completions API. The app runs headless, so keys stay in memory and the
// keychain is never asked. It sets up a service through the sheet and tests it, drafts a whole
// storyboard, takes some changes and leaves others, undoes and redoes that, rewrites one step
// through an OpenAI-compatible service that first answers wrongly, shows a rejected key, and
// cancels a slow request.
//
//   pnpm --filter @cuelight/desktop build
//   node scripts/e2e-ai.mjs [--lang en|zh] [--shots <dir>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_HELPERS, arg, sleep, startApp } from './e2e-lib.mjs'

const lang = arg('--lang') ?? 'en'
const shots = arg('--shots')
const KEY = 'test-key-e2e'

const board = {
  cuelight: 1,
  title: 'Todo walkthrough',
  language: 'en',
  brief: { product: 'A small todo app', audience: 'New users', tone: 'Friendly', targetSecs: 30 },
  steps: [
    { act: 'manual', say: '', tag: 'Type in “What needs to be done?”', target: [{ kind: 'dom', role: 'textbox', name: 'What needs to be done?' }] },
    { act: 'click', say: '', tag: 'Click “Toggle Todo”', target: [{ kind: 'dom', role: 'checkbox', name: 'Toggle Todo' }] },
    { act: 'click', say: '', tag: 'Click “Completed”', target: [{ kind: 'dom', role: 'link', name: 'Completed' }] },
    { act: 'click', say: '', tag: 'Click “All”', target: [{ kind: 'dom', role: 'link', name: 'All' }] },
    { act: 'read', say: 'That is the whole flow.' },
  ],
}
const work = mkdtempSync(join(tmpdir(), 'cuelight-e2e-ai-'))
const file = join(work, 'todo.json')
writeFileSync(file, JSON.stringify(board, null, 2))

const DRAFT = {
  title: 'Todos in thirty seconds',
  notes: 'Wrote every line, merged the two filter clicks and dropped the closing step.',
  steps: [
    { from: [1], act: 'manual', say: 'Type what you need to do and press Enter.', tag: 'Type a todo', how: '' },
    { from: [2], act: 'click', say: 'Tick it off when it is done.', tag: 'Click “Toggle Todo”', how: '' },
    { from: [3, 4], act: 'click', say: 'The filters show what is left and what is finished.', tag: 'Click “Completed”', how: '' },
  ],
}
const REWRITE_WRONG = { title: '', notes: '', steps: [{ from: [2], act: 'manual', say: 'Wrong step.', tag: '', how: '' }] }
const REWRITE = { title: '', notes: 'Shorter.', steps: [{ from: [1], act: 'manual', say: 'Add a todo.', tag: 'Type a todo', how: '' }] }

// ---------------------------------------------------------------- the stand-in server

const seen = []
let mode = 'ok'
let chatAnswers = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {}
    const call = { path: req.url, headers: req.headers, body, aborted: false }
    res.on('close', () => !res.writableFinished && (call.aborted = true))
    seen.push(call)
    const json = (o, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)))
    if (req.url.startsWith('/v1/messages')) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
      if (!body.stream)
        return json({ id: 'msg_ping', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 0 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      const text = JSON.stringify(DRAFT)
      // Slowly enough that the sheet shows its progress.
      for (let i = 0; i < text.length; i += 60) {
        await sleep(90)
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 60) } })
      }
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 300 } })
      ev('message_stop', {})
      return res.end()
    }
    if (req.url === '/v1/chat/completions') {
      if (mode === '401') return json({ error: { message: 'Incorrect API key provided' } }, 401)
      if (mode === 'slow') return void setTimeout(() => !res.writableEnded && json({ choices: [] }), 15_000)
      const answer = chatAnswers.shift() ?? REWRITE
      return json({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
    }
    json({ error: 'not found' }, 404)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
console.log('stand-in AI service on', base)

// ---------------------------------------------------------------- the app

const app = startApp({ args: ['--open', file], stdin: true, lang, quiet: ['rect', 'eval'] })
const { evalIn, waitEvent, waitNext } = app
const failures = []
const check = (ok, what) => {
  console.log((ok ? 'ok    ' : 'FAIL  ') + what)
  if (!ok) failures.push(what)
}
async function until(js, test, what, ms = 10_000) {
  const end = Date.now() + ms
  let v
  while (Date.now() < end) {
    v = await evalIn(js).catch((e) => String(e))
    if (test(v)) return v
    await sleep(120)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(v)})`)
}
const shot = async (n) => shots && (mkdirSync(shots, { recursive: true }), await app.shot(join(shots, `ai-${lang}-${n}.png`)))
/** Clicks the button whose text matches, inside `scope` */
async function press(scope, re) {
  const r = await evalIn(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})]
    const b = all.find((e) => ${re}.test(e.textContent.trim()))
    if (!b) return 'no button ${String(re).replace(/\\/g, '\\\\')} in ${scope}: ' + JSON.stringify(all.map((e) => e.textContent))
    if (b.disabled) return 'disabled: ' + b.textContent
    b.click()
    return true
  })()`)
  if (r !== true) throw new Error(r)
}
const sheetText = () => evalIn(`document.querySelector('.sheet')?.textContent ?? ''`)

try {
  await waitEvent((e) => e.type === 'bridge', 20_000, 'app start')
  await evalIn(DOM_HELPERS)
  await until(`__t.qa('.sl-item').length`, (n) => n === board.steps.length, 'the editor')
  check(/claude-opus-5-5/.test(await evalIn(`document.querySelector('.ai-tile')?.textContent`)), 'the AI tile starts on Anthropic with the default model, no key yet')

  // ---------------------------------------------------------------- set up and test
  await evalIn(`__t.click('.ai-tile .secondary')`)
  await until(`!!document.querySelector('.sheet .providers')`, Boolean, 'the setup sheet')
  check((await evalIn(`__t.qa('.providers .act-tile').length`)) === 4, 'four services to choose from')
  await evalIn(`__t.type('input[name=ai-address]', ${JSON.stringify(base)})`)
  await evalIn(`__t.type('input[name=ai-key]', ${JSON.stringify(KEY)})`)
  check((await evalIn(`document.querySelector('input[name=ai-key]').type`)) === 'password', 'the key field hides what is typed')
  await press('.sheet .sheet-foot', /^(Test|测试)$/)
  const tested = await until(`document.querySelector('.ai-test')?.textContent ?? ''`, (v) => v.length > 0, 'the test result')
  check(/works|可以用/.test(tested), `Test talks to the service: ${tested}`)
  check(seen.at(-1)?.body.stream !== true && seen.at(-1)?.headers.authorization === `Bearer ${KEY}`, 'the test sent the typed key, before saving')
  await shot('1-setup')
  const savedEv = waitNext((e) => e.type === 'ai' && e.phase === 'setup', 8000, 'the setup to save')
  await press('.sheet .sheet-foot', /^(Save|保存)$/)
  const sv = await savedEv
  check(sv.provider === 'anthropic' && sv.key === true, 'Save keeps the service and the key')
  await until(`!document.querySelector('.sheet')`, Boolean, 'the sheet to close')
  const settings = readFileSync(join(app.userData, 'settings.json'), 'utf8')
  check(settings.includes(base) && !settings.includes(KEY), 'the settings file has the address and not the key')
  check(!existsSync(join(app.userData, 'ai-keys.json')), 'a headless run writes no key file (memory only)')

  // ---------------------------------------------------------------- draft the whole storyboard
  await press('.ed-cta', /AI/)
  await until(`!!document.querySelector('.sheet .ai-ask')`, Boolean, 'the AI sheet')
  check(/A small todo app/.test(await sheetText()), 'the sheet shows the brief')
  await until(`!document.querySelector('.sheet-foot .primary').disabled`, Boolean, 'Write to be enabled with the key saved')
  check(true, 'with the key saved, Write is enabled')
  await shot('2-ask')
  await press('.ai-chips', /Write all|全部写/)
  const started = waitNext((e) => e.type === 'ai' && e.phase === 'start', 8000, 'the request')
  await press('.sheet .sheet-foot', /^(Write|开始写)$/)
  await started
  await until(`document.querySelector('.ai-running')?.textContent ?? ''`, (v) => /Writing|正在写/.test(v), 'progress while the answer streams in')
  check(true, 'the sheet shows progress while the answer streams in')
  await shot('3-running')
  await until(`__t.qa('.ai-row').length`, (n) => n > 0, 'the review', 20_000)
  const req = seen.findLast((c) => c.path.startsWith('/v1/messages') && c.body.stream)
  check(req.body.output_config?.format?.type === 'json_schema', 'the request asks for structured output')
  check(req.body.fallbacks === undefined, 'no server-side fallback on a custom address')
  check(/teleprompter/.test(req.body.system) && /Product: A small todo app/.test(req.body.messages[0].content), 'the prompt carries the brief')
  check(!/"kind"/.test(req.body.messages[0].content), 'the prompt describes targets without locators')
  const rows = await evalIn(`__t.text('.ai-row .ai-row-head')`)
  console.log('rows:', JSON.stringify(rows))
  check(rows.length === 5, 'five changes: title, two lines, a merge and a drop')
  check(/Wrote every line|merged/i.test(await sheetText()), 'the model’s notes are shown')
  check((await evalIn(`__t.qa('.ai-row ins').length`)) >= 3, 'new words are marked')
  await shot('4-review')
  // Leave the drop: the closing step stays.
  await evalIn(`__t.click('.ai-row.drop input')`)
  const applyLabel = await evalIn(`[...document.querySelectorAll('.sheet-foot .primary')].at(-1).textContent`)
  check(/4/.test(applyLabel), `the apply button counts what is ticked: ${applyLabel}`)
  await press('.sheet .sheet-foot', /Apply|采纳/)
  await until(`!document.querySelector('.sheet')`, Boolean, 'the sheet to close')
  const items = await until(`__t.text('.sl-item .text')`, (v) => v.length === 4, 'four steps after the merge')
  console.log('steps:', JSON.stringify(items))
  check((await evalIn(`document.querySelector('.title-input').value`)) === DRAFT.title, 'the new title is in')
  check(items[0].includes('Type what you need to do') && items[3].includes('That is the whole flow.'), 'new lines are in, and the step left alone stays')
  check(/Applied|采纳/.test(await evalIn(`document.querySelector('.toast')?.textContent ?? ''`)), 'a toast says it can be undone')
  await evalIn(`__t.key('z', { metaKey: true })`)
  await until(`__t.qa('.sl-item').length`, (n) => n === 5, 'undo')
  check((await evalIn(`document.querySelector('.title-input').value`)) === board.title, 'one undo takes the whole AI change back')
  await evalIn(`__t.key('z', { metaKey: true, shiftKey: true })`)
  await until(`__t.qa('.sl-item').length`, (n) => n === 4, 'redo')
  check(true, 'redo applies it again')
  await shot('5-applied')

  // ---------------------------------------------------------------- one step, through an OpenAI-compatible service
  await evalIn(`__t.click('.ai-tile .secondary')`)
  await until(`!!document.querySelector('.sheet .providers')`, Boolean, 'the setup sheet')
  await evalIn(`__t.click('.providers .act-tile', 2)`)
  await until(`document.querySelector('input[name=ai-model]').value === ''`, Boolean, 'the compatible profile')
  await evalIn(`__t.type('input[name=ai-model]', 'mock-chat')`)
  await evalIn(`__t.type('input[name=ai-address]', ${JSON.stringify(base + '/v1')})`)
  await press('.sheet .sheet-foot', /^(Save|保存)$/)
  await until(`/mock-chat/.test(document.querySelector('.ai-tile')?.textContent)`, Boolean, 'the tile to show the new model')
  check(true, 'switched to an OpenAI-compatible service with no key')
  await evalIn(`__t.click('.sl-item', 0)`)
  await until(`document.querySelector('.detail-head h2')?.textContent`, (v) => /1/.test(v), 'step 1 selected')
  await evalIn(`__t.click('.detail-head .icon-btn', 0)`)
  await until(`!!document.querySelector('.sheet .ai-scope')`, Boolean, 'the AI sheet on step 1')
  check(/1/.test(await evalIn(`document.querySelector('.ai-scope [aria-checked=true]').textContent`)), 'opening it from a step picks that step')
  chatAnswers = [REWRITE_WRONG, REWRITE]
  const before = seen.length
  await press('.sheet .sheet-foot', /^(Write|开始写)$/)
  await until(`__t.qa('.ai-row').length`, (n) => n === 1, 'the one-step review', 15_000)
  const chats = seen.slice(before)
  check(chats.length === 2, 'a wrong answer is sent back once to be fixed')
  check(chats[0].body.response_format?.type === 'json_object' && !chats[0].headers.authorization, 'JSON mode, and no key header when there is no key')
  check(/exactly the steps 1/.test(chats[1].body.messages.at(-1).content), 'the retry says what was wrong')
  await press('.sheet .sheet-foot', /Apply|采纳/)
  await until(`__t.text('.sl-item .text')[0]`, (v) => v.includes('Add a todo.'), 'the rewritten line')
  check(true, 'the rewritten line is in, the other steps untouched')

  // ---------------------------------------------------------------- a rejected key, then a cancelled request
  mode = '401'
  await press('.ed-cta', /AI/)
  await until(`!!document.querySelector('.sheet .ai-ask')`, Boolean, 'the AI sheet')
  await press('.sheet .sheet-foot', /^(Write|开始写)$/)
  const err = await until(`document.querySelector('.ai-error')?.textContent ?? ''`, (v) => v.length > 0, 'the error')
  check(/key/.test(err) && /401/.test(err), `a rejected key says so: ${err}`)
  await shot('6-error')
  mode = 'slow'
  await press('.sheet .ai-error', /Try again|再写一次/)
  const cancelled = waitNext((e) => e.type === 'ai' && e.phase === 'error' && e.error === 'cancelled', 10_000, 'the cancel')
  await press('.sheet .sheet-foot', /^(Write|开始写)$/)
  await until(`!!document.querySelector('.ai-running')`, Boolean, 'the running state')
  await sleep(300)
  await press('.ai-running', /Cancel|取消/)
  await cancelled
  await until(`!!document.querySelector('.sheet .ai-ask')`, Boolean, 'back to the question')
  await sleep(200)
  check(seen.at(-1).aborted, 'Cancel aborts the request to the service')
  await evalIn(`__t.key('Escape')`)
  await until(`!document.querySelector('.sheet')`, Boolean, 'Esc to close the sheet')
  check(true, 'Esc closes the sheet')
} catch (e) {
  failures.push(String(e))
  console.error(e)
  console.log('sheet:', await sheetText().catch(() => '?'))
} finally {
  // The draft is unsaved on purpose; let the window close without asking.
  await evalIn(`window.onbeforeunload = null; true`).catch(() => {})
  await app.close()
  server.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(failures.length ? `FAIL ai (${failures.length})` : 'PASS ai (headless)')
process.exit(failures.length ? 1 : 0)
