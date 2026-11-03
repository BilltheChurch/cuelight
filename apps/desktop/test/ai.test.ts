import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseStoryboard } from '@cuelight/schema'
import { KeyStore, buildPrompt, describeTarget, runAi, type AiTarget, type Crypt } from '../src/main/ai.ts'
import { checkAiOutput, parseAiOutput, type AiOutput, type AiRequest } from '../src/shared/ai.ts'
import { aiRows, applyAiRows, isChange, readableDiff, wordDiff } from '../src/renderer/src/control/aidiff.ts'
import type { Doc } from '../src/renderer/src/control/doc.ts'

const doc = (): Doc => ({
  cuelight: 1,
  title: 'Todo walkthrough',
  language: 'en',
  brief: { product: 'A todo app', targetSecs: 30 },
  steps: [
    { act: 'manual', say: '', tag: 'Type in “What needs to be done?”', target: [{ kind: 'dom', role: 'textbox', name: 'What needs to be done?' }] },
    { act: 'click', say: '', tag: 'Click “Toggle Todo”', target: [{ kind: 'dom', role: 'checkbox', name: 'Toggle Todo' }] },
    { act: 'click', say: '', target: [{ kind: 'dom', role: 'link', name: 'Completed' }] },
    { act: 'click', say: '', target: [{ kind: 'dom', role: 'link', name: 'All' }] },
    { act: 'wait', say: '', until: { url: 'https://demo.example/*' } },
  ],
})

const out = (steps: AiOutput['steps'], title = 'Todo walkthrough'): AiOutput => ({ title, steps, notes: 'Merged the filter clicks.' })
const st = (from: number[], say: string, act: AiOutput['steps'][number]['act'] = 'click', tag = '', how = '') => ({ from, act, say, tag, how })

describe('the answer', () => {
  it('parses JSON, also inside a code fence', () => {
    const o = out([st([1], 'Hi')])
    expect(parseAiOutput(JSON.stringify(o))).toEqual({ ok: true, out: o })
    expect(parseAiOutput('```json\n' + JSON.stringify(o) + '\n```')).toEqual({ ok: true, out: o })
    expect(parseAiOutput('Sure! Here it is')).toMatchObject({ ok: false })
    expect(parseAiOutput('{"title":"x","steps":[{"from":[1]}],"notes":""}')).toMatchObject({ ok: false, problem: expect.stringContaining('steps.0.act') })
  })

  it('must keep to the storyboard it was written for', () => {
    expect(checkAiOutput(5, null, out([st([1], 'a'), st([2], 'b'), st([3, 4], 'c'), st([5], '', 'wait')]))).toEqual([])
    // Dropping steps is allowed.
    expect(checkAiOutput(5, null, out([st([1], 'a'), st([5], '', 'wait')]))).toEqual([])
    expect(checkAiOutput(5, null, out([st([1], 'a'), st([2, 4], 'b')])).join()).toMatch(/consecutive/)
    expect(checkAiOutput(5, null, out([st([1, 2], 'a'), st([2], 'b')])).join()).toMatch(/more than one/)
    expect(checkAiOutput(5, null, out([st([3], 'a'), st([1], 'b')])).join()).toMatch(/out of order/)
    expect(checkAiOutput(5, null, out([st([6], 'a')])).join()).toMatch(/1 to 5/)
    expect(checkAiOutput(5, null, out([]))).toEqual(['There are no steps.'])
  })

  it('in scope mode, returns exactly the asked steps', () => {
    expect(checkAiOutput(5, [1, 2], out([st([2], 'b'), st([3], 'c')]))).toEqual([])
    expect(checkAiOutput(5, [1, 2], out([st([2, 3], 'b')])).join()).toMatch(/exactly the steps 2, 3/)
  })
})

describe('the prompt', () => {
  const req = (over: Partial<AiRequest> = {}): AiRequest => ({ doc: doc(), scope: null, instruction: '', uiLang: 'zh', ...over })

  it('describes targets without locator details', () => {
    expect(describeTarget([{ kind: 'dom', role: 'button', name: { exact: 'Sign in' }, url: 'https://x/*' }])).toBe('button “Sign in” on https://x/*')
    expect(describeTarget([{ kind: 'dom', css: 'li.todo > .toggle', testId: 'row' }])).toBe('li “row”')
    expect(describeTarget([{ kind: 'ax', app: 'com.apple.finder', role: 'AXButton', title: 'Back' }])).toBe('Button “Back” in com.apple.finder')
    expect(describeTarget(undefined)).toBe('')
  })

  it('carries the brief, language, length and steps', () => {
    const { system, user } = buildPrompt(req(), 'anthropic')
    expect(system).toMatch(/teleprompter/)
    expect(system).not.toMatch(/JSON Schema/)
    expect(user).toMatch(/Instruction: Write the lines for this demo\./)
    expect(user).toMatch(/Product: A todo app/)
    expect(user).toMatch(/English \(en\)/)
    expect(user).toMatch(/about 30 seconds.*roughly 48 words/s)
    expect(user).toMatch(/Write "notes" in Chinese/)
    expect(user).toContain('"target": "textbox “What needs to be done?”"')
    expect(user).toContain('"until": "the page https://demo.example/* opens"')
    expect(user).not.toContain('"kind"')
  })

  it('names the steps to rewrite, and gives other services the schema', () => {
    const { system, user } = buildPrompt(req({ scope: [2], instruction: 'Shorter' }), 'compatible')
    expect(user).toMatch(/Instruction: Shorter/)
    expect(user).toMatch(/Rewrite only steps 3\./)
    expect(user).not.toMatch(/seconds of speech/)
    expect(system).toMatch(/JSON Schema/)
  })
})

describe('reviewing the changes', () => {
  const answer = out(
    [
      st([1], 'Add a todo and press Enter.', 'manual', 'Type a todo', 'Type it, then press Enter'),
      st([2], '', 'click', 'Click “Toggle Todo”'),
      st([3, 4], 'Filters show what is left.', 'click', 'Click Completed'),
    ],
    'Todos in thirty seconds',
  )

  it('turns the answer into rows: title, steps, merges and drops', () => {
    const rows = aiRows(doc(), null, answer)
    expect(rows.map((r) => r.kind)).toEqual(['title', 'step', 'step', 'step', 'drop'])
    expect(rows.map(isChange)).toEqual([true, true, false, true, true])
    const merged = rows[3]
    expect(merged.kind === 'step' && merged.from).toEqual([2, 3])
    // The merged step keeps the first one's target.
    expect(merged.kind === 'step' && merged.after.target).toEqual(doc().steps[2].target)
  })

  it('applies what is ticked and keeps the rest', () => {
    const d = doc()
    const rows = aiRows(d, null, answer)
    const all = applyAiRows(d, rows, rows.map(() => true))
    expect(all.title).toBe('Todos in thirty seconds')
    expect(all.steps.map((s) => s.say)).toEqual(['Add a todo and press Enter.', '', 'Filters show what is left.'])
    expect(all.steps[0]).toMatchObject({ tag: 'Type a todo', how: 'Type it, then press Enter' })
    expect(parseStoryboard(all).ok).toBe(true)
    // Untick the title, the merge and the drop: those come back as they were.
    const some = applyAiRows(d, rows, [false, true, true, false, false])
    expect(some.title).toBe('Todo walkthrough')
    expect(some.steps).toHaveLength(5)
    expect(some.steps[2]).toBe(d.steps[2])
    expect(some.steps[4]).toBe(d.steps[4])
    expect(some.steps[0].say).toBe('Add a todo and press Enter.')
  })

  it('keeps an act the step cannot take', () => {
    const d = doc()
    const rows = aiRows(d, [4], out([st([5], 'Waiting for the page.', 'click')]))
    // A click needs a target, which a wait step does not have.
    expect(rows[0].kind === 'step' && rows[0].after.act).toBe('wait')
    const next = applyAiRows(d, rows, [true])
    expect(next.steps.slice(0, 4)).toEqual(d.steps.slice(0, 4))
    expect(next.steps[4]).toMatchObject({ act: 'wait', say: 'Waiting for the page.', until: d.steps[4].until })
  })

  it('diffs words, and CJK by character', () => {
    expect(wordDiff('Click the big button', 'Click the button now')).toEqual([
      { op: '=', t: 'Click the ' },
      { op: '-', t: 'big ' },
      { op: '=', t: 'button' },
      { op: '+', t: ' now' },
    ])
    expect(wordDiff('点这里登录', '点这里注册')).toEqual([
      { op: '=', t: '点这里' },
      { op: '-', t: '登录' },
      { op: '+', t: '注册' },
    ])
    expect(wordDiff('', 'New')).toEqual([{ op: '+', t: 'New' }])
    expect(wordDiff('Same', 'Same')).toEqual([{ op: '=', t: 'Same' }])
  })

  it('shows a rewrite as old and new when little is shared', () => {
    expect(readableDiff('Todo walkthrough', 'Todos in thirty seconds')).toEqual([
      { op: '-', t: 'Todo walkthrough' },
      { op: '+', t: 'Todos in thirty seconds' },
    ])
    expect(readableDiff('Click the big button', 'Click the button now')).toEqual(wordDiff('Click the big button', 'Click the button now'))
  })
})

describe('keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cuelight-keys-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  // A stand-in for safeStorage: reversible, and not the plain text.
  const crypt = (ok = true): Crypt => ({
    available: () => ok,
    encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  })

  it('are saved encrypted and read back', () => {
    const file = join(dir, 'k.json')
    const a = new KeyStore(file, crypt())
    expect(a.secure).toBe(true)
    a.set('anthropic', '  sk-test-123  ')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-test-123')
    const b = new KeyStore(file, crypt())
    expect(b.has('anthropic')).toBe(true)
    expect(b.get('anthropic')).toBe('sk-test-123')
    expect(b.status()).toEqual({ anthropic: true, openai: false, compatible: false, ollama: false })
    b.set('anthropic', null)
    expect(new KeyStore(file, crypt()).has('anthropic')).toBe(false)
  })

  it('stay in memory without a keychain', () => {
    const file = join(dir, 'none.json')
    const k = new KeyStore(file, crypt(false))
    expect(k.secure).toBe(false)
    k.set('openai', 'sk-mem')
    expect(k.get('openai')).toBe('sk-mem')
    expect(() => readFileSync(file)).toThrow()
    const headless = new KeyStore(null, null)
    headless.set('openai', 'sk-x')
    expect(headless.get('openai')).toBe('sk-x')
  })
})

// ---------------------------------------------------------------- calling the services, with fake servers

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(reply: (c: Call, n: number) => Response) {
  const calls: Call[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const c = { url, headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    calls.push(c)
    return reply(c, calls.length)
  }
  return { fetch, calls }
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const chat = (content: string) => json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })

/** A streamed Messages API answer carrying `text`, as server-sent events. */
function sse(text: string, model = 'claude-opus-5-5', stop = 'end_turn') {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const half = Math.ceil(text.length / 2)
  const body =
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(half) } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }) +
    ev('message_stop', {})
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('calling the services', () => {
  const req: AiRequest = { doc: doc(), scope: [0], instruction: 'Shorter', uiLang: 'en' }
  const good = JSON.stringify(out([st([1], 'Add a todo.', 'manual')]))
  const wrong = JSON.stringify(out([st([2], 'Wrong step.', 'manual')]))
  const signal = new AbortController().signal

  it('asks an OpenAI-style service again when the answer does not fit', async () => {
    const f = fakeFetch((_c, n) => chat(n === 1 ? wrong : good))
    const t: AiTarget = { provider: 'compatible', model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:9/v1/', key: 'k1' }
    const r = await runAi(req, t, { fetch: f.fetch, signal })
    expect(r).toMatchObject({ ok: true, model: 'deepseek-chat' })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0].url).toBe('http://127.0.0.1:9/v1/chat/completions')
    expect(f.calls[0].headers.authorization).toBe('Bearer k1')
    expect(f.calls[0].body.response_format).toEqual({ type: 'json_object' })
    const second = f.calls[1].body.messages as { role: string; content: string }[]
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(second[3].content).toMatch(/exactly the steps 1/)
  })

  it('gives up after one retry, and falls back from JSON Schema when a service refuses it', async () => {
    const f = fakeFetch((c) =>
      c.body.response_format && (c.body.response_format as { type: string }).type === 'json_schema'
        ? json({ error: { message: 'response_format json_schema is not supported' } }, 400)
        : chat(wrong),
    )
    const r = await runAi(req, { provider: 'ollama', model: 'llama3.1', baseUrl: '', key: null }, { fetch: f.fetch, signal })
    expect(r).toMatchObject({ ok: false, error: 'invalid' })
    expect(f.calls.map((c) => (c.body.response_format as { type: string } | undefined)?.type)).toEqual(['json_schema', 'json_object', 'json_object'])
    expect(f.calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(f.calls[0].headers.authorization).toBeUndefined()
  })

  it('reports a rejected key, and a missing setup without calling anything', async () => {
    const f = fakeFetch(() => json({ error: { message: 'Incorrect API key' } }, 401))
    expect(await runAi(req, { provider: 'openai', model: 'some-model', baseUrl: '', key: 'bad' }, { fetch: f.fetch, signal })).toEqual({
      ok: false,
      error: 'key',
      detail: '401: Incorrect API key',
    })
    const none = fakeFetch(() => chat(good))
    expect(await runAi(req, { provider: 'openai', model: 'some-model', baseUrl: '', key: null }, { fetch: none.fetch, signal })).toEqual({
      ok: false,
      error: 'setup',
      detail: 'key',
    })
    expect(none.calls).toHaveLength(0)
  })

  it('streams from Anthropic with structured output, and a fallback only on the Claude API', async () => {
    const progress: number[] = []
    const f = fakeFetch(() => sse(good))
    const t: AiTarget = { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '', key: 'sk-ant-test' }
    const r = await runAi(req, t, { fetch: f.fetch, signal, onProgress: (n) => progress.push(n) })
    expect(r).toMatchObject({ ok: true, model: 'claude-opus-5-5' })
    const c = f.calls[0]
    expect(c.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/)
    // SDK 1.x sends the key as a bearer token.
    expect(c.headers.authorization).toBe('Bearer sk-ant-test')
    expect(c.headers['anthropic-version']).toBeTruthy()
    expect(c.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01')
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', output_config: { format: { type: 'json_schema' } } })
    expect(c.body.thinking).toBeUndefined()
    expect(progress.at(-1)).toBe(good.length)

    const g = fakeFetch(() => sse(good, 'claude-sonnet-4-6'))
    await runAi(req, { ...t, model: 'claude-sonnet-4-6', baseUrl: 'http://127.0.0.1:9' }, { fetch: g.fetch, signal })
    expect(g.calls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:9\/v1\/messages/)
    expect(g.calls[0].body.fallbacks).toBeUndefined()
    expect(g.calls[0].headers['anthropic-beta']).toBeUndefined()
  })

  it('reports a refusal from Anthropic', async () => {
    const f = fakeFetch(() => sse('', 'claude-opus-5-5', 'refusal'))
    const r = await runAi(req, { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '', key: 'k' }, { fetch: f.fetch, signal })
    expect(r).toMatchObject({ ok: false, error: 'refused' })
  })
})
