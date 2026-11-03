import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  cue,
  formatJson,
  howKind,
  parseStoryboard,
  placeCard,
  readSecs,
  speechUnits,
  spotlightRect,
  textMatcher,
  urlMatches,
} from '../src/index.ts'

const examplesDir = new URL('../../../examples/', import.meta.url)

describe('storyboard schema', () => {
  it('accepts every bundled example', () => {
    const files = readdirSync(examplesDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const r = parseStoryboard(JSON.parse(readFileSync(new URL(f, examplesDir), 'utf8')))
      expect(r.ok ? [] : r.issues, f).toEqual([])
    }
  })

  it('fills defaults', () => {
    const r = parseStoryboard({ cuelight: 1, title: 't', steps: [{ act: 'manual' }] })
    expect(r.ok && r.value.steps[0].say).toBe('')
  })

  it('takes every locator kind in one fallback chain', () => {
    const r = parseStoryboard({
      cuelight: 1,
      title: 't',
      steps: [
        {
          act: 'click',
          say: 'Export',
          target: [
            { kind: 'dom', testId: 'export' },
            { kind: 'dom', role: 'button', name: { re: '^Export', flags: 'i' } },
            { kind: 'ax', app: 'com.figma.Desktop', role: 'AXButton', title: 'Export' },
            { kind: 'visual', app: 'com.figma.Desktop', text: 'Export' },
            { kind: 'region', rect: [0.8, 0.9, 0.1, 0.05], units: 'fraction' },
          ],
        },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const region = r.value.steps[0].target![4]
      expect(region.kind === 'region' && region.relativeTo).toBe('screen')
    }
  })

  it('rejects broken steps with readable paths', () => {
    const r = parseStoryboard({
      cuelight: 1,
      title: 't',
      steps: [
        { act: 'click', say: 'no target' },
        { act: 'wait' },
        { act: 'read', target: [{ kind: 'dom' }] },
        { act: 'read', target: [{ kind: 'dom', text: { re: '(' } }] },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.issues.some((i) => i.startsWith('steps.0.target'))).toBe(true)
      expect(r.issues.some((i) => i.startsWith('steps.1.until'))).toBe(true)
      expect(r.issues.some((i) => i.startsWith('steps.2.target.0'))).toBe(true)
      expect(r.issues.some((i) => i.includes('invalid regular expression'))).toBe(true)
    }
  })

  it('rejects unknown versions', () => {
    expect(parseStoryboard({ cuelight: 2, title: 't', steps: [{ act: 'manual' }] }).ok).toBe(false)
  })
})

describe('pacing', () => {
  it('counts English words and CJK characters', () => {
    expect(speechUnits('Twenty out of twenty. Submit.')).toBe(5)
    expect(speechUnits('先说完这句')).toBe(2.5)
    expect(speechUnits('打开 Mocks 页面')).toBe(3)
    expect(speechUnits('  \u2014 ')).toBe(0)
  })
  it('matches the prototype timing: 2 words/s + 1.2 s, at least 2.5 s', () => {
    expect(readSecs({ say: 'Submit.' })).toBe(2.5)
    expect(readSecs({ say: 'Sixteen out of twenty.' })).toBeCloseTo(3.2)
    expect(readSecs({ say: 'Three modes. Training: untimed, with solutions straight away.' })).toBeCloseTo(8 / 2 + 1.2)
    expect(readSecs({ say: 'x', secs: 9 })).toBe(9)
  })
})

describe('cues', () => {
  it('says how to do each step', () => {
    expect(howKind({ act: 'click', say: 'Hi' })).toBe('say-then-click')
    expect(howKind({ act: 'click', say: '' })).toBe('click')
    expect(howKind({ act: 'read', say: 'x', target: [{ kind: 'dom', css: 'h1' }] })).toBe('read')
    expect(howKind({ act: 'read', say: 'x' })).toBe('read-free')
    expect(cue('zh', 'how.say-then-click')).toBe('先说完这句，再点')
    expect(cue('en', 'how.manual')).toBe('Press ⌥⌘→ when you are done')
    expect(cue('en', 'preroll.tag', { title: 'Demo', n: 3 })).toBe('Demo · 3 steps')
  })
})

describe('matching', () => {
  it('text matches', () => {
    expect(textMatcher('fast AND right')('Fast and right answers')).toBe(true)
    expect(textMatcher({ exact: 'Why you got it wrong' })('Why you got it wrong')).toBe(true)
    expect(textMatcher({ exact: 'Why' })('Why you got it wrong')).toBe(false)
    expect(textMatcher({ re: '^\\s*F\\.', flags: 'g' })('F. 12')).toBe(true)
  })
  it('url globs', () => {
    expect(urlMatches('https://demo.playwright.dev/todomvc/*', 'https://demo.playwright.dev/todomvc/#/active')).toBe(true)
    expect(urlMatches('https://en.wikipedia.org/wiki/Teleprompter', 'https://en.wikipedia.org/wiki/Teleprompter')).toBe(true)
    expect(urlMatches('https://en.wikipedia.org/wiki/Teleprompter', 'https://en.wikipedia.org/wiki/Teleprompter2')).toBe(false)
    expect(urlMatches('*://*.example.com/a?b=*', 'https://x.example.com/a?b=1')).toBe(true)
  })
})

describe('geometry', () => {
  const vp = { originX: 100, originY: 200, zoom: 1.25, width: 800, height: 600 }
  it('maps viewport boxes to screen points with page zoom', () => {
    expect(spotlightRect({ x: 10, y: 20, w: 100, h: 40 }, vp)).toEqual({ rect: [112.5, 225, 125, 50], offscreen: null })
  })
  it('clips to the viewport', () => {
    expect(spotlightRect({ x: -50, y: 580, w: 100, h: 100 }, vp).rect).toEqual([100, 925, 62.5, 25])
  })
  it('turns off-screen targets into an edge strip with a direction', () => {
    expect(spotlightRect({ x: 10, y: 2000, w: 10, h: 10 }, vp)).toEqual({ rect: [140, 880, 920, 56], offscreen: 'below' })
    expect(spotlightRect({ x: 10, y: -300, w: 10, h: 10 }, vp).offscreen).toBe('above')
  })
  it('places the card below, above, right, then left of the light', () => {
    const scr = { w: 1440, h: 900, top: 38 }
    const card = { w: 400, h: 150 }
    expect(placeCard([500, 100, 200, 40], card, scr)).toEqual({ x: 400, y: 162 })
    expect(placeCard([500, 700, 200, 40], card, scr)).toEqual({ x: 400, y: 528 })
    expect(placeCard([100, 50, 200, 800], card, scr)).toEqual({ x: 322, y: 375 })
    expect(placeCard([900, 50, 500, 800], card, scr)).toEqual({ x: 478, y: 375 })
    expect(placeCard(null, card, scr)).toEqual({ x: 520, y: 54 })
    expect(placeCard(null, card, scr, 'bottom')).toEqual({ x: 520, y: 660 })
  })
})

describe('formatJson', () => {
  it('keeps short objects on one line and opens long ones', () => {
    const out = formatJson({ a: 1, list: [{ kind: 'dom', css: 'x' }], long: 'y'.repeat(150) }, 60)
    expect(out).toBe(`{\n  "a": 1,\n  "list": [{ "kind": "dom", "css": "x" }],\n  "long": "${'y'.repeat(150)}"\n}\n`)
    expect(formatJson({ a: [], b: {} })).toBe('{ "a": [], "b": {} }\n')
  })

  it('round-trips every bundled example', () => {
    for (const f of readdirSync(examplesDir)) {
      const src = readFileSync(new URL(f, examplesDir), 'utf8')
      expect(JSON.parse(formatJson(JSON.parse(src)))).toEqual(JSON.parse(src))
    }
  })
})
