/**
 * The Cuelight storyboard: a versioned JSON file that people and AI can both read and write.
 *
 * A storyboard is a list of steps. Each step says what to say, what the presenter does
 * (click, read, wait, or advance manually), and where the spotlight goes. "Where" is a
 * fallback chain of locators of different kinds, tried in order at runtime:
 *
 *   dom     a web page element, resolved by the browser extension (test id, ARIA role + name, text, CSS)
 *   ax      a desktop app element from the macOS Accessibility tree (Windows UI Automation later)
 *   visual  an OCR text or template image anchor inside an app window
 *   region  a fixed rectangle relative to a window or a screen
 *
 * A step with no target is a talk-only cue: the card sits near the camera or at the bottom
 * of the screen, and the presenter pages with the hotkey.
 */
import * as z from 'zod'

export const SCHEMA_VERSION = 1

const isRegex = (re: string, flags?: string) => {
  try {
    new RegExp(re, flags)
    return true
  } catch {
    return false
  }
}

/**
 * How to match a piece of text.
 * - a plain string matches as a case-insensitive substring after collapsing whitespace
 * - { exact } must equal the whole (whitespace-collapsed) text, case-sensitive
 * - { re, flags } is a JavaScript regular expression
 */
export const TextMatch = z
  .union([
    z.string().min(1),
    z.object({ exact: z.string().min(1) }),
    z
      .object({ re: z.string().min(1), flags: z.string().regex(/^[dgimsuvy]*$/).optional() })
      .refine((m) => isRegex(m.re, m.flags), { message: 'invalid regular expression' }),
  ])
  .describe('Plain string = case-insensitive substring; {exact} = whole text; {re, flags} = RegExp')
export type TextMatch = z.infer<typeof TextMatch>

/** [x, y, width, height] */
export const Rect = z.tuple([z.number(), z.number(), z.number().nonnegative(), z.number().nonnegative()])
export type Rect = z.infer<typeof Rect>

/** One DOM query. Several fields narrow each other down (e.g. css + text = "a <css> that contains <text>"). */
const domQueryShape = {
  testId: z.string().min(1).optional().describe('Value of data-testid (also data-test, data-cy, data-qa)'),
  role: z.string().min(1).optional().describe('ARIA role, explicit or implicit (button, link, textbox, heading, ...)'),
  name: TextMatch.optional().describe('Accessible name, used with role'),
  text: TextMatch.optional().describe('Visible text. Alone: the innermost element with this text. With other fields: a has-text filter'),
  css: z.string().min(1).optional().describe('CSS selector'),
  nth: z.number().int().nonnegative().optional().describe('Pick the n-th visible match (default 0)'),
  closest: z.string().min(1).optional().describe('After matching, climb to the closest ancestor matching this CSS selector'),
}
const hasQueryField = (q: { testId?: unknown; role?: unknown; text?: unknown; css?: unknown }) =>
  q.testId !== undefined || q.role !== undefined || q.text !== undefined || q.css !== undefined
const NEEDS_FIELD = { message: 'a dom query needs at least one of testId, role, text, css' }

export const DomQuery = z.object(domQueryShape).refine(hasQueryField, NEEDS_FIELD)
export type DomQuery = z.infer<typeof DomQuery>

export const DomLocator = z
  .object({
    kind: z.literal('dom'),
    url: z.string().optional().describe('Only on pages whose URL matches this glob (* is a wildcard)'),
    within: DomQuery.optional().describe('Search inside the first visible match of this query'),
    ...domQueryShape,
  })
  .refine(hasQueryField, NEEDS_FIELD)
export type DomLocator = z.infer<typeof DomLocator>

const AxPathItem = z.object({
  role: z.string().min(1),
  title: TextMatch.optional(),
  identifier: z.string().optional(),
  index: z.number().int().nonnegative().optional().describe('Position among its parent\'s children with the same role'),
})

export const AxLocator = z
  .object({
    kind: z.literal('ax'),
    app: z.string().min(1).describe('Bundle identifier, e.g. com.apple.finder'),
    window: TextMatch.optional().describe('Window title'),
    role: z.string().optional().describe('AXRole, e.g. AXButton'),
    subrole: z.string().optional(),
    title: TextMatch.optional().describe('AXTitle, or AXValue for elements without a title (static text, say)'),
    identifier: z.string().optional().describe('AXIdentifier'),
    description: TextMatch.optional(),
    path: z.array(AxPathItem).optional().describe('Ancestors from the window down, in order; others may sit between them'),
    nth: z.number().int().nonnegative().optional(),
  })
  .describe('macOS Accessibility element (resolved by the native helper)')
export type AxLocator = z.infer<typeof AxLocator>

export const VisualLocator = z
  .object({
    kind: z.literal('visual'),
    app: z.string().optional().describe('Search inside this app\'s front window; omit to search the screen'),
    text: TextMatch.optional().describe('Text to find with on-device OCR'),
    image: z.string().optional().describe('Template image, path relative to the storyboard file or a data: URI'),
    threshold: z.number().min(0).max(1).optional(),
    box: Rect.optional().describe('Spotlight box relative to the found anchor\'s top-left, in points'),
  })
  .refine((v) => v.text !== undefined || v.image !== undefined, { message: 'a visual locator needs text or image' })
export type VisualLocator = z.infer<typeof VisualLocator>

export const RegionLocator = z.object({
  kind: z.literal('region'),
  relativeTo: z.enum(['screen', 'window']).default('screen'),
  app: z.string().optional().describe('With relativeTo=window: bundle identifier of the app'),
  display: z.number().int().nonnegative().optional().describe('With relativeTo=screen: display index, 0 = primary'),
  rect: Rect,
  units: z.enum(['pt', 'fraction']).default('pt'),
})
export type RegionLocator = z.infer<typeof RegionLocator>

export const Locator = z.discriminatedUnion('kind', [DomLocator, AxLocator, VisualLocator, RegionLocator])
export type Locator = z.infer<typeof Locator>
export type LocatorKind = Locator['kind']

/** Fallback chain: the first locator that resolves wins. */
export const Target = z.array(Locator).min(1)
export type Target = z.infer<typeof Target>

export const Until = z
  .object({
    appear: Target.optional().describe('Done when this target shows up'),
    gone: Target.optional().describe('Done when this target disappears'),
    url: z.string().optional().describe('Done when the page URL matches this glob'),
    timeoutSecs: z.number().positive().optional().describe('Give up waiting and move on after this long'),
  })
  .refine((u) => u.appear !== undefined || u.gone !== undefined || u.url !== undefined, {
    message: 'until needs appear, gone or url',
  })
export type Until = z.infer<typeof Until>

export const CardPlacement = z.enum(['auto', 'top', 'bottom'])
export type CardPlacement = z.infer<typeof CardPlacement>

export const Act = z.enum(['click', 'read', 'wait', 'manual'])
export type Act = z.infer<typeof Act>

export const Step = z
  .object({
    id: z.string().min(1).optional(),
    act: Act.describe(
      'click: click inside the spotlight to advance. read: the bar fills while the cursor rests in the spotlight (or always, without a target). wait: until a condition or `secs`. manual: advance with the hotkey',
    ),
    say: z.string().default('').describe('The line to say. Empty = do it silently'),
    tag: z.string().optional().describe('Short action label above the line, e.g. "Click Sign in"'),
    how: z.string().optional().describe('Override the automatic "how to do this" hint. {nextKey} shows the next-step hotkey'),
    target: Target.optional(),
    until: Until.optional(),
    optional: z.boolean().optional().describe('Skip this step if its target does not show up within 3 s'),
    secs: z.number().positive().optional().describe('read: override the reading time. wait: fixed wait'),
    card: CardPlacement.optional().describe('Card placement when there is no spotlight'),
    note: z.string().optional().describe('Author note, never shown on screen'),
  })
  .superRefine((s, ctx) => {
    if (s.act === 'click' && !s.target) ctx.addIssue({ code: 'custom', message: 'a click step needs a target', path: ['target'] })
    if (s.act === 'wait' && !s.until && s.secs === undefined)
      ctx.addIssue({ code: 'custom', message: 'a wait step needs until or secs', path: ['until'] })
  })
export type Step = z.infer<typeof Step>
export type StepInput = z.input<typeof Step>

export const Pace = z.object({
  unitsPerSec: z.number().positive().default(2).describe('Speech units per second (an English word = 1, a CJK character = 0.5)'),
  leadSecs: z.number().nonnegative().default(1.2).describe('Extra time to start and finish a line'),
  minSecs: z.number().nonnegative().default(2.5),
})
export type Pace = z.infer<typeof Pace>

export const Brief = z
  .object({
    product: z.string().optional().describe('What is being shown'),
    audience: z.string().optional().describe('Who will watch'),
    tone: z.string().optional().describe('How the lines should sound, e.g. "friendly, plain"'),
    targetSecs: z.number().positive().optional().describe('Target length of the whole run in seconds'),
  })
  .describe('Notes for whoever writes the lines, a person or an AI model')
export type Brief = z.infer<typeof Brief>

export const Storyboard = z.object({
  $schema: z.string().optional(),
  cuelight: z.literal(SCHEMA_VERSION).describe('Storyboard format version'),
  title: z.string().min(1),
  description: z.string().optional(),
  brief: Brief.optional(),
  language: z.string().optional().describe('BCP 47 tag of the spoken lines, e.g. en, zh-CN'),
  start: z
    .object({
      url: z.string().url().optional().describe('Open this page when playback starts (if the tab is elsewhere)'),
      app: z.string().optional().describe('Bundle identifier of the app to bring forward'),
    })
    .optional(),
  pace: Pace.partial().optional(),
  card: CardPlacement.optional().describe('Default card placement when a step has no spotlight'),
  steps: z.array(Step).min(1),
})
export type Storyboard = z.infer<typeof Storyboard>
export type StoryboardInput = z.input<typeof Storyboard>

export type ParseResult = { ok: true; value: Storyboard } | { ok: false; issues: string[] }

export function parseStoryboard(input: unknown): ParseResult {
  const r = Storyboard.safeParse(input)
  if (r.success) return { ok: true, value: r.data }
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
  }
}

/** Stable id for a step: its own id, or its 1-based position. */
export const stepId = (s: Step, index: number) => s.id ?? `s${index + 1}`
