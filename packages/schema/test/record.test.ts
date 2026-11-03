import { describe, expect, it } from 'vitest'
import { draftFromRecording, howTo, parseStoryboard, stepsFromRecording, type DomLocator, type RecEvent } from '../src/index.ts'

const APP = 'https://demo.playwright.dev/todomvc/#/'
const input: DomLocator[] = [{ kind: 'dom', role: 'textbox', name: 'What needs to be done?' }]
const toggle: DomLocator[] = [{ kind: 'dom', role: 'checkbox', name: 'Toggle Todo', within: { testId: 'todo-item', text: { exact: 'Ship it' } } }]
const link = (name: string): DomLocator[] => [{ kind: 'dom', role: 'link', name }]

const run: RecEvent[] = [
  { k: 'nav', at: 0, url: APP, title: 'React • TodoMVC' },
  { k: 'click', at: 1000, url: APP, locators: input, label: 'What needs to be done?', role: 'textbox' },
  { k: 'type', at: 1500, url: APP, locators: input, label: 'What needs to be done?', role: 'textbox', chars: 4, enter: false },
  { k: 'type', at: 2500, url: APP, locators: input, label: 'What needs to be done?', role: 'textbox', chars: 7, enter: true },
  { k: 'click', at: 4000, url: APP, locators: toggle, label: 'Toggle Todo', role: 'checkbox' },
  { k: 'click', at: 4200, url: APP, locators: toggle, label: 'Toggle Todo', role: 'checkbox' },
  { k: 'click', at: 6000, url: APP, locators: link('Completed'), label: 'Completed', role: 'link' },
  { k: 'nav', at: 6100, url: APP + 'completed', title: 'React • TodoMVC' },
  { k: 'nav', at: 20000, url: 'https://example.com/docs?x=1#top', title: 'Docs' },
]

describe('draft from a recorded run', () => {
  it('makes one step per action: typing absorbs the click into the field, double clicks and caused navigations fold away', () => {
    const { steps, startUrl } = stepsFromRecording(run, 'en')
    expect(startUrl).toBe(APP)
    expect(steps.map((s) => s.act)).toEqual(['manual', 'click', 'click', 'wait'])
    expect(steps[0]).toEqual({ act: 'manual', say: '', tag: 'Type in “What needs to be done?”', how: 'Type in the field and press Enter', target: input })
    expect(steps[1]).toMatchObject({ tag: 'Click “Toggle Todo”', target: toggle })
    expect(steps[3]).toEqual({ act: 'wait', say: '', tag: 'Open Docs', how: 'Go to https://example.com/docs?x=1#top', until: { url: 'https://example.com/docs*' } })
  })

  it('waits for the page an Enter leads to, and keeps typed text only when it was recorded', () => {
    const evs: RecEvent[] = [
      { k: 'type', at: 0, url: 'https://shop.test/', locators: link('q'), label: 'Search', role: 'searchbox', chars: 6, text: 'chairs', enter: true },
      { k: 'nav', at: 900, url: 'https://shop.test/search?q=chairs', title: 'Results' },
    ]
    const [s] = stepsFromRecording(evs, 'zh').steps
    expect(s).toMatchObject({ act: 'wait', tag: '输入：chairs', how: '输入「chairs」，然后按回车', until: { url: 'https://shop.test/search*', timeoutSecs: 120 } })
  })

  it('builds a storyboard that plays as is, with the lines left to write', () => {
    const d = draftFromRecording(run, { lang: 'en', language: 'en' })!
    expect(d.title).toBe('React • TodoMVC walkthrough')
    expect(d.start).toEqual({ url: APP })
    expect(parseStoryboard(d).ok).toBe(true)
    expect(draftFromRecording([run[0]], { lang: 'en' })).toBeNull()
  })

  it('lets an author hint name the hotkey', () => {
    expect(howTo({ act: 'manual', say: '', how: 'Type, then press {nextKey}' }, 'en')).toBe('Type, then press ⌥⌘→')
  })
})
