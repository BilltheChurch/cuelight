#!/usr/bin/env node
/**
 * The timing report and the exports, end to end and invisible: the app runs headless, plays a
 * short storyboard through (talk-only steps move on by themselves), then the editor shows how
 * long the run took, the Timing and export sheet lists each step, and the voice-over script,
 * subtitles and chapters it saves match its preview.
 *
 *   node scripts/e2e-export.mjs [--lang en|zh] [--shots <dir>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOM_HELPERS, arg, root, sleep, startApp } from './e2e-lib.mjs'

const lang = arg('--lang') ?? 'en'
const shots = arg('--shots')
const zh = lang === 'zh'
execFileSync('pnpm', ['--filter', '@cuelight/desktop', 'build'], { cwd: root, stdio: 'ignore' })

const dir = mkdtempSync(join(tmpdir(), 'cuelight-e2e-export-'))
const out = join(dir, 'out')
mkdirSync(out)
const file = join(dir, 'tour.json')
writeFileSync(
  file,
  JSON.stringify({
    cuelight: 1,
    title: zh ? '编辑器导览' : 'Editor tour',
    language: zh ? 'zh-CN' : 'en',
    steps: zh
      ? [
          { act: 'read', secs: 2, tag: '开场', say: '大家好，这是 Cuelight 的编辑器。' },
          { act: 'wait', secs: 1, say: '' },
          { act: 'read', secs: 1.5, say: '每一步都会计时，放完就能导出字幕。' },
        ]
      : [
          { act: 'read', secs: 2, tag: 'Hello', say: 'Hi, this is the Cuelight editor.' },
          { act: 'wait', secs: 1, say: '' },
          { act: 'read', secs: 1.5, say: 'Every step is timed while you play, then you export subtitles.' },
        ],
  }),
)

const t = zh
  ? { sheet: '计时与导出', measured: '实测', srt: '字幕', chapters: '章节', script: '配音稿', save: '保存…', toast: '这一遍用了 0:05，和计划差不多。' }
  : { sheet: 'Timing and export', measured: 'measured', srt: 'Subtitles', chapters: 'Chapters', script: 'Voice-over script', save: 'Save…', toast: 'The run took 0:05, right on plan.' }

const a = startApp({ args: ['--open', file], stdin: true, lang, env: { CUELIGHT_EXPORT_DIR: out }, quiet: ['rect', 'inside'] })
let failed = 0
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`)
  if (!cond) failed++
}
const shot = async (name) => shots && (await a.shot(join(shots, `export-${lang}-${name}.png`)))
/** Clicks the button with this text, aria-label, or title (the bold line of a tile). */
const press = async (label) => {
  const L = JSON.stringify(label)
  const hit = await a.evalIn(
    `(() => { const b = __t.qa('button').find((x) => x.textContent.trim() === ${L} || x.getAttribute('aria-label') === ${L} || x.querySelector('strong')?.textContent.trim() === ${L}); if (!b) return false; b.click(); return true })()`,
  )
  if (!hit) throw new Error(`no button "${label}"`)
  return hit
}

try {
  if (shots) mkdirSync(shots, { recursive: true })
  await a.waitEvent((e) => e.type === 'bridge', 20_000, 'bridge')
  await a.evalIn(DOM_HELPERS)
  await a.control('play')
  await a.waitEvent((e) => e.type === 'phase' && e.phase === 'preroll', 10_000, 'preroll')
  await a.control('next')
  const run = await a.waitEvent((e) => e.type === 'run', 20_000, 'the run to end')
  ok(run.complete && run.secs.every((x) => typeof x === 'number'), 'every step of the run is timed', JSON.stringify(run.secs))
  await a.control('stop')
  await sleep(400)
  const toast = await a.evalIn(`__t.text('.toast')[0] ?? ''`)
  ok(toast === t.toast, 'the editor says how long it took', toast)
  const chip = await a.evalIn(`__t.text('.chip-link')[0] ?? ''`)
  ok(chip.includes('0:05') && chip.includes(t.measured), 'a chip shows the measured length', chip)

  ok(await press(t.sheet), 'opens Timing and export')
  await sleep(300)
  const rows = await a.evalIn(`__t.qa('.run-row:not(.head)').map((r) => [...r.children].map((c) => c.textContent.trim()))`)
  ok(rows.length === 3 && rows.every((r) => r[2] && /\d\.\d s/.test(r[3])), 'each step: planned and measured', JSON.stringify(rows))
  const paces = await a.evalIn(`__t.qa('.run-row .pace').map((e) => e.className)`)
  ok(paces.length === 3 && paces.every((c) => c.includes('pace-ok')), 'all on plan', JSON.stringify(paces))
  await shot('1-script')

  const files = {}
  for (const [label, ext] of [
    [t.script, 'md'],
    [t.srt, 'srt'],
    [t.chapters, 'txt'],
  ]) {
    await press(label)
    await sleep(150)
    const preview = await a.evalIn(`document.querySelector('.export-preview').textContent`)
    const saved = a.waitNext((e) => e.type === 'export' && e.ext === ext, 10_000, `export ${ext}`)
    await press(t.save)
    const e = await saved
    files[ext] = readFileSync(e.path, 'utf8')
    ok(files[ext] === preview, `${ext} saved as previewed`, e.path.slice(out.length + 1))
    if (ext === 'srt') await shot('2-srt')
  }
  ok(/^# .+\n\n3 (steps|步) · 0:05 · (timed from a rehearsal|按排练实测计时)\n/.test(files.md), 'script header says it is timed from the run', files.md.split('\n')[2])
  // Real times: the first step took 2 s and a few ms, the third starts 1 s after the second.
  ok(/^1\n00:00:00,000 --> 00:00:02,0\d\d\n/.test(files.srt) && /\n2\n00:00:03,0\d\d --> /.test(files.srt), 'subtitles start with their steps', JSON.stringify(files.srt.slice(0, 60)))
  ok(files.txt.startsWith('0:00 '), 'chapters start at 0:00', JSON.stringify(files.txt))
  ok(!/[*\u2014]/.test(files.md + files.srt + files.txt), 'no asterisks or em dashes in the exports')
} catch (e) {
  failed++
  console.log('FAIL', e.message)
} finally {
  await a.close()
}
console.log(failed ? `${failed} FAILED` : `PASS export ${lang} (headless)`)
process.exitCode = failed ? 1 : 0
