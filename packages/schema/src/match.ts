import type { Rect, TextMatch } from './storyboard.ts'

export const normalizeSpace = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Compile a TextMatch into a predicate over (already whitespace-normalized) text. */
export function textMatcher(m: TextMatch): (text: string) => boolean {
  if (typeof m === 'string') {
    const needle = normalizeSpace(m).toLowerCase()
    return (t) => t.toLowerCase().includes(needle)
  }
  if ('exact' in m) {
    const want = normalizeSpace(m.exact)
    return (t) => t === want
  }
  const re = new RegExp(m.re, (m.flags ?? '').replace('g', ''))
  return (t) => re.test(t)
}

/** A cheap pre-filter for pruning a DOM walk: could an element containing `text` match? */
export function mightContain(m: TextMatch): (text: string) => boolean {
  if (typeof m === 'string') return textMatcher(m)
  if ('exact' in m) {
    const needle = normalizeSpace(m.exact)
    return (t) => t.includes(needle)
  }
  return () => true
}

/** Glob with `*` wildcards, anchored at both ends. A pattern with no `*` must equal the URL. */
export function urlMatches(pattern: string, url: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(url)
}

export const inflate = ([x, y, w, h]: Rect, d: number): Rect => [x - d, y - d, w + 2 * d, h + 2 * d]

export const contains = ([x, y, w, h]: Rect, px: number, py: number) => px >= x && px <= x + w && py >= y && py <= y + h

export const center = ([x, y, w, h]: Rect) => ({ x: x + w / 2, y: y + h / 2 })
