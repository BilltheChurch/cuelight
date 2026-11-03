import { describe, expect, it } from 'vitest'
import { parseStoryboard } from '@cuelight/schema'
import {
  STEP_ORDER,
  applyPick,
  coerce,
  dropIndex,
  duplicateStep,
  freshHistory,
  history,
  moveStep,
  removeStep,
  setRootKey,
  setStepKey,
  splitIssues,
  withKey,
  type Doc,
} from '../src/renderer/src/control/doc.ts'

const doc = (): Doc => ({
  cuelight: 1,
  title: 'T',
  steps: [
    { act: 'click', say: 'One', target: [{ kind: 'dom', css: '#a' }] },
    { id: 'two', act: 'read', say: 'Two' },
    { act: 'manual', say: 'Three' },
  ],
})

describe('editing the JSON', () => {
  it('adds a key where it belongs, keeps the author order, and drops emptied keys', () => {
    const s = { act: 'read', target: [], note: 'x' }
    expect(Object.keys(withKey(s, 'say', 'Hi', STEP_ORDER))).toEqual(['act', 'say', 'target', 'note'])
    expect(Object.keys(withKey({ say: 'a', act: 'read' }, 'tag', 'T', STEP_ORDER))).toEqual(['say', 'act', 'tag'])
    expect(withKey(s, 'note', '')).toEqual({ act: 'read', target: [] })
    const same = { a: 1 }
    expect(withKey(same, 'a', 1)).toBe(same)
    expect(withKey(same, 'b', undefined)).toBe(same)
  })

  it('moves, duplicates and removes steps', () => {
    const d = doc()
    expect(moveStep(d, 0, 2).steps.map((s) => s.say)).toEqual(['Two', 'Three', 'One'])
    expect(moveStep(d, 0, 5)).toBe(d)
    const dup = duplicateStep(d, 1)
    expect(dup.steps.map((s) => s.say)).toEqual(['One', 'Two', 'Two', 'Three'])
    expect(dup.steps[2].id).toBeUndefined()
    expect(dup.steps[1].id).toBe('two')
    expect(removeStep(d, 0).steps).toHaveLength(2)
    expect(removeStep({ ...d, steps: [d.steps[0]] }, 0).steps).toHaveLength(1)
    // Drag and drop: drop step 0 after item 1, or before item 2: both land on index 1.
    expect(dropIndex(0, 1, true)).toBe(1)
    expect(dropIndex(0, 2, false)).toBe(1)
    expect(dropIndex(2, 0, false)).toBe(0)
  })

  it('turns any opened JSON into something the editor can show', () => {
    expect(coerce({ title: 'x' }).steps).toEqual([])
    expect(coerce({ steps: ['hello', { act: 'read' }] }).steps).toEqual([{ act: 'manual', say: 'hello' }, { act: 'read' }])
    expect(coerce(null).steps).toEqual([])
  })

  it('applies a pick: target, a label for click steps, and the start page for step 1', () => {
    const pick = { locators: [{ kind: 'dom' as const, role: 'button', name: 'Go' }], label: 'Go', role: 'button', url: 'https://example.com/app', title: 'App' }
    const { doc: d, startSet } = applyPick(doc(), 0, pick, (l) => `Click “${l}”`)
    expect(d.steps[0]).toEqual({ act: 'click', say: 'One', tag: 'Click “Go”', target: pick.locators })
    expect(d.start).toEqual({ url: 'https://example.com/app' })
    expect(startSet).toBe('url')
    const second = applyPick(d, 1, pick, (l) => l)
    expect(second.doc.steps[1].tag).toBeUndefined()
    expect(second.startSet).toBe(null)
    expect(parseStoryboard(second.doc).ok).toBe(true)
  })

  it('files schema problems under their steps', () => {
    const r = parseStoryboard(setStepKey(setRootKey(doc(), 'title', ''), 0, 'target', undefined))
    expect(r.ok).toBe(false)
    const { root, steps } = splitIssues(r.ok ? [] : r.issues)
    expect(root.join()).toMatch(/^title: /)
    expect(steps.get(0)).toEqual(['a click step needs a target (target)'])
  })
})

describe('undo history', () => {
  it('groups typing in one field, and undoes and redoes whole edits', () => {
    let h = freshHistory(doc())
    const type = (text: string, at: number) => (h = history(h, { type: 'edit', fn: (d) => setStepKey(d, 0, 'say', text), key: 's0.say', at }))
    type('O', 0)
    type('On', 300)
    type('One!', 600)
    h = history(h, { type: 'edit', fn: (d) => setRootKey(d, 'title', 'New'), key: 'title', at: 700 })
    expect(h.past).toHaveLength(2)
    h = history(h, { type: 'undo' })
    expect(h.present.title).toBe('T')
    expect(h.present.steps[0].say).toBe('One!')
    h = history(h, { type: 'undo' })
    expect(h.present.steps[0].say).toBe('One')
    h = history(h, { type: 'redo' })
    expect(h.present.steps[0].say).toBe('One!')
    // An edit after an undo drops the redo branch; an edit that changes nothing is not recorded.
    h = history(h, { type: 'edit', fn: (d) => setRootKey(d, 'title', 'Other'), at: 5000 })
    expect(h.future).toHaveLength(0)
    const before = h
    h = history(h, { type: 'edit', fn: (d) => setRootKey(d, 'title', 'Other'), at: 6000 })
    expect(h).toBe(before)
    // A pause between bursts of typing starts a new undo step.
    type('A', 7000)
    type('AB', 9000)
    expect(h.past.length).toBe(before.past.length + 2)
  })
})
