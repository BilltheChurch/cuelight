/**
 * A recorded run in the browser, and the draft storyboard made from it: one step per meaningful
 * action, with the lines left empty for the author (or an AI pass) to write. Typing is recorded
 * as where and how much; the text itself only when the author asked for it.
 */
import type { Lang } from './cues.ts'
import type { DomLocator, StepInput, StoryboardInput } from './storyboard.ts'

export type RecEvent =
  | { k: 'click'; at: number; url: string; locators: DomLocator[]; label: string; role: string | null }
  | {
      k: 'type'
      at: number
      url: string
      locators: DomLocator[]
      label: string
      role: string | null
      chars: number
      /** Only when recording typed text was switched on, and never for passwords */
      text?: string
      /** The presenter pressed Enter in the field */
      enter: boolean
    }
  | { k: 'nav'; at: number; url: string; title: string }

const STRINGS = {
  en: {
    click: 'Click “{label}”',
    type: 'Type in “{label}”',
    typeText: 'Type: {text}',
    enterHow: 'Type in the field and press Enter',
    enterHowText: 'Type “{text}” and press Enter',
    typeHowText: 'Type “{text}”, then press {nextKey}',
    open: 'Open {page}',
    openHow: 'Go to {url}',
    title: '{page} walkthrough',
    untitled: 'Recorded walkthrough',
  },
  zh: {
    click: '点击「{label}」',
    type: '在「{label}」里输入',
    typeText: '输入：{text}',
    enterHow: '在框里输入，然后按回车',
    enterHowText: '输入「{text}」，然后按回车',
    typeHowText: '输入「{text}」，然后按 {nextKey}',
    open: '打开 {page}',
    openHow: '跳到 {url}',
    title: '{page} 演示',
    untitled: '录制的演示',
  },
} as const

/** A navigation this soon after a click or an Enter is taken to be caused by it */
const CAUSED_MS = 4000
/** Clicks on the same element this close together are one click (double clicks, impatience) */
const SAME_CLICK_MS = 700

const say = (lang: Lang, key: keyof (typeof STRINGS)['en'], vars: Record<string, string>) =>
  (STRINGS[lang][key] as string).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const sameEl = (a: DomLocator[], b: DomLocator[]) => a.length > 0 && b.length > 0 && JSON.stringify(a[0]) === JSON.stringify(b[0])

/** Same page, ignoring the hash and query: what a wait step can match without being too picky. */
export function pageGlob(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname + '*'
  } catch {
    return url
  }
}

function pageName(url: string, title?: string) {
  if (title?.trim()) return short(title.trim())
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url
  }
}

/** Fold the raw stream into the actions worth a step each. */
function tidy(events: RecEvent[]): RecEvent[] {
  const out: RecEvent[] = []
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const prev = out[out.length - 1]
    if (e.k === 'click' && prev?.k === 'click' && sameEl(prev.locators, e.locators) && e.at - prev.at < SAME_CLICK_MS) continue
    if (e.k === 'type' && prev?.k === 'type' && sameEl(prev.locators, e.locators) && !prev.enter) {
      // Each report carries the whole field, so the later one wins.
      out[out.length - 1] = { ...e, at: prev.at }
      continue
    }
    // Clicking into a field and then typing there is one action: typing.
    if (e.k === 'type' && prev?.k === 'click' && sameEl(prev.locators, e.locators)) out.pop()
    if (e.k === 'nav' && prev?.k === 'nav' && prev.url === e.url) continue
    out.push(e)
  }
  return out
}

/** Steps for a recorded run, and where it started. */
export function stepsFromRecording(events: RecEvent[], lang: Lang): { steps: StepInput[]; startUrl?: string; startTitle?: string } {
  const evs = tidy(events)
  const steps: StepInput[] = []
  let startUrl: string | undefined
  let startTitle: string | undefined
  let cause: { at: number; step: StepInput | null; enter: boolean } | null = null
  for (const e of evs) {
    if (e.k === 'nav') {
      if (!steps.length && !cause) {
        startUrl ??= e.url
        startTitle = e.title
        continue
      }
      if (cause && e.at - cause.at < CAUSED_MS) {
        // Enter in a field took us to a new page: wait for that page instead of the hotkey.
        if (cause.enter && cause.step) {
          cause.step.act = 'wait'
          cause.step.until = { url: pageGlob(e.url), timeoutSecs: 120 }
        }
        cause = null
        continue
      }
      steps.push({ act: 'wait', say: '', tag: say(lang, 'open', { page: pageName(e.url, e.title) }), how: say(lang, 'openHow', { url: e.url }), until: { url: pageGlob(e.url) } })
      cause = null
      continue
    }
    startUrl ??= e.url
    if (e.k === 'click') {
      const step: StepInput = { act: 'click', say: '', ...(e.label ? { tag: say(lang, 'click', { label: short(e.label) }) } : {}), target: e.locators }
      steps.push(step)
      cause = { at: e.at, step, enter: false }
    } else {
      const text = e.text?.trim() ? short(e.text.trim()) : undefined
      const step: StepInput = {
        act: 'manual',
        say: '',
        tag: text ? say(lang, 'typeText', { text }) : say(lang, 'type', { label: short(e.label || '…') }),
        ...(e.enter ? { how: say(lang, text ? 'enterHowText' : 'enterHow', { text: text ?? '' }) } : text ? { how: say(lang, 'typeHowText', { text }) } : {}),
        target: e.locators,
      }
      steps.push(step)
      cause = { at: e.at, step, enter: e.enter }
    }
  }
  return { steps, startUrl, startTitle }
}

/** A whole draft storyboard from a recorded run; null when nothing worth a step was recorded. */
export function draftFromRecording(events: RecEvent[], opts: { lang: Lang; language?: string }): StoryboardInput | null {
  const { steps, startUrl, startTitle } = stepsFromRecording(events, opts.lang)
  if (!steps.length) return null
  const page = startTitle?.trim() || (startUrl ? pageName(startUrl) : '')
  return {
    cuelight: 1,
    title: page ? say(opts.lang, 'title', { page: short(page) }) : say(opts.lang, 'untitled', {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(startUrl && /^https?:/.test(startUrl) ? { start: { url: startUrl } } : {}),
    steps,
  }
}
