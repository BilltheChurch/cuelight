/**
 * Asking an AI model to write or rewrite a storyboard's lines: the prompt, the call to the
 * author's chosen service, one round of "fix these problems" when the answer does not fit, and
 * the keychain-backed store for API keys. Requests go through the fetch the caller hands in, so
 * they follow the app's proxy setting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  AI_DEFAULTS,
  AI_JSON_SCHEMA,
  AI_PROVIDERS,
  checkAiOutput,
  parseAiOutput,
  type AiErrorCode,
  type AiPing,
  type AiProvider,
  type AiRequest,
  type AiResult,
} from '../shared/ai.ts'

type Obj = Record<string, unknown>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type AiTarget = { provider: AiProvider; model: string; baseUrl: string; key: string | null }
export type AiDeps = { fetch: Fetch; signal: AbortSignal; onProgress?: (chars: number) => void }

export class AiFail extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

// ---------------------------------------------------------------- the prompt

const SYSTEM = `You write the spoken lines for Cuelight, a teleprompter that sits on top of the presenter's own screen while they record a product demo. The demo is split into steps. At each step a spotlight sits on one element, and a card next to it shows the step's action label ("tag") and its line ("say"). The presenter reads the line aloud while doing the action, so a line is said in about the time the action takes.

How to write lines:
- Speak to the viewer in plain, natural spoken language: short sentences, no lists, markdown, emoji or stage directions.
- Say what the viewer gets from the step rather than which button is pressed; the tag already names the action.
- Not every step needs a line. Quick clicks between two ideas can stay silent (empty "say"), and the next line carries the thought.
- Keep to what the storyboard shows. Do not invent features, numbers or claims.
- "tag" is a short label for the action, e.g. "Click Sign in", at most about five words; keep the existing one when it is fine. "how" stays empty unless the presenter needs a specific hint, such as what to type.

The acts:
- click: the presenter clicks the element in the spotlight to move on.
- read: the step moves on once the line has been read (a bar fills while the cursor rests in the spotlight).
- wait: the step waits for the page to change. Only for steps that are already wait steps.
- manual: the presenter presses the next-step hotkey when done, for example after typing.
Keep each step's act unless it is clearly wrong.

Structure:
- Keep the order of the steps and never invent new ones.
- You may merge consecutive steps that are really one gesture: give the merged step all their numbers in "from", e.g. [3, 4]. It keeps the spotlight of the first.
- You may drop steps that repeat or undo each other by leaving their numbers out. Never drop a step that later steps depend on.

Answer with JSON only.`

const LANG_NAMES: Record<string, string> = { en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish' }
const langName = (tag: string) => {
  const name = LANG_NAMES[tag.toLowerCase().split('-')[0]]
  return name ? `${name} (${tag})` : tag
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const matchText = (m: unknown) => (typeof m === 'string' ? m : m && typeof m === 'object' ? str((m as Obj).exact) || str((m as Obj).re) : '')

/** One line about where the spotlight goes, without the locator details the model has no use for. */
export function describeTarget(target: unknown): string {
  const l = (Array.isArray(target) ? target[0] : null) as Obj | null
  if (!l || typeof l !== 'object') return ''
  const quoted = (s: string) => (s ? ` “${s}”` : '')
  switch (l.kind) {
    case 'dom': {
      const what = str(l.role) || (str(l.css).match(/^[a-z][a-z0-9-]*/i)?.[0] ?? '') || 'element'
      const label = matchText(l.name) || matchText(l.text) || str(l.testId)
      return `${what}${quoted(label)}` + (l.url ? ` on ${str(l.url)}` : '')
    }
    case 'ax':
      return `${str(l.role).replace(/^AX/, '') || 'element'}${quoted(matchText(l.title) || str(l.identifier))} in ${str(l.app)}`
    case 'visual':
      return `text${quoted(matchText(l.text))} found on screen`
    case 'region':
      return 'a fixed area of the screen'
    default:
      return ''
  }
}

function describeUntil(u: unknown): string {
  if (!u || typeof u !== 'object') return ''
  const o = u as Obj
  if (o.url) return `the page ${str(o.url)} opens`
  if (o.appear) return `${describeTarget(o.appear)} shows up`
  if (o.gone) return `${describeTarget(o.gone)} goes away`
  return ''
}

export const DEFAULT_INSTRUCTION = { whole: 'Write the lines for this demo.', scope: 'Improve these lines.' }

/** The system prompt and the first user message for a request. */
export function buildPrompt(req: AiRequest, provider: AiProvider): { system: string; user: string } {
  const d = (req.doc && typeof req.doc === 'object' ? req.doc : {}) as Obj
  const steps = (Array.isArray(d.steps) ? d.steps : []) as Obj[]
  const brief = (d.brief && typeof d.brief === 'object' ? d.brief : {}) as Obj
  const pace = (d.pace && typeof d.pace === 'object' ? d.pace : {}) as Obj
  const ups = typeof pace.unitsPerSec === 'number' ? pace.unitsPerSec : 2
  const target = typeof brief.targetSecs === 'number' ? brief.targetSecs : null

  const lines = [`Instruction: ${req.instruction.trim() || (req.scope ? DEFAULT_INSTRUCTION.scope : DEFAULT_INSTRUCTION.whole)}`]
  if (str(brief.product)) lines.push(`Product: ${str(brief.product)}`)
  if (str(brief.audience)) lines.push(`Audience: ${str(brief.audience)}`)
  if (str(brief.tone)) lines.push(`Tone: ${str(brief.tone)}`)
  lines.push(
    str(d.language)
      ? `Write the lines in ${langName(str(d.language))}, unless the instruction asks for another language.`
      : `Write the lines in the language of the existing lines; if there are none, in ${req.uiLang === 'zh' ? 'Chinese' : 'English'}.`,
  )
  if (target && !req.scope)
    lines.push(
      `Length: aim for about ${target} seconds of speech in all. The presenter says about ${ups} words a second (a Chinese or Japanese character counts as half a word), so that is roughly ${Math.round(target * ups * 0.8)} words for the whole demo.`,
    )
  else lines.push(`The presenter says about ${ups} words a second (a Chinese or Japanese character counts as half a word).`)
  if (req.scope)
    lines.push(
      `Rewrite only steps ${req.scope.map((i) => i + 1).join(', ')}. Return exactly those steps, in order, each with "from" set to [its own number]; do not merge or drop any. The others are there for context. Keep the title as it is.`,
    )
  else lines.push('Return every step you keep, including silent ones. Improve the title only if it is a placeholder or the instruction asks for it.')
  lines.push(`Write "notes" in ${req.uiLang === 'zh' ? 'Chinese' : 'English'}.`)

  const board = {
    title: str(d.title),
    ...(str(d.description) ? { description: str(d.description) } : {}),
    ...(d.start && typeof d.start === 'object' && str((d.start as Obj).url) ? { start: str((d.start as Obj).url) } : {}),
    steps: steps.map((s, i) => {
      const where = describeTarget(s.target)
      const until = describeUntil(s.until)
      return {
        n: i + 1,
        act: str(s.act) || 'manual',
        ...(where ? { target: where } : {}),
        ...(until ? { until } : typeof s.secs === 'number' && s.act === 'wait' ? { until: `${s.secs} s have passed` } : {}),
        tag: str(s.tag),
        say: str(s.say),
        how: str(s.how),
        ...(str(s.note) ? { note: str(s.note) } : {}),
      }
    }),
  }
  lines.push('', 'The storyboard:', JSON.stringify(board, null, 1))

  // Only Anthropic gets the schema enforced by the API itself on every model; the others are told.
  const system = provider === 'anthropic' ? SYSTEM : `${SYSTEM} It must match this JSON Schema:\n${JSON.stringify(AI_JSON_SCHEMA)}`
  return { system, user: lines.join('\n') }
}

const repairMessage = (problems: string[]) =>
  `That answer has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nReturn the whole JSON again with them fixed.`

// ---------------------------------------------------------------- the services

/** A conversation with one service; each call adds a user turn and returns the model's text. */
type Chat = { send(text: string): Promise<string>; model(): string }

const isDefaultAnthropic = (baseUrl: string) => !baseUrl || baseUrl.replace(/\/+$/, '') === AI_DEFAULTS.anthropic.baseUrl
/** Models that take server-side fallbacks in their "default" form on the Claude API */
const FALLBACK_DEFAULT = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

function anthropicClient(t: AiTarget, deps: AiDeps) {
  return new Anthropic({
    apiKey: t.key ?? '',
    // Only what the author set up counts, never credentials from the environment.
    authToken: null,
    baseURL: t.baseUrl.replace(/\/+$/, '') || AI_DEFAULTS.anthropic.baseUrl,
    fetch: deps.fetch as never,
    maxRetries: 2,
  })
}

function anthropicFail(e: unknown, signal: AbortSignal): AiFail {
  if (e instanceof AiFail) return e
  if (signal.aborted || e instanceof Anthropic.APIUserAbortError) return new AiFail('cancelled')
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiFail('key', e.message)
  if (e instanceof Anthropic.RateLimitError) return new AiFail('rate', e.message)
  if (e instanceof Anthropic.APIConnectionError) return new AiFail('network', e.cause instanceof Error ? e.cause.message : e.message)
  if (e instanceof Anthropic.APIError) return new AiFail('server', e.message)
  return new AiFail('server', e instanceof Error ? e.message : String(e))
}

function anthropicChat(t: AiTarget, system: string, deps: AiDeps): Chat {
  const client = anthropicClient(t, deps)
  const messages: BetaMessageParam[] = []
  const fallback = FALLBACK_DEFAULT.has(t.model) && isDefaultAnthropic(t.baseUrl)
  let served = t.model
  return {
    model: () => served,
    async send(text) {
      messages.push({ role: 'user', content: text })
      try {
        // Streamed, as a long storyboard can take a while; the text deltas drive the progress.
        const stream = client.beta.messages.stream(
          {
            model: t.model,
            max_tokens: 32000,
            system,
            messages,
            output_config: { format: { type: 'json_schema', schema: AI_JSON_SCHEMA } },
            ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          },
          { signal: deps.signal },
        )
        let chars = 0
        stream.on('text', (delta) => deps.onProgress?.((chars += delta.length)))
        const msg = await stream.finalMessage()
        served = msg.model
        if (msg.stop_reason === 'refusal') throw new AiFail('refused', msg.stop_details?.category ?? undefined)
        if (msg.stop_reason === 'max_tokens') throw new AiFail('tooLong')
        messages.push({ role: 'assistant', content: msg.content })
        return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      } catch (e) {
        throw anthropicFail(e, deps.signal)
      }
    },
  }
}

/** The error message an OpenAI-style service sent back, if it sent one. */
function httpDetail(status: number, raw: string): string {
  let msg = ''
  try {
    const j = JSON.parse(raw) as Obj
    const err = j.error
    msg = typeof err === 'string' ? err : err && typeof err === 'object' ? str((err as Obj).message) : str(j.message)
  } catch {
    msg = raw.trim()
  }
  return `${status}${msg ? ': ' + msg.slice(0, 240) : ''}`
}

function httpFail(status: number, raw: string): AiFail {
  const detail = httpDetail(status, raw)
  if (status === 401 || status === 403) return new AiFail('key', detail)
  if (status === 429) return new AiFail('rate', detail)
  return new AiFail('server', detail)
}

type Format = 'schema' | 'object' | 'none'

/** OpenAI, and the many services and local servers (Ollama among them) that speak its API. */
function openaiChat(t: AiTarget, system: string, deps: AiDeps): Chat {
  const url = `${(t.baseUrl || AI_DEFAULTS[t.provider].baseUrl).replace(/\/+$/, '')}/chat/completions`
  const messages: { role: string; content: string }[] = [{ role: 'system', content: system }]
  // Not every OpenAI-style service takes a JSON Schema; those that refuse get plain JSON mode, then nothing.
  let format: Format = t.provider === 'compatible' ? 'object' : 'schema'
  const responseFormat = (f: Format) =>
    f === 'schema'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'cuelight_lines', strict: true, schema: AI_JSON_SCHEMA } } }
      : f === 'object'
        ? { response_format: { type: 'json_object' } }
        : {}
  return {
    model: () => t.model,
    async send(text) {
      messages.push({ role: 'user', content: text })
      for (;;) {
        let status: number
        let raw: string
        try {
          const res = await deps.fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
            body: JSON.stringify({ model: t.model, messages, ...responseFormat(format) }),
            signal: deps.signal,
          })
          status = res.status
          raw = await res.text()
        } catch (e) {
          throw deps.signal.aborted ? new AiFail('cancelled') : new AiFail('network', e instanceof Error ? e.message : String(e))
        }
        if (status === 400 && format !== 'none' && /response_format|json_schema|json_object/i.test(raw)) {
          format = format === 'schema' ? 'object' : 'none'
          continue
        }
        if (status < 200 || status >= 300) throw httpFail(status, raw)
        let choice: Obj | undefined
        try {
          choice = ((JSON.parse(raw) as Obj).choices as Obj[] | undefined)?.[0]
        } catch {
          throw new AiFail('server', 'the answer is not JSON')
        }
        const message = (choice?.message ?? {}) as Obj
        if (str(message.refusal)) throw new AiFail('refused', str(message.refusal))
        if (choice?.finish_reason === 'length') throw new AiFail('tooLong')
        const content = str(message.content)
        if (!content) throw new AiFail('server', 'the answer is empty')
        messages.push({ role: 'assistant', content })
        deps.onProgress?.(content.length)
        return content
      }
    },
  }
}

const chatWith = (t: AiTarget, system: string, deps: AiDeps): Chat => (t.provider === 'anthropic' ? anthropicChat(t, system, deps) : openaiChat(t, system, deps))

/** Whether the target is set up enough to try: a model, an address where one is needed, a key where one is needed. */
export function setupProblem(t: AiTarget): string | null {
  if (!t.model.trim()) return 'model'
  if (t.provider === 'compatible' && !t.baseUrl.trim()) return 'address'
  if (AI_DEFAULTS[t.provider].key === 'required' && !t.key) return 'key'
  return null
}

/** Write or rewrite the lines. The answer is checked; one that does not fit gets one chance to be fixed. */
export async function runAi(req: AiRequest, t: AiTarget, deps: AiDeps): Promise<AiResult> {
  const missing = setupProblem(t)
  if (missing) return { ok: false, error: 'setup', detail: missing }
  const steps = (req.doc as Obj | null)?.steps
  const n = Array.isArray(steps) ? steps.length : 0
  if (!n || (req.scope && req.scope.some((i) => i < 0 || i >= n))) return { ok: false, error: 'invalid', detail: 'nothing to write for' }
  const { system, user } = buildPrompt(req, t.provider)
  const chat = chatWith(t, system, deps)
  try {
    let text = await chat.send(user)
    for (let round = 0; ; round++) {
      const parsed = parseAiOutput(text)
      const problems = parsed.ok ? checkAiOutput(n, req.scope, parsed.out) : [parsed.problem]
      if (parsed.ok && !problems.length) return { ok: true, out: parsed.out, model: chat.model() }
      if (round >= 1) return { ok: false, error: 'invalid', detail: problems.join(' ') }
      text = await chat.send(repairMessage(problems))
    }
  } catch (e) {
    const f = e instanceof AiFail ? e : new AiFail('server', e instanceof Error ? e.message : String(e))
    return { ok: false, error: f.code, detail: f.detail }
  }
}

/** A tiny request to check the address, model and key work. */
export async function pingAi(t: AiTarget, deps: AiDeps): Promise<AiPing> {
  const missing = setupProblem(t)
  if (missing) return { ok: false, error: 'setup', detail: missing }
  try {
    if (t.provider === 'anthropic') {
      const msg = await anthropicClient(t, deps).messages.create(
        { model: t.model, max_tokens: 2000, messages: [{ role: 'user', content: 'Reply with the word OK.' }] },
        { signal: deps.signal },
      )
      return { ok: true, model: msg.model }
    }
    await openaiChat(t, 'Reply with the word OK.', deps).send('OK?')
    return { ok: true, model: t.model }
  } catch (e) {
    const f = t.provider === 'anthropic' ? anthropicFail(e, deps.signal) : e instanceof AiFail ? e : new AiFail('server', String(e))
    return { ok: false, error: f.code, detail: f.detail }
  }
}

// ---------------------------------------------------------------- keys

export type Crypt = { available(): boolean; encrypt(s: string): Buffer; decrypt(b: Buffer): string }

/**
 * API keys, encrypted with the system keychain (Electron safeStorage) in a file of their own.
 * They are decrypted only when a request needs one. Without a file or a working keychain they
 * are kept in memory until the app quits, and never written in the clear.
 */
export class KeyStore {
  readonly secure: boolean
  private mem = new Map<AiProvider, string>()
  private saved: Partial<Record<AiProvider, string>> = {}

  constructor(
    private file: string | null,
    private crypt: Crypt | null,
  ) {
    this.secure = !!file && !!crypt?.available()
    if (!this.secure || !file) return
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Obj
      for (const p of AI_PROVIDERS) if (typeof j[p] === 'string') this.saved[p] = j[p] as string
    } catch {
      // No keys saved yet.
    }
  }

  has(p: AiProvider) {
    return this.mem.has(p) || !!this.saved[p]
  }

  get(p: AiProvider): string | null {
    const k = this.mem.get(p)
    if (k !== undefined) return k
    const blob = this.saved[p]
    if (!blob || !this.crypt) return null
    try {
      const key = this.crypt.decrypt(Buffer.from(blob, 'base64'))
      this.mem.set(p, key)
      return key
    } catch {
      return null
    }
  }

  set(p: AiProvider, key: string | null) {
    const k = key?.trim()
    if (k) {
      this.mem.set(p, k)
      if (this.secure && this.crypt) this.saved[p] = this.crypt.encrypt(k).toString('base64')
    } else {
      this.mem.delete(p)
      delete this.saved[p]
    }
    if (!this.secure || !this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  status(): Record<AiProvider, boolean> {
    return Object.fromEntries(AI_PROVIDERS.map((p) => [p, this.has(p)])) as Record<AiProvider, boolean>
  }
}
