import { describe, expect, it } from 'vitest'
import { clock, estimateSecs, parseStoryboard, runSig, srtTime, stepTitle, timeline, toChapters, toScript, toSrt, totalSecs, type StoryboardInput } from '../src/index.ts'

function sb(input: Omit<StoryboardInput, 'cuelight' | 'title'> & { title?: string }) {
  const r = parseStoryboard({ cuelight: 1, title: 'Demo', ...input })
  if (!r.ok) throw new Error(r.issues.join('\n'))
  return r.value
}

const DEMO = sb({
  steps: [
    { act: 'manual', say: 'Hi, this is a quick tour of the new editor.', tag: 'Intro' },
    { act: 'click', say: '', target: [{ kind: 'dom', css: '#new' }] },
    { act: 'wait', secs: 4, say: '' },
    { act: 'read', say: 'Every step has a line, a target and a way to move on.' },
    { act: 'click', say: 'Save it.', target: [{ kind: 'dom', css: '#save' }], note: 'Say it slowly' },
  ],
})

describe('timeline', () => {
  it('uses rehearsal times where there are some and the pace elsewhere', () => {
    const est = timeline(DEMO)
    expect(est.map((s) => s.secs)).toEqual([6.2, 1.5, 4, 7.7, 2.5])
    expect(totalSecs(est)).toBeCloseTo(estimateSecs(DEMO))
    const tl = timeline(DEMO, [6, null, 3.5])
    expect(tl.map((s) => s.start)).toEqual([0, 6, 7.5, 11, 18.7])
    expect(tl.map((s) => s.measured)).toEqual([true, false, true, false, false])
  })

  it('formats clocks and SRT times', () => {
    expect([clock(0), clock(4.6), clock(83), clock(3723)]).toEqual(['0:00', '0:05', '1:23', '1:02:03'])
    expect(srtTime(3723.4567)).toBe('01:02:03,457')
  })

  it('tells a changed storyboard from the one a rehearsal was timed on', () => {
    const changed = { ...DEMO, steps: DEMO.steps.map((s, i) => (i === 3 ? { ...s, say: 'Other words.' } : s)) }
    expect(runSig(DEMO.steps)).toBe(runSig(structuredClone(DEMO.steps)))
    expect(runSig(changed.steps)).not.toBe(runSig(DEMO.steps))
  })
})

describe('exports', () => {
  it('writes a voice-over script with timecodes, the how-to and notes', () => {
    const md = toScript(DEMO, timeline(DEMO, [6, 2, 4, 6, 3]), 'en')
    expect(md).toContain('# Demo\n\n5 steps · 0:21 · timed from a rehearsal\n')
    expect(md).toContain('## 0:00  1. Intro\n\nPress ⌥⌘→ when you are done (6.0 s)\n\nHi, this is a quick tour of the new editor.')
    expect(md).toContain('## 0:06  2. Click\n\nJust click, no need to speak (2.0 s)\n\n(no line)')
    expect(md).toContain('## 0:18  5. Click\n\nFinish the line, then click (3.0 s)\n\nSave it.\n\nNote: Say it slowly\n')
    expect(toScript(DEMO, timeline(DEMO), 'zh')).toContain('5 步 · 0:22 · 按台词估算')
    expect(md).not.toMatch(/[*\u2014]/)
  })

  it('writes subtitles that last as long as the line, not the whole step', () => {
    const srt = toSrt(DEMO, timeline(DEMO, [6, 2, 4, 20, 3]))
    const cues = srt.trim().split('\n\n')
    expect(cues).toHaveLength(3)
    expect(cues[0]).toBe('1\n00:00:00,000 --> 00:00:06,000\nHi, this is a quick\ntour of the new editor.')
    // Step 4 starts at 12 s; the presenter lingered 20 s but the line takes 7.7 s.
    expect(cues[1]).toBe('2\n00:00:12,000 --> 00:00:19,700\nEvery step has a line, a\ntarget and a way to move on.')
    expect(cues[2].split('\n')[1]).toBe('00:00:32,000 --> 00:00:34,500')
  })

  it('splits long lines into timed pieces, Chinese too', () => {
    const long = sb({
      steps: [
        { act: 'manual', say: 'First we open the settings page. Then we turn on the new layout, which takes a second, and look at the result together.' },
        { act: 'manual', say: '我们先打开设置页面，然后打开新的布局，稍等一秒钟，再一起看看效果怎么样。最后保存。' },
      ],
    })
    const cues = toSrt(long, timeline(long)).trim().split('\n\n')
    // Lines put back together: a space where an English line was wrapped, nothing in Chinese.
    const texts = cues.map((c) => c.split('\n').slice(2).join(' ').replace(/(?<=[，。]) /g, ''))
    expect(texts).toEqual([
      'First we open the settings page.',
      'Then we turn on the new layout, which takes a second,',
      'and look at the result together.',
      '我们先打开设置页面，然后打开新的布局，稍等一秒钟，再一起看看效果怎么样。',
      '最后保存。',
    ])
    for (const c of cues) for (const l of c.split('\n').slice(2)) expect(l.length).toBeLessThanOrEqual(42)
    // A Chinese line breaks after a comma, never before one.
    expect(cues[3].split('\n').slice(2)).toEqual(['我们先打开设置页面，然后打开新的布局，', '稍等一秒钟，再一起看看效果怎么样。'])
    // Pieces follow each other without gaps or overlaps.
    const times = cues.map((c) => c.split('\n')[1].split(' --> '))
    for (let k = 1; k < times.length; k++) expect(times[k][0]).toBe(times[k - 1][1])
  })

  it('merges steps into chapters of at least 10 seconds, named after their first step', () => {
    // 12 s, then 2 + 4 + 9 s, then a 3 s tail that joins the chapter before it.
    expect(toChapters(DEMO, timeline(DEMO, [12, 2, 4, 9, 3]), 'en')).toBe('0:00 Intro\n0:12 Click\n')
    expect(toChapters(DEMO, timeline(DEMO, [6, 2, 4, 6, 3]), 'en', 5)).toBe('0:00 Intro\n0:06 Click\n0:12 Every step has a line, a target and a way to mo…\n')
    expect(stepTitle(DEMO.steps[3], 'en', 80)).toBe('Every step has a line, a target and a way to move on.')
  })
})
