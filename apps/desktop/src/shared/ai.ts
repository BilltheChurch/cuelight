/**
 * Writing lines with an AI model, the parts both processes need: which services there are, what
 * the model answers with, and checking that answer against the storyboard it was written for.
 * The model only writes words. It never sees or changes targets, so a merge or a dropped step is
 * the most it can do to the structure, and the author accepts or turns down each change.
 */
import { z } from 'zod'

export type AiProvider = 'anthropic' | 'openai' | 'compatible' | 'ollama'
export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'compatible', 'ollama']

/** Defaults per service. An empty model or address has to be filled in by the author. */
export const AI_DEFAULTS: Record<AiProvider, { baseUrl: string; model: string; key: 'required' | 'optional' | 'none' }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', key: 'required' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', key: 'required' },
  compatible: { baseUrl: '', model: '', key: 'optional' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', key: 'none' },
}

export type AiProfile = { model: string; baseUrl: string }

/** What is kept in the settings file. Keys are not: they live in the system keychain. */
export type AiConfig = {
  provider: AiProvider
  /** Empty: the system proxy (or HTTPS_PROXY when that is set) */
  proxy: string
  profiles: Partial<Record<AiProvider, AiProfile>>
}

export const AI_CONFIG_DEFAULT: AiConfig = { provider: 'anthropic', proxy: '', profiles: {} }

export const profileOf = (c: AiConfig, p: AiProvider = c.provider): AiProfile => ({
  model: c.profiles[p]?.model || AI_DEFAULTS[p].model,
  baseUrl: c.profiles[p]?.baseUrl ?? '',
})

/** What the control window is told about the setup. */
export type AiInfo = AiConfig & {
  /** Which services have a key saved */
  keys: Record<AiProvider, boolean>
  /** False when the system cannot encrypt keys, so they are kept only until the app quits */
  secure: boolean
}

export type AiSetup = {
  provider: AiProvider
  profile: AiProfile
  proxy: string
  /** A new key; null removes the saved one; undefined leaves it as it is */
  key?: string | null
}

export type AiRequest = {
  /** The editor's storyboard JSON, saved or not */
  doc: unknown
  /** Rewrite only these steps (0-based); null for the whole storyboard */
  scope: number[] | null
  instruction: string
  /** Language of the author's notes in the answer */
  uiLang: 'en' | 'zh'
}

export type AiErrorCode = 'setup' | 'key' | 'network' | 'rate' | 'refused' | 'tooLong' | 'invalid' | 'cancelled' | 'server' | 'busy'

export type AiResult = { ok: true; out: AiOutput; model: string } | { ok: false; error: AiErrorCode; detail?: string }
export type AiPing = { ok: true; model: string } | { ok: false; error: AiErrorCode; detail?: string }

/** Set up enough to try: a model, an address where one is needed, a key where one is needed. */
export function aiReady(info: AiInfo, p: AiProvider = info.provider): boolean {
  const prof = profileOf(info, p)
  return !!prof.model && (p !== 'compatible' || !!prof.baseUrl) && (AI_DEFAULTS[p].key !== 'required' || info.keys[p])
}

export const AiStep = z.object({
  from: z.array(z.number().int()).min(1),
  act: z.enum(['click', 'read', 'wait', 'manual']),
  say: z.string(),
  tag: z.string(),
  how: z.string(),
})
export type AiStep = z.infer<typeof AiStep>

export const AiOutput = z.object({ title: z.string(), steps: z.array(AiStep), notes: z.string() })
export type AiOutput = z.infer<typeof AiOutput>

/**
 * The same shape as JSON Schema, for structured output. Every field is required and nothing
 * else is allowed, which is what strict structured output on both API families needs.
 */
export const AI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'steps', 'notes'],
  properties: {
    title: { type: 'string', description: 'Title of the storyboard' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'act', 'say', 'tag', 'how'],
        properties: {
          from: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Numbers of the original steps this step stands for: one number, or consecutive numbers when merging',
          },
          act: { type: 'string', enum: ['click', 'read', 'wait', 'manual'] },
          say: { type: 'string', description: 'The spoken line; empty for a silent step' },
          tag: { type: 'string', description: 'Short action label, e.g. "Click Sign in"; empty for none' },
          how: { type: 'string', description: 'How-to hint; empty for the automatic one' },
        },
      },
    },
    notes: { type: 'string', description: 'One or two sentences for the author on what changed and why' },
  },
} as const

/** The model's text as an answer: JSON, possibly wrapped in a code fence by a looser model. */
export function parseAiOutput(text: string): { ok: true; out: AiOutput } | { ok: false; problem: string } {
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, problem: 'The answer is not valid JSON.' }
  }
  const r = AiOutput.safeParse(json)
  if (!r.success) return { ok: false, problem: 'The JSON does not match the schema: ' + r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ') }
  return { ok: true, out: r.data }
}

/**
 * What is wrong with an answer for a storyboard of `n` steps, as sentences the model can act on
 * when asked to try again. Step numbers are 1-based here, as the model sees them.
 */
export function checkAiOutput(n: number, scope: number[] | null, out: AiOutput): string[] {
  const problems: string[] = []
  if (!out.steps.length) problems.push('There are no steps.')
  if (scope) {
    const want = scope.map((i) => i + 1)
    const got = out.steps.map((s) => s.from)
    if (got.length !== want.length || got.some((f, k) => f.length !== 1 || f[0] !== want[k]))
      problems.push(`Return exactly the steps ${want.join(', ')}, in that order, each with "from" set to [its own number]. Do not merge or drop any.`)
    return problems
  }
  const used = new Set<number>()
  let last = 0
  for (const s of out.steps) {
    const f = s.from
    if (f.some((x) => x < 1 || x > n)) {
      problems.push(`"from" ${JSON.stringify(f)} names a step that does not exist; the steps are numbered 1 to ${n}.`)
      continue
    }
    if (f.some((x, k) => k > 0 && x !== f[k - 1] + 1)) problems.push(`"from" ${JSON.stringify(f)} is not a run of consecutive numbers.`)
    if (f.some((x) => used.has(x))) problems.push(`Step ${f.find((x) => used.has(x))} appears in more than one "from".`)
    if (f[0] <= last) problems.push(`The steps are out of order at "from" ${JSON.stringify(f)}; keep the original order.`)
    f.forEach((x) => used.add(x))
    last = f[f.length - 1]
  }
  return problems
}
