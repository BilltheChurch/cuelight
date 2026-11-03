// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { DomLocator } from '@cuelight/schema'
import { accessibleName, resolveTarget, roleOf, type LocateEnv } from '../src/locate.ts'

// happy-dom has no layout, so "visible" means "not hidden by attribute or inline style".
const env: LocateEnv = {
  url: 'https://demo.playwright.dev/todomvc/#/',
  visible: (el) => !el.closest('[hidden]') && !(el as HTMLElement).style?.display?.includes('none'),
}
const find = (...locators: DomLocator[]) => resolveTarget(locators, env)

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
        <button class="clear-completed" hidden>Clear completed</button>
      </footer>
    </section>
    <div class="mw-heading"><h2 id="See_also">See also</h2></div>
    <ul><li><a href="/wiki/Cue_card">Cue card</a></li></ul>
    <label for="q">Search Wikipedia</label><input id="q" type="search">
    <div role="button" aria-labelledby="lbl"><span id="lbl">Analyse all wrong</span> (4)</div>
    <a href="#x" role="button">Fake link</a>
    <button>Analysing<span>…</span></button>`
})

describe('roles and names', () => {
  it('derives implicit roles', () => {
    expect(roleOf(document.querySelector('h1')!)).toBe('heading')
    expect(roleOf(document.querySelector('.new-todo')!)).toBe('textbox')
    expect(roleOf(document.querySelector('#q')!)).toBe('searchbox')
    expect(roleOf(document.querySelector('.toggle')!)).toBe('checkbox')
    expect(roleOf(document.querySelector('a[role=button]')!)).toBe('button')
  })
  it('computes accessible names', () => {
    expect(accessibleName(document.querySelector('.new-todo')!)).toBe('What needs to be done?')
    expect(accessibleName(document.querySelector('#q')!)).toBe('Search Wikipedia')
    expect(accessibleName(document.querySelector('.toggle')!)).toBe('Toggle Todo')
    expect(accessibleName(document.querySelector('[aria-labelledby]')!)).toBe('Analyse all wrong')
    expect(accessibleName(document.querySelector('a[href="#/completed"]')!)).toBe('Completed')
  })
})

describe('resolveTarget', () => {
  it('finds by test id, css, role + name and text', () => {
    expect(find({ kind: 'dom', testId: 'todo-count' })?.textContent).toBe('2 items left')
    expect(find({ kind: 'dom', css: '.todoapp h1' })?.textContent).toBe('todos')
    expect(find({ kind: 'dom', role: 'textbox', name: 'what needs' })?.className).toBe('new-todo')
    expect(find({ kind: 'dom', role: 'link', name: { exact: 'Completed' } })?.getAttribute('href')).toBe('#/completed')
    expect(find({ kind: 'dom', role: 'button', name: { re: '^Analyse all wrong' } })?.getAttribute('role')).toBe('button')
  })

  it('picks the innermost element for text', () => {
    expect(find({ kind: 'dom', text: 'rehearse THE demo' })?.tagName).toBe('LABEL')
    expect(find({ kind: 'dom', text: { exact: 'todos' } })?.tagName).toBe('H1')
    expect(find({ kind: 'dom', text: { re: '^\\d+ items left$' } })?.getAttribute('data-testid')).toBe('todo-count')
  })

  it('uses text as a has-text filter next to other fields', () => {
    const li = find({ kind: 'dom', testId: 'todo-item', text: { exact: 'Rehearse the demo' } })
    expect(li?.textContent).toContain('Rehearse')
    expect(li?.tagName).toBe('LI')
  })

  it('scopes with within and climbs with closest', () => {
    const box = find({ kind: 'dom', within: { testId: 'todo-item', text: 'Rehearse' }, role: 'checkbox', name: 'Toggle Todo' })
    expect(box?.closest('li')?.textContent).toContain('Rehearse the demo')
    expect(find({ kind: 'dom', text: 'Write the storyboard', closest: 'li' })?.tagName).toBe('LI')
  })

  it('supports :has() selectors from real storyboards', () => {
    expect(find({ kind: 'dom', css: '.mw-heading:has(#See_also) + ul a[href$="/wiki/Cue_card"]' })?.textContent).toBe('Cue card')
  })

  it('skips hidden matches, falls back down the chain, and respects url and nth', () => {
    expect(find({ kind: 'dom', role: 'button', name: 'Clear completed' })).toBeNull()
    expect(find({ kind: 'dom', css: '.nope' }, { kind: 'dom', testId: 'todo-title', nth: 1 })?.textContent).toBe('Rehearse the demo')
    expect(find({ kind: 'dom', url: 'https://en.wikipedia.org/*', css: 'h1' })).toBeNull()
    expect(find({ kind: 'dom', url: 'https://demo.playwright.dev/todomvc/*', css: 'h1' })?.textContent).toBe('todos')
    expect(find({ kind: 'dom', css: '((bad selector' })).toBeNull()
  })
})
