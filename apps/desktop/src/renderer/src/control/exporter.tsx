/**
 * Timing and export: how long each step took in the last full run against what was planned, and
 * the storyboard as a voice-over script, subtitles or chapter marks, timed by that run or by the
 * reading pace.
 */
import { useState } from 'react'
import { Captions, Copy, FileDown, FileText, ListOrdered, Timer, X } from 'lucide-react'
import { clock, runSig, stepTitle, timeline, toChapters, toScript, toSrt, totalSecs, type Lang, type Storyboard } from '@cuelight/schema'
import type { RunTimes } from '../../../shared/types.ts'
import { Sheet } from './ai.tsx'
import { fill, type Strings } from './i18n.ts'

const api = window.cuelight

type Kind = 'script' | 'srt' | 'chapters'
const KINDS: { k: Kind; icon: typeof FileText; ext: 'md' | 'srt' | 'txt' }[] = [
  { k: 'script', icon: FileText, ext: 'md' },
  { k: 'srt', icon: Captions, ext: 'srt' },
  { k: 'chapters', icon: ListOrdered, ext: 'txt' },
]

/** The last run's times, if they were measured on the steps as they are now. */
export const runFor = (sb: Storyboard, run: RunTimes | null) => (run && run.sig === runSig(sb.steps) ? run : null)

/** How a measured time compares with the plan: close, slower or faster. */
export function pace(measured: number, planned: number): 'ok' | 'slow' | 'fast' {
  const d = measured - planned
  if (Math.abs(d) <= Math.max(1, planned * 0.15)) return 'ok'
  return d > 0 ? 'slow' : 'fast'
}

const signed = (d: number) => (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' s'

export function ExportSheet(p: { sb: Storyboard; run: RunTimes | null; lang: Lang; t: Strings; onClose: () => void; onToast: (m: string) => void }) {
  const { sb, t } = p
  const run = runFor(sb, p.run)
  const [kind, setKind] = useState<Kind>('script')
  const [source, setSource] = useState<'run' | 'est'>(run ? 'run' : 'est')
  const planned = timeline(sb)
  const measured = run ? timeline(sb, run.secs) : null
  const tl = source === 'run' && measured ? measured : planned
  const text = kind === 'script' ? toScript(sb, tl, p.lang) : kind === 'srt' ? toSrt(sb, tl) : toChapters(sb, tl, p.lang)
  const ext = KINDS.find((x) => x.k === kind)!.ext

  const save = async () => {
    const r = await api.exportFile(ext, text, `${sb.title}${kind === 'script' ? '.voiceover' : kind === 'chapters' ? '.chapters' : ''}.${ext}`)
    if (r.ok) p.onToast(fill(t.exportSaved, { path: r.path ?? '' }))
    else if (r.error) p.onToast(r.error)
  }
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    p.onToast(t.exportCopied)
  }

  return (
    <Sheet label={t.exportTitle} onClose={p.onClose} wide>
      <div className="sheet-head">
        <h2>
          <Timer size={18} /> {t.exportTitle}
        </h2>
        <button className="icon-btn" aria-label={t.close} title={t.close} onClick={p.onClose}>
          <X size={16} />
        </button>
      </div>

      <section className="timing">
        <h4>{t.runTitle}</h4>
        {run && measured ? (
          <>
            <div className="run-sum">
              <div>
                <span className="muted small">{t.runMeasured}</span>
                <strong>{clock(totalSecs(measured))}</strong>
              </div>
              <div>
                <span className="muted small">{t.runPlanned}</span>
                <strong>{clock(totalSecs(planned))}</strong>
              </div>
              <span className={'chip pace-' + pace(totalSecs(measured), totalSecs(planned))}>{signed(totalSecs(measured) - totalSecs(planned))}</span>
              {!run.complete && <span className="muted small">{t.runPartial}</span>}
            </div>
            <div className="run-table" role="table" aria-label={t.runTitle}>
              <div role="row" className="run-row head">
                <span role="columnheader">#</span>
                <span role="columnheader">{t.runStep}</span>
                <span role="columnheader">{t.runPlanned}</span>
                <span role="columnheader">{t.runMeasured}</span>
                <span role="columnheader" />
              </div>
              {sb.steps.map((s, i) => {
                const m = run.secs[i]
                return (
                  <div role="row" className="run-row" key={i}>
                    <span role="cell" className="muted">
                      {i + 1}
                    </span>
                    <span role="cell" className="run-name">
                      {stepTitle(s, p.lang, 60)}
                    </span>
                    <span role="cell">{planned[i].secs.toFixed(1)} s</span>
                    <span role="cell">{typeof m === 'number' ? `${m.toFixed(1)} s` : <span className="muted">{t.runNotReached}</span>}</span>
                    <span role="cell">{typeof m === 'number' && <span className={'pace pace-' + pace(m, planned[i].secs)}>{signed(m - planned[i].secs)}</span>}</span>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <p className="note">{p.run ? t.runChanged : t.runNone}</p>
        )}
      </section>

      <section className="exports">
        <h4>{t.exportAs}</h4>
        <div className="export-kinds" role="radiogroup" aria-label={t.exportAs}>
          {KINDS.map(({ k, icon: Icon }) => (
            <button key={k} role="radio" aria-checked={kind === k} className={'act-tile' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
              <Icon size={18} />
              <strong>{t[`export_${k}`]}</strong>
              <span>{t[`exportSub_${k}`]}</span>
            </button>
          ))}
        </div>
        <div className="export-source">
          <span className="muted small">{t.exportTimes}</span>
          <div className="segmented" role="radiogroup" aria-label={t.exportTimes}>
            {(['run', 'est'] as const).map((v) => (
              <button key={v} role="radio" aria-checked={source === v} disabled={v === 'run' && !run} className={source === v ? 'on' : ''} onClick={() => setSource(v)}>
                {v === 'run' ? t.exportFromRun : t.exportFromEst}
              </button>
            ))}
          </div>
        </div>
        <pre className="export-preview mono" aria-label={t.exportPreview}>
          {text}
        </pre>
      </section>

      <div className="sheet-foot sticky">
        <button className="secondary" onClick={() => void copy()}>
          <Copy size={15} /> {t.exportCopy}
        </button>
        <button className="primary" onClick={() => void save()}>
          <FileDown size={15} /> {t.exportSave}
        </button>
      </div>
    </Sheet>
  )
}
