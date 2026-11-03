/**
 * Resolve DOM locators to an element. Priority inside one locator follows how stable each
 * signal tends to be: test id, then CSS, then ARIA role (+ accessible name), then visible text.
 * Several fields narrow each other down. A storyboard step lists locators as a fallback chain.
 */
import { mightContain, normalizeSpace, textMatcher, urlMatches, type DomLocator, type DomQuery, type TextMatch } from '@cuelight/schema'

export const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG'])

export type LocateEnv = {
  url: string
  visible: (el: Element) => boolean
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  if ('checkVisibility' in el) return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
  const s = getComputedStyle(el)
  return s.visibility !== 'hidden' && s.display !== 'none'
}

export const pageEnv = (): LocateEnv => ({ url: location.href, visible: isVisible })

export function resolveTarget(locators: DomLocator[], env: LocateEnv, doc: Document = document): Element | null {
  for (const l of locators) {
    if (l.url && !urlMatches(l.url, env.url)) continue
    let root: ParentNode = doc
    if (l.within) {
      const scope = query(doc, l.within, env)
      if (!scope) continue
      root = scope
    }
    const el = query(root, l, env)
    if (el) return el
  }
  return null
}

export function query(root: ParentNode, q: DomQuery, env: LocateEnv): Element | null {
  let el: Element | null = queryAll(root, q, env)[q.nth ?? 0] ?? null
  if (el && q.closest) el = el.closest(q.closest)
  return el
}

/** Every visible match of a query, in document order, before `nth` and `closest` apply. */
export function queryAll(root: ParentNode, q: DomQuery, env: LocateEnv): Element[] {
  let found: Element[]
  if (q.testId) found = byTestId(root, q.testId)
  else if (q.css) found = safeAll(root, q.css)
  else if (q.role) found = byRole(root, q.role)
  else found = byText(root, q.text!)

  if (q.testId && q.css) found = found.filter((e) => safeMatches(e, q.css!))
  if (q.role && (q.testId || q.css)) found = found.filter((e) => roleOf(e) === q.role)
  if (q.name) {
    const m = textMatcher(q.name)
    found = found.filter((e) => m(accessibleName(e)))
  }
  if (q.text && (q.testId || q.css || q.role)) {
    const m = textMatcher(q.text)
    found = found.filter((e) => m(textOf(e)))
  }
  return found.filter(env.visible)
}

export const textOf = (e: Element) => normalizeSpace(e.textContent ?? '')

function safeAll(root: ParentNode, css: string): Element[] {
  try {
    return [...root.querySelectorAll(css)]
  } catch {
    return []
  }
}

function safeMatches(e: Element, css: string): boolean {
  try {
    return e.matches(css)
  } catch {
    return false
  }
}

function byTestId(root: ParentNode, id: string): Element[] {
  const v = CSS.escape(id)
  return safeAll(root, TEST_ID_ATTRS.map((a) => `[${a}="${v}"]`).join(','))
}

/** Innermost elements whose text matches. Prunes subtrees that cannot contain the text. */
function byText(root: ParentNode, m: TextMatch): Element[] {
  const full = textMatcher(m)
  const pre = typeof m === 'object' && 're' in m ? null : mightContain(m)
  const out: Element[] = []
  const visit = (e: Element): boolean => {
    if (SKIP.has(e.tagName.toUpperCase())) return false
    const t = textOf(e)
    if (!t || (pre && !pre(t))) return false
    let child = false
    for (const c of e.children) if (visit(c)) child = true
    if (!child && full(t)) {
      out.push(e)
      return true
    }
    return child
  }
  for (const c of root.children) visit(c)
  return out
}

// ---------------------------------------------------------------- ARIA roles and names (the common subset)

const ROLE_TAGS: Record<string, string> = {
  button: 'button,input[type=button],input[type=submit],input[type=reset],input[type=image],summary',
  link: 'a[href],area[href]',
  textbox: 'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],textarea',
  searchbox: 'input[type=search]',
  checkbox: 'input[type=checkbox]',
  radio: 'input[type=radio]',
  slider: 'input[type=range]',
  spinbutton: 'input[type=number]',
  combobox: 'select,input[list]',
  listbox: 'select[multiple],select[size]',
  heading: 'h1,h2,h3,h4,h5,h6',
  img: 'img',
  list: 'ul,ol,menu',
  listitem: 'li',
  navigation: 'nav',
  main: 'main',
  complementary: 'aside',
  banner: 'header',
  contentinfo: 'footer',
  form: 'form',
  dialog: 'dialog',
  table: 'table',
  row: 'tr',
  cell: 'td',
  columnheader: 'th',
  option: 'option',
  progressbar: 'progress',
  figure: 'figure',
  article: 'article',
  separator: 'hr',
  region: 'section[aria-label],section[aria-labelledby]',
}

function byRole(root: ParentNode, role: string): Element[] {
  const tags = ROLE_TAGS[role]
  const sel = `[role~="${CSS.escape(role)}"]` + (tags ? ',' + tags : '')
  return safeAll(root, sel).filter((e) => roleOf(e) === role)
}

export function roleOf(e: Element): string | null {
  const explicit = e.getAttribute('role')?.trim().split(/\s+/)[0]
  if (explicit) return explicit
  const tag = e.tagName.toLowerCase()
  switch (tag) {
    case 'a':
    case 'area':
      return e.hasAttribute('href') ? 'link' : null
    case 'button':
    case 'summary':
      return 'button'
    case 'input': {
      const type = (e.getAttribute('type') ?? 'text').toLowerCase()
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'hidden') return null
      if (e.hasAttribute('list')) return 'combobox'
      return type === 'search' ? 'searchbox' : 'textbox'
    }
    case 'textarea':
      return 'textbox'
    case 'select':
      return e.hasAttribute('multiple') || Number(e.getAttribute('size')) > 1 ? 'listbox' : 'combobox'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'img':
      return e.getAttribute('alt') === '' ? 'presentation' : 'img'
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list'
    case 'section':
      return e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') ? 'region' : null
    default: {
      const simple: Record<string, string> = {
        li: 'listitem', nav: 'navigation', main: 'main', aside: 'complementary', header: 'banner', footer: 'contentinfo',
        form: 'form', dialog: 'dialog', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', option: 'option',
        progress: 'progressbar', figure: 'figure', article: 'article', hr: 'separator',
      }
      return simple[tag] ?? null
    }
  }
}

const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'checkbox', 'radio', 'option', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'switch', 'tooltip', 'listitem', 'row',
])

export function accessibleName(e: Element): string {
  const doc = e.ownerDocument
  const labelledby = e.getAttribute('aria-labelledby')
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ')
    if (normalizeSpace(t)) return normalizeSpace(t)
  }
  const label = e.getAttribute('aria-label')
  if (label && normalizeSpace(label)) return normalizeSpace(label)

  const tag = e.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = (e.getAttribute('type') ?? '').toLowerCase()
    if (['button', 'submit', 'reset'].includes(type)) return normalizeSpace((e as HTMLInputElement).value || type)
    if (type === 'image') return normalizeSpace(e.getAttribute('alt') ?? '')
    const id = e.getAttribute('id')
    const lab = (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) || e.closest('label')
    if (lab && textOf(lab)) return textOf(lab)
    const ph = e.getAttribute('placeholder') ?? e.getAttribute('title')
    if (ph) return normalizeSpace(ph)
  }
  if (tag === 'img' || tag === 'area') {
    const alt = e.getAttribute('alt')
    if (alt) return normalizeSpace(alt)
  }
  const role = roleOf(e)
  if (role && NAME_FROM_CONTENT.has(role)) {
    const t = textOf(e)
    if (t) return t
  }
  return normalizeSpace(e.getAttribute('title') ?? '')
}
