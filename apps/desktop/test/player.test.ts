import { describe, expect, it } from 'vitest'
import { parseStoryboard, type Locator, type Rect, type StoryboardInput, type WebTarget } from '@cuelight/schema'
import { Player, type PlayerEvent } from '../src/main/player.ts'
import type { OverlayCard } from '../src/shared/types.ts'

type Local = (l: Locator) => Rect | null | 'unsupported' | 'denied'
const regionsOnly: Local = (l) => (l.kind === 'region' ? [l.rect[0], l.rect[1], l.rect[2], l.rect[3]] : 'unsupported')

function rig(input: StoryboardInput, opts: { connected?: boolean; local?: Local } = {}) {
  const r = parseStoryboard(input)
  if (!r.ok) throw new Error(r.issues.join('\n'))
  let now = 1000
  const log: PlayerEvent[] = []
  const targets: (WebTarget | null)[] = []
  const cards: (OverlayCard | null)[] = []
  const lights: unknown[] = []
  const progress: (number | null)[] = []
  const navigations: string[] = []
  const activated: string[] = []
  let hidden = false
  const p = new Player({
    overlay: {
      show() {},
      hide() {},
      toggle: () => (hidden = !hidden),
      card: (c) => cards.push(c),
      light: (l) => lights.push(l),
      inside() {},
      progress: (v) => progress.push(v),
    },
    web: {
      target: (t) => targets.push(t),
      navigate: (u) => navigations.push(u),
      status() {},
      connected: () => opts.connected ?? true,
    },
    local: opts.local ?? regionsOnly,
    activate: (a) => activated.push(a),
    lang: () => 'en',
    now: () => now,
    onEvent: (e) => log.push(e),
  })
  p.load(r.value)
  const run = (ms: number, cursor = { x: 0, y: 0 }) => {
    for (let t = 0; t < ms; t += 16) {
      now += 16
      p.tick(cursor)
    }
  }
  return { p, log, targets, cards, lights, progress, navigations, activated, run, advance: () => log.filter((e) => e.type === 'advance'), last: () => cards.at(-1) }
}

const dom = (css: string) => [{ kind: 'dom' as const, css }]

describe('Player', () => {
  it('waits in the preroll for the hotkey, then walks click and read steps', () => {
    const r = rig({
      cuelight: 1,
      title: 'T',
      start: { url: 'https://example.com/' },
      steps: [
        { act: 'click', say: 'Open the menu.', tag: 'Click Menu', target: dom('#menu') },
        { act: 'read', say: 'Six words to read out loud here.', target: dom('h1') },
        { act: 'manual', say: 'Bye.' },
      ],
    })
    r.p.start()
    expect(r.p.phase).toBe('preroll')
    expect(r.navigations).toEqual(['https://example.com/'])
    expect(r.last()?.kind).toBe('preroll')
    expect(r.last()?.next).toBe('Next: Open the menu.')
    r.run(2000)
    expect(r.p.phase).toBe('preroll')

    r.p.next()
    const t1 = r.targets.at(-1)!
    expect(t1).toMatchObject({ act: 'click', locators: [{ css: '#menu' }] })
    expect(r.last()).toMatchObject({ n: 1, total: 3, tag: 'Click Menu', how: 'Finish the line, then click', next: 'Next: Six words to read out loud here.' })

    // A click from an older step is ignored; a click on this one advances after a short settle.
    r.p.onWeb({ t: 'click', seq: t1.seq - 1 })
    r.run(500)
    expect(r.p.i).toBe(0)
    r.p.onWeb({ t: 'rect', seq: t1.seq, rect: [100, 100, 80, 30], found: true, offscreen: null, url: 'https://example.com/' })
    r.p.onWeb({ t: 'click', seq: t1.seq })
    r.run(100)
    expect(r.p.i).toBe(0)
    r.run(300)
    expect(r.p.i).toBe(1)

    // Read: the bar only fills while the cursor is in the light. 7 words → 3.5 + 1.2 = 4.7 s.
    const t2 = r.targets.at(-1)!
    r.p.onWeb({ t: 'rect', seq: t2.seq, rect: [200, 200, 300, 60], found: true, offscreen: null, url: '' })
    r.run(3000, { x: 10, y: 10 })
    expect(r.p.i).toBe(1)
    r.run(2000, { x: 300, y: 230 })
    expect(r.p.i).toBe(1)
    r.run(3000, { x: 301, y: 230 })
    expect(r.p.i).toBe(2)
    expect(r.advance().map((e) => e.type === 'advance' && e.reason)).toEqual(['click', 'read'])

    // Manual step: only the hotkey moves on; the last step leads to the done card.
    expect(r.targets.at(-1)).toBeNull()
    r.run(10000)
    expect(r.p.i).toBe(2)
    r.p.next()
    expect(r.p.phase).toBe('done')
    r.p.next()
    expect(r.p.phase).toBe('idle')
  })

  it('counts a pointer the page saw when the OS cursor did not move (injected input)', () => {
    const r = rig({ cuelight: 1, title: 'T', steps: [{ act: 'read', say: 'Hi', target: dom('h1') }, { act: 'manual' }] })
    r.p.start()
    r.p.next()
    const t = r.targets.at(-1)!
    r.p.onWeb({ t: 'rect', seq: t.seq, rect: [0, 100, 100, 40], found: true, offscreen: null, url: '' })
    r.run(200, { x: 900, y: 900 })
    r.p.onWeb({ t: 'pointer', seq: t.seq, inside: true })
    r.run(2600, { x: 900, y: 900 })
    expect(r.p.i).toBe(1)
  })

  it('does not run the read timer while the target is off screen, and hints the scroll direction', () => {
    const r = rig({ cuelight: 1, title: 'T', steps: [{ act: 'read', say: 'Hi', target: dom('footer') }, { act: 'manual' }] })
    r.p.start()
    r.p.next()
    const t = r.targets.at(-1)!
    r.p.onWeb({ t: 'rect', seq: t.seq, rect: [40, 900, 1000, 56], found: true, offscreen: 'below', url: '' })
    expect(r.last()?.hintKind).toBe('scroll-down')
    r.run(5000, { x: 500, y: 920 })
    expect(r.p.i).toBe(0)
    r.p.onWeb({ t: 'rect', seq: t.seq, rect: [40, 500, 1000, 56], found: true, offscreen: null, url: '' })
    expect(r.last()?.hintKind).toBeNull()
    r.run(3000, { x: 500, y: 520 })
    expect(r.p.i).toBe(1)
  })

  it('skips an optional step whose target never shows up, in the direction of travel', () => {
    const r = rig({
      cuelight: 1,
      title: 'T',
      steps: [{ act: 'manual' }, { act: 'click', target: dom('.discard'), optional: true }, { act: 'manual' }],
    })
    r.p.start()
    r.p.next()
    r.p.next()
    expect(r.p.i).toBe(1)
    r.run(3200)
    expect(r.p.i).toBe(2)
    r.p.prev()
    expect(r.p.i).toBe(1)
    r.run(3200)
    expect(r.p.i).toBe(0)
  })

  it('finishes wait steps on the until signal, a timeout, or fixed seconds', () => {
    const r = rig({
      cuelight: 1,
      title: 'T',
      steps: [
        { act: 'wait', until: { appear: dom('.done'), timeoutSecs: 60 } },
        { act: 'wait', until: { url: 'https://x/*', timeoutSecs: 2 } },
        { act: 'wait', secs: 1 },
        { act: 'manual' },
      ],
    })
    r.p.start()
    r.p.next()
    const t = r.targets.at(-1)!
    expect(t.until?.appear).toEqual(dom('.done'))
    r.p.onWeb({ t: 'until', seq: t.seq })
    expect(r.p.i).toBe(1)
    r.run(2100)
    expect(r.p.i).toBe(2)
    r.run(1100)
    expect(r.p.i).toBe(3)
    expect(r.advance().map((e) => e.type === 'advance' && e.reason)).toEqual(['until', 'timeout', 'secs'])
  })

  it('uses a region fallback when the page does not have the element, and says when the browser is missing', () => {
    const r = rig(
      {
        cuelight: 1,
        title: 'T',
        steps: [
          { act: 'read', say: 'Hi', target: [{ kind: 'dom', css: '#x' }, { kind: 'region', rect: [10, 20, 30, 40] }] },
          { act: 'read', say: 'Hi', target: dom('#y') },
          { act: 'read', say: 'Hi', target: [{ kind: 'ax', app: 'com.apple.finder', role: 'AXButton' }] },
        ],
      },
      { connected: false },
    )
    r.p.start()
    r.p.next()
    const t = r.targets.at(-1)!
    r.p.onWeb({ t: 'rect', seq: t.seq, rect: null, found: false, offscreen: null, url: '' })
    expect(r.lights.at(-1)).toEqual([10, 20, 30, 40])
    r.p.next()
    expect(r.last()?.hintKind).toBe('no-browser')
    r.p.next()
    expect(r.last()?.hintKind).toBe('unsupported')
  })

  it('reads talk-only steps without a cursor and drops stale rects', () => {
    const r = rig({ cuelight: 1, title: 'T', card: 'bottom', steps: [{ act: 'read', say: 'One two three.' }, { act: 'manual' }] })
    r.p.start()
    r.p.next()
    expect(r.last()).toMatchObject({ kind: 'read-free', placement: 'bottom' })
    r.p.onWeb({ t: 'rect', seq: 999, rect: [0, 0, 10, 10], found: true, offscreen: null, url: '' })
    expect(r.lights.at(-1)).toBeNull()
    r.run(2700)
    expect(r.p.i).toBe(1)
  })

  it('rehearses one step without a preroll, reports its time, and stops', () => {
    const r = rig({
      cuelight: 1,
      title: 'T',
      start: { url: 'https://example.com/' },
      steps: [
        { act: 'read', say: 'First.' },
        { act: 'click', say: 'Six words to read out loud here.', target: dom('#go') },
        { act: 'manual', say: 'Bye.' },
      ],
    })
    r.p.start(1, { single: true })
    expect(r.p.phase).toBe('step')
    expect(r.p.i).toBe(1)
    expect(r.navigations).toEqual([])
    r.p.prev()
    expect(r.p.i).toBe(1)
    const t = r.targets.at(-1)!
    r.run(1984)
    r.p.onWeb({ t: 'rect', seq: t.seq, rect: [100, 100, 80, 30], found: true, offscreen: null, url: 'https://example.com/' })
    r.p.onWeb({ t: 'click', seq: t.seq })
    r.run(300)
    expect(r.p.phase).toBe('idle')
    const done = r.log.find((e) => e.type === 'rehearsed')
    expect(done).toMatchObject({ type: 'rehearsed', n: 2, reason: 'click', est: 4.7 })
    expect(done?.type === 'rehearsed' && done.secs).toBeCloseTo(2.256, 1)
    expect(r.advance()).toHaveLength(1)

    // A normal run afterwards gets its preroll back.
    r.p.start(0)
    expect(r.p.phase).toBe('preroll')
  })

  it('follows a target in a desktop app as it moves, and advances on a click inside it', () => {
    let where: Rect | null = null
    const r = rig(
      {
        cuelight: 1,
        title: 'T',
        start: { app: 'com.example.notes' },
        steps: [
          { act: 'click', say: 'New note.', target: [{ kind: 'ax', app: 'com.example.notes', role: 'AXButton', title: 'New Note' }] },
          { act: 'click', say: 'In the page.', target: dom('#go') },
        ],
      },
      { local: (l) => (l.kind === 'ax' ? where : 'unsupported') },
    )
    r.p.start()
    expect(r.activated).toEqual(['com.example.notes'])
    r.p.next()
    expect(r.p.wantsOsClicks).toBe(true)
    // Not there yet: the helper is still looking.
    r.run(100)
    expect(r.lights.at(-1)).toBeNull()
    expect(r.last()?.hintKind).toBe('waiting-page')
    where = [100, 100, 30, 30]
    r.run(32)
    expect(r.lights.at(-1)).toEqual([100, 100, 30, 30])
    expect(r.last()?.hintKind).toBeNull()
    const n = r.lights.length
    r.run(100)
    expect(r.lights).toHaveLength(n)
    where = [200, 100, 30, 30]
    r.run(16)
    expect(r.lights.at(-1)).toEqual([200, 100, 30, 30])

    // A click somewhere else does nothing; one inside the light (padding included) advances.
    r.p.osClick(120, 110)
    r.run(400)
    expect(r.p.i).toBe(0)
    r.p.osClick(195, 95)
    r.run(300)
    expect(r.p.i).toBe(1)
    expect(r.advance().at(-1)).toMatchObject({ from: 1, reason: 'click' })
    // Page steps take their clicks from the extension, not the OS.
    expect(r.p.wantsOsClicks).toBe(false)
    r.p.osClick(10, 10)
    r.run(300)
    expect(r.p.i).toBe(1)
  })

  it('drops the light when a desktop target goes away, and asks for permission when the system says no', () => {
    let where: Rect | null | 'denied' = [10, 10, 50, 20]
    const r = rig(
      { cuelight: 1, title: 'T', steps: [{ act: 'read', say: 'Look here.', target: [{ kind: 'ax', app: 'a.b', title: 'X' }] }] },
      { local: () => where },
    )
    r.p.start(0, { single: true })
    expect(r.lights.at(-1)).toEqual([10, 10, 50, 20])
    where = null
    r.run(16)
    expect(r.lights.at(-1)).toBeNull()
    where = 'denied'
    r.run(16)
    expect(r.last()?.hintKind).toBe('no-permission')
    expect(r.last()?.hint).toBe('Allow Cuelight in System Settings, Privacy & Security first. Press ⌥⌘→ to skip')
  })

  it('unloads a storyboard that no longer validates', () => {
    const r = rig({ cuelight: 1, title: 'T', steps: [{ act: 'manual', say: 'Hi' }] })
    r.p.unload()
    r.p.start()
    expect(r.p.phase).toBe('idle')
  })
})
