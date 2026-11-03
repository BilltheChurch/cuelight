// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveTarget, type LocateEnv } from '../src/locate.ts'
import { describe as label, pickable, stableToken, suggestLocators } from '../src/suggest.ts'

const env: LocateEnv = {
  url: 'https://demo.playwright.dev/todomvc/#/',
  visible: (el) => !el.closest('[hidden]'),
}
const $ = (css: string, i = 0) => document.querySelectorAll(css)[i]!
const suggest = (el: Element) => suggestLocators(el, env)

beforeEach(() => {
  document.body.innerHTML = `
    <section class="todoapp">
      <header class="header"><h1>todos</h1><input class="new-todo" placeholder="What needs to be done?"></header>
      <ul class="todo-list">
        <li data-testid="todo-item"><div class="view"><input aria-label="Toggle Todo" class="toggle" type="checkbox"><label data-testid="todo-title">Write the storyboard</label><button aria-label="Delete" class="destroy"></button></div></li>
        <li data-testid="todo-item"><div class="view"><input aria-label="Toggle Todo" class="toggle" type="checkbox"><label data-testid="todo-title">Rehearse the demo</label><button aria-label="Delete" class="destroy"></button></div></li>
      </ul>
      <footer class="footer"><span data-testid="todo-count"><strong>2</strong> items left</span>
        <ul class="filters"><li><a href="#/">All</a></li><li><a href="#/active">Active</a></li><li><a href="#/completed">Completed</a></li></ul>
      </footer>
    </section>
    <div class="mw-heading"><h2 id="See_also">See also</h2></div>
    <ul><li><a href="/wiki/Cue_card">Cue card</a></li></ul>
    <button id=":r7:" class="css-1x2y3z"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg><span>Star</span></button>
    <div class="cards"><div class="css-a1b2c3"></div><div class="css-d4e5f6"></div></div>`
})

describe('suggestLocators', () => {
  it('prefers a unique role and accessible name, then a stable class', () => {
    const el = $('.new-todo')
    const ls = suggest(el)
    expect(ls[0]).toEqual({ kind: 'dom', role: 'textbox', name: 'What needs to be done?' })
    expect(ls.some((l) => l.css === 'input.new-todo')).toBe(true)
  })

  it('scopes a repeated control to its own list item instead of counting with nth', () => {
    const el = $('.toggle', 1)
    const [first] = suggest(el)
    expect(first).toEqual({
      kind: 'dom',
      role: 'checkbox',
      name: 'Toggle Todo',
      within: { testId: 'todo-item', text: { exact: 'Rehearse the demo' } },
    })
    const del = suggest($('.destroy', 1))[0]
    expect(del.role).toBe('button')
    expect(del.within).toEqual({ testId: 'todo-item', text: { exact: 'Rehearse the demo' } })
  })

  it('uses a unique test id first', () => {
    expect(suggest($('[data-testid=todo-count]'))[0]).toEqual({ kind: 'dom', testId: 'todo-count' })
  })

  it('offers one locator per kind of signal, every one resolving back to the element', () => {
    for (const el of [$('.new-todo'), $('.toggle', 1), $('#See_also'), $('a[href="/wiki/Cue_card"]'), $('.filters a', 2), $('.cards > div', 1), $('button', 2)]) {
      const ls = suggest(el)
      expect(ls.length).toBeGreaterThan(0)
      for (const l of ls) expect(resolveTarget([l], env)).toBe(el)
    }
    const h2 = suggest($('#See_also'))
    expect(h2.map((l) => Object.keys(l).filter((k) => k !== 'kind').join('+'))).toEqual(['role+name', 'css', 'text'])
  })

  it('skips generated ids and classes, falling back to a CSS path', () => {
    const ls = suggest($('.cards > div', 1))
    expect(ls).toEqual([{ kind: 'dom', css: 'div.cards > div:nth-of-type(2)' }])
    const star = suggest($('button', 2))
    expect(star[0]).toEqual({ kind: 'dom', role: 'button', name: 'Star' })
    expect(JSON.stringify(star)).not.toMatch(/r7|css-1x2y3z/)
  })
})

describe('picking helpers', () => {
  it('turns a hover on an icon into the button around it', () => {
    expect(pickable($('path'))).toBe($('button', 2))
    expect(pickable($('[data-testid=todo-count] strong'))).toBe($('[data-testid=todo-count]'))
    expect(pickable($('.cards'))).toBe($('.cards'))
  })

  it('labels elements by name or text', () => {
    expect(label($('.toggle'))).toEqual({ label: 'Toggle Todo', role: 'checkbox' })
    expect(label($('.new-todo')).label).toBe('What needs to be done?')
  })

  it('tells stable tokens from generated ones', () => {
    expect(['new-todo', 'col-6', 'See_also', 'todoapp'].every(stableToken)).toBe(true)
    expect([':r7:', 'css-1x2y3z', 'sc-bdVaJa', 'jsx-3482', 'Button_root__a8f2k'].some(stableToken)).toBe(false)
  })
})
