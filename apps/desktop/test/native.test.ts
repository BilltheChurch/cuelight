import { describe, expect, it } from 'vitest'
import type { AxLocator, Rect, RegionLocator } from '@cuelight/schema'
import { HelperError, type HelperLike } from '../src/main/helper.ts'
import { NativeTargets, REFRESH, axLocatorFor, frontWindow, matchAx, matchAxAll, matchOcr, regionIn, type AxNode, type OcrLine, type WinInfo } from '../src/main/native.ts'

/** A tree as the helper reports it: [depth, fields] in tree order; parents come from the depths. */
function tree(rows: [number, Partial<AxNode>][]): AxNode[] {
  const stack: number[] = []
  let win = -1
  return rows.map(([depth, f], i) => {
    stack.length = depth
    if (depth === 0) win++
    const n: AxNode = { role: 'AXGroup', parent: depth ? stack[depth - 1] : -1, depth, window: win, ref: 100 + i, ...f }
    stack[depth] = i
    return n
  })
}

const NOTES = tree([
  [0, { role: 'AXWindow', title: 'Groceries', rect: [100, 100, 800, 600] }],
  [1, { role: 'AXToolbar', identifier: 'mainToolbar', rect: [100, 100, 800, 52] }],
  [2, { role: 'AXButton', title: 'New Note', identifier: 'newNote', rect: [120, 110, 32, 32] }],
  [2, { role: 'AXButton', description: 'Share', identifier: '_NS:88', rect: [160, 110, 32, 32] }],
  [1, { role: 'AXSplitGroup', rect: [100, 152, 800, 548] }],
  [2, { role: 'AXScrollArea', identifier: 'sidebar', rect: [100, 152, 220, 548] }],
  [3, { role: 'AXStaticText', value: 'Shopping', rect: [110, 160, 200, 24] }],
  [3, { role: 'AXStaticText', value: 'Recipes', rect: [110, 190, 200, 24] }],
  // Scrolled out of the window: there, but not on screen.
  [3, { role: 'AXStaticText', value: 'Archive', rect: [110, 1900, 200, 24] }],
  [2, { role: 'AXScrollArea', identifier: 'editor', rect: [320, 152, 580, 548] }],
  [3, { role: 'AXGroup', rect: [330, 160, 560, 80] }],
  [4, { role: 'AXButton', title: 'Done', rect: [340, 170, 60, 24] }],
  [3, { role: 'AXGroup', rect: [330, 250, 560, 80] }],
  [4, { role: 'AXButton', title: 'Done', rect: [340, 260, 60, 24] }],
  [4, { role: 'AXButton', title: 'Hidden', rect: [340, 290, 0, 0] }],
  [0, { role: 'AXWindow', title: 'Inbox', rect: [950, 100, 400, 300] }],
  [1, { role: 'AXButton', title: 'Done', rect: [960, 110, 60, 24] }],
])

const ax = (f: Omit<AxLocator, 'kind' | 'app'>): AxLocator => ({ kind: 'ax', app: 'com.example.notes', ...f })
const at = (nodes: AxNode[], i: number | undefined) => (i === undefined ? null : nodes[i])

describe('matchAx', () => {
  it('matches role, title, identifier and description', () => {
    expect(matchAx(ax({ role: 'AXButton', title: 'New Note' }), NOTES)?.identifier).toBe('newNote')
    expect(matchAx(ax({ identifier: 'newNote' }), NOTES)?.title).toBe('New Note')
    expect(matchAx(ax({ role: 'AXButton', description: 'share' }), NOTES)?.rect).toEqual([160, 110, 32, 32])
    expect(matchAx(ax({ role: 'AXButton', title: { exact: 'New' } }), NOTES)).toBeNull()
    expect(matchAx(ax({ role: 'AXButton', title: { re: '^new\\b', flags: 'i' } }), NOTES)?.identifier).toBe('newNote')
  })

  it('reads static text from its value', () => {
    expect(matchAx(ax({ role: 'AXStaticText', title: 'recipes' }), NOTES)?.rect).toEqual([110, 190, 200, 24])
  })

  it('skips elements with no size or outside their window', () => {
    expect(matchAx(ax({ title: 'Hidden' }), NOTES)).toBeNull()
    expect(matchAx(ax({ title: 'Archive' }), NOTES)).toBeNull()
  })

  it('narrows by window, ancestors and nth, in tree order', () => {
    const done = ax({ role: 'AXButton', title: 'Done' })
    expect(matchAxAll(done, NOTES).map((i) => NOTES[i].rect![1])).toEqual([170, 260, 110])
    expect(matchAx({ ...done, window: 'inbox' }, NOTES)?.rect).toEqual([960, 110, 60, 24])
    expect(matchAx({ ...done, nth: 1 }, NOTES)?.rect).toEqual([340, 260, 60, 24])
    // Ancestors in order, with others in between; index counts siblings of the same role.
    expect(matchAx({ ...done, path: [{ role: 'AXScrollArea', identifier: 'editor' }, { role: 'AXGroup', index: 1 }] }, NOTES)?.rect).toEqual([340, 260, 60, 24])
    expect(matchAx({ ...done, path: [{ role: 'AXGroup', index: 1 }, { role: 'AXScrollArea' }] }, NOTES)).toBeNull()
    expect(matchAx({ ...done, path: [{ role: 'AXScrollArea', identifier: 'sidebar' }] }, NOTES)).toBeNull()
  })
})

describe('axLocatorFor', () => {
  /** The hit-test chain for node i: the element up to its window. */
  const chain = (nodes: AxNode[], i: number) => {
    const out: AxNode[] = []
    for (let k = i; k >= 0; k = nodes[k].parent) out.push({ ...nodes[k], ref: 900 + k })
    return out
  }
  const roundTrip = (i: number) => {
    const l = axLocatorFor('com.example.notes', chain(NOTES, i), NOTES)!
    expect(at(NOTES, matchAxAll(l, NOTES)[l.nth ?? 0])).toBe(NOTES[i])
    return l
  }

  it('keeps a stable identifier and the name, and leaves out what it does not need', () => {
    expect(roundTrip(2)).toEqual({ kind: 'ax', app: 'com.example.notes', role: 'AXButton', identifier: 'newNote', title: { exact: 'New Note' } })
    // AppKit's made-up identifiers change between launches.
    expect(roundTrip(3)).toEqual({ kind: 'ax', app: 'com.example.notes', role: 'AXButton', description: { exact: 'Share' } })
  })

  it('adds ancestors, then the window, then nth until it points at the clicked element', () => {
    const second = roundTrip(13)
    expect(second.path).toEqual([{ role: 'AXScrollArea', identifier: 'editor' }])
    expect(second.nth).toBe(1)
    const other = roundTrip(16)
    expect(other.window).toEqual({ exact: 'Inbox' })
    expect(other.nth).toBeUndefined()
    expect(roundTrip(11).nth).toBeUndefined()
  })

  it('works without a tree, and gives up on an element with no role', () => {
    expect(axLocatorFor('a.b', chain(NOTES, 6), null)).toEqual({ kind: 'ax', app: 'a.b', role: 'AXStaticText', title: { exact: 'Shopping' } })
    expect(axLocatorFor('a.b', [{ role: '', parent: -1, depth: 0, window: 0, ref: 1 }], null)).toBeNull()
  })
})

describe('matchOcr', () => {
  const lines: OcrLine[] = [
    { text: 'Save draft', rect: [400, 300, 90, 20], confidence: 0.9, sub: [400, 300, 40, 20] },
    { text: 'File  Edit  View', rect: [10, 5, 160, 18], confidence: 0.9 },
    { text: 'Save', rect: [600, 300, 40, 20], confidence: 0.9 },
  ]
  it('takes the first match in reading order, and just the matched part of a line', () => {
    expect(matchOcr({ kind: 'visual', text: 'save' }, lines)).toEqual([400, 300, 40, 20])
    expect(matchOcr({ kind: 'visual', text: { exact: 'Save' } }, lines)).toEqual([600, 300, 40, 20])
    expect(matchOcr({ kind: 'visual', text: 'file edit' }, lines)).toEqual([10, 5, 160, 18])
    expect(matchOcr({ kind: 'visual', text: 'Print' }, lines)).toBeNull()
  })
  it('places the light relative to the anchor with box', () => {
    expect(matchOcr({ kind: 'visual', text: { exact: 'Save' }, box: [-8, -6, 56, 32] }, lines)).toEqual([592, 294, 56, 32])
  })
})

describe('windows', () => {
  const wins: WinInfo[] = [
    { app: 'com.cuelight', pid: 1, title: '', rect: [0, 0, 500, 400] },
    { app: 'com.example.notes', pid: 2, title: 'Groceries', rect: [100, 100, 800, 600] },
    { app: 'com.example.notes', pid: 2, title: 'Inbox', rect: [950, 100, 400, 300] },
  ]
  it('finds the front window of an app, or of any app but ours', () => {
    expect(frontWindow(wins, 'com.example.notes', 1)?.title).toBe('Groceries')
    expect(frontWindow(wins, undefined, 1)?.title).toBe('Groceries')
    expect(frontWindow(wins, 'com.example.mail', 1)).toBeNull()
  })
  it('places a region in a window, in points or fractions', () => {
    expect(regionIn({ rect: [10, 20, 30, 40], units: 'pt' }, [100, 100, 800, 600])).toEqual([110, 120, 30, 40])
    expect(regionIn({ rect: [0.5, 0.5, 0.25, 0.1], units: 'fraction' }, [100, 100, 800, 600])).toEqual([500, 400, 200, 60])
  })
})

// ---------------------------------------------------------------- the cache

type Call = { cmd: string; args: Record<string, unknown> }

function rig(answer: (c: Call) => unknown) {
  let now = 0
  const calls: Call[] = []
  const pending: (() => void)[] = []
  let changes = 0
  const helper: HelperLike = {
    request: <T,>(cmd: string, args: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ cmd, args })
        pending.push(() => {
          try {
            resolve(answer({ cmd, args }) as T)
          } catch (e) {
            reject(e)
          }
        })
      }),
  }
  const nt = new NativeTargets({ helper, now: () => now, ownPid: 1, screenAt: () => [0, 0, 1440, 900], onChange: () => changes++ })
  /** Answer what was asked so far, and let the promises settle. */
  const flush = async () => {
    while (pending.length) {
      pending.shift()!()
      for (let k = 0; k < 5; k++) await Promise.resolve()
    }
  }
  return { nt, calls, flush, wait: (ms: number) => (now += ms), changes: () => changes }
}

describe('NativeTargets', () => {
  const done: AxLocator = ax({ role: 'AXButton', title: 'New Note' })

  it('looks through the tree once, then polls the element by its handle', async () => {
    let rect: Rect = [120, 110, 32, 32]
    const r = rig((c) => (c.cmd === 'ax.tree' ? { nodes: NOTES } : { rect }))
    expect(r.nt.resolve(done)).toBeNull()
    expect(r.nt.resolve(done)).toBeNull()
    expect(r.calls.map((c) => c.cmd)).toEqual(['ax.tree'])
    await r.flush()
    expect(r.nt.resolve(done)).toEqual([120, 110, 32, 32])
    expect(r.changes()).toBe(1)

    r.wait(REFRESH.frame)
    rect = [220, 110, 32, 32]
    r.nt.resolve(done)
    expect(r.calls.at(-1)).toEqual({ cmd: 'ax.frame', args: { ref: 102 } })
    await r.flush()
    expect(r.nt.resolve(done)).toEqual([220, 110, 32, 32])
    // Not due yet: no new request.
    r.nt.resolve(done)
    expect(r.calls).toHaveLength(2)
  })

  it('looks again when the element went away', async () => {
    let gone = false
    const r = rig((c) => {
      if (c.cmd === 'ax.tree') return { nodes: gone ? [] : NOTES }
      gone = true
      throw new HelperError('gone')
    })
    r.nt.resolve(done)
    await r.flush()
    r.wait(REFRESH.frame)
    r.nt.resolve(done)
    await r.flush()
    expect(r.calls.map((c) => c.cmd)).toEqual(['ax.tree', 'ax.frame', 'ax.tree'])
    expect(r.nt.resolve(done)).toBeNull()
  })

  it('says when the system does not allow it, and when it cannot be done', async () => {
    const r = rig(() => {
      throw new HelperError('not-trusted')
    })
    r.nt.resolve(done)
    await r.flush()
    expect(r.nt.resolve(done)).toBe('denied')
    r.wait(REFRESH.tree)
    r.nt.resolve(done)
    expect(r.calls).toHaveLength(1)
    expect(r.nt.resolve({ kind: 'visual', image: 'x.png' })).toBe('unsupported')
    const none = new NativeTargets({ helper: null, now: () => 0, ownPid: 1, screenAt: () => [0, 0, 1, 1] })
    expect(none.resolve(done)).toBe('unsupported')
  })

  it('finds text in the app’s window, or on the screen with the cursor', async () => {
    const r = rig((c) =>
      c.cmd === 'windows'
        ? { windows: [{ app: 'com.example.notes', pid: 2, title: '', rect: [100, 100, 800, 600] }] }
        : { lines: [{ text: 'Export as PDF', rect: [300, 400, 120, 20], confidence: 1, sub: [300, 400, 50, 20] }] },
    )
    r.nt.resolve({ kind: 'visual', app: 'com.example.notes', text: 'export' })
    await r.flush()
    expect(r.calls).toEqual([
      { cmd: 'windows', args: { app: 'com.example.notes' } },
      { cmd: 'ocr', args: { rect: [100, 100, 800, 600], find: 'export' } },
    ])
    expect(r.nt.resolve({ kind: 'visual', app: 'com.example.notes', text: 'export' })).toEqual([300, 400, 50, 20])
    r.nt.resolve({ kind: 'visual', text: { exact: 'Export as PDF' } })
    await r.flush()
    expect(r.calls.at(-1)).toEqual({ cmd: 'ocr', args: { rect: [0, 0, 1440, 900], find: undefined } })
  })

  it('follows a window for a window region', async () => {
    const r = rig(() => ({ windows: [{ app: 'com.example.notes', pid: 2, title: '', rect: [100, 100, 800, 600] }] }))
    const l: RegionLocator = { kind: 'region', relativeTo: 'window', app: 'com.example.notes', rect: [10, 10, 50, 20], units: 'pt' }
    r.nt.resolve(l)
    await r.flush()
    expect(r.nt.resolve(l)).toEqual([110, 110, 50, 20])
  })
})
