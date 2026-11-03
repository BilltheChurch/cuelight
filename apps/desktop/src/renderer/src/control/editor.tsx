/**
 * The storyboard editor: the step list on the left (drag to reorder), the selected step on the
 * right, and picking a target by clicking the element in the presenter's own browser or in any
 * app on screen.
 */
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Braces,
  CircleAlert,
  CircleDot,
  Clock,
  Copy,
  Crosshair,
  GripVertical,
  Hourglass,
  Keyboard,
  Mic,
  MousePointerClick,
  Pencil,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  defaultTag,
  estimateSecs,
  formatJson,
  howTo,
  langFromLocale,
  parseStoryboard,
  readSecs,
  stepsFromRecording,
  type Act,
  type Lang,
  type Pace,
  type RecEvent,
  type Step,
  type TextMatch,
} from '@cuelight/schema'
import type { AppState, PickResult } from '../../../shared/types.ts'
import { AiPanel } from './ai.tsx'
import {
  ACTS,
  LOCATOR_ORDER,
  UNTIL_ORDER,
  applyPick,
  coerce,
  dropIndex,
  duplicateStep,
  freshHistory,
  history,
  insertStep,
  moveInList,
  moveStep,
  removeStep,
  setRootKey,
  setStepKey,
  splitIssues,
  withKey,
  type Doc,
  type StepDoc,
} from './doc.ts'
import { fill, strings, type Strings } from './i18n.ts'

const api = window.cuelight

export const ACT_ICON: Record<Act, LucideIcon> = { click: MousePointerClick, read: Mic, wait: Hourglass, manual: Keyboard }

type Obj = Record<string, unknown>
type Edit = (fn: (d: Doc) => Doc, key?: string) => void

const isAct = (a: unknown): a is Act => ACTS.includes(a as Act)
const actOf = (st: StepDoc): Act => (isAct(st.act) ? st.act : 'manual')
const textOf = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
const inField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function duration(secs: number, t: Strings) {
  return secs >= 90 ? fill(t.minutes, { m: Math.round(secs / 60) }) : fill(t.seconds, { s: Math.round(secs) })
}

export function Editor({ s, t }: { s: AppState; t: Strings }) {
  const info = s.doc!
  const [h, dispatch] = useReducer(history, null, () => freshHistory(coerce({})))
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState('')
  const [sel, setSel] = useState(0)
  const [pickFor, setPickFor] = useState<number | null>(null)
  const [pickWhere, setPickWhere] = useState<'web' | 'app'>('web')
  const [toast, setToast] = useState<string | null>(null)
  /** The AI sheet, open on the whole storyboard or the selected step */
  const [ai, setAi] = useState<'all' | 'step' | null>(null)
  const doc = h.present
  const steps = doc.steps
  const idle = s.player.phase === 'idle'

  useEffect(() => {
    let live = true
    setReady(false)
    void api.getDoc().then((d) => {
      if (!live || !d) return
      const opened = coerce(d.json)
      dispatch({ type: 'reset', doc: opened })
      setSaved(JSON.stringify(opened))
      setSel(0)
      setReady(true)
    })
    return () => {
      live = false
    }
  }, [info.rev])

  const parsed = useMemo(() => parseStoryboard(doc), [doc])
  const issues = useMemo(() => splitIssues(parsed.ok ? [] : parsed.issues), [parsed])
  const est = parsed.ok ? estimateSecs(parsed.value) : null
  const json = useMemo(() => JSON.stringify(doc), [doc])
  const dirty = ready && json !== saved
  /** Lines and labels are written in the storyboard's language, which may not be the UI's. */
  const boardLang: Lang = typeof doc.language === 'string' && doc.language ? langFromLocale(doc.language) : s.lang

  // Keep the player on what is on screen, saved or not.
  useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => void api.setDraft(doc), 200)
    return () => clearTimeout(id)
  }, [doc, ready])

  useEffect(() => {
    window.onbeforeunload = dirty
      ? (e) => {
          e.returnValue = false
        }
      : null
  }, [dirty])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(id)
  }, [toast])

  const edit: Edit = (fn, key) => dispatch({ type: 'edit', fn, key, at: Date.now() })

  // Callbacks registered once read the latest values from here.
  const cur = useRef({ doc, sel, pickFor, t, boardLang, saved })
  cur.current = { doc, sel, pickFor, t, boardLang, saved }

  useEffect(
    () =>
      api.onPick((p: PickResult | null) => {
        const { pickFor: i, t: tt, boardLang: bl } = cur.current
        setPickFor(null)
        if (!p || i === null) return
        let startSet: 'url' | 'app' | null = null
        edit((d) => {
          const r = applyPick(d, i, p, (label) => fill(strings[bl].tagClick, { label }))
          startSet = r.startSet
          return r.doc
        })
        const extra = startSet === 'url' ? fill(tt.startSet, { url: p.url }) : startSet === 'app' ? fill(tt.startApp, { app: p.app ?? '' }) : ''
        setToast(fill(tt.picked, { label: p.label }) + (extra ? ' · ' + extra : ''))
      }),
    [],
  )
  useEffect(() => {
    if (!s.picking && pickFor !== null) {
      // The pick ended without a result reaching us (say, the browser went away).
      const id = setTimeout(() => setPickFor(null), 300)
      return () => clearTimeout(id)
    }
  }, [s.picking, pickFor])

  // A run recorded while this storyboard is open lands after the selected step.
  useEffect(() => {
    const onRecorded = (e: Event) => {
      const { sel: i, t: tt, boardLang: bl, doc: d0 } = cur.current
      const { steps: add, startUrl } = stepsFromRecording((e as CustomEvent<RecEvent[]>).detail, bl)
      if (!add.length) return setToast(tt.recEmpty)
      const at = Math.min(i < 0 ? d0.steps.length : i + 1, d0.steps.length)
      edit((d) => {
        let out = d
        add.forEach((st, k) => (out = insertStep(out, at + k, st)))
        return startUrl && !d.start?.url && /^https?:/.test(startUrl) ? setRootKey(out, 'start', { ...(d.start ?? {}), url: startUrl }) : out
      })
      setSel(at)
      setToast(fill(tt.recAdded, { n: add.length }))
    }
    addEventListener('cuelight:recorded', onRecorded)
    return () => removeEventListener('cuelight:recorded', onRecorded)
  }, [])

  useEffect(() => {
    const r = s.rehearsal
    if (!r || Date.now() - r.at > 5000) return
    setToast(r.est ? fill(t.rehearsedEst, { n: r.n, s: r.secs.toFixed(1), e: r.est.toFixed(1) }) : fill(t.rehearsed, { n: r.n, s: r.secs.toFixed(1) }))
  }, [s.rehearsal?.at])

  const save = async (as: boolean) => {
    const d = cur.current.doc
    const r = await api.save(d, as)
    if (r.ok) {
      setSaved(JSON.stringify(d))
      setToast(fill(cur.current.t.savedTo, { path: r.path }))
    } else if (r.error) setToast(r.error)
  }
  const play = async (from: number, single = false) => {
    await api.setDraft(cur.current.doc)
    await (single ? api.rehearse(from) : api.play(from))
  }
  const close = () => {
    if (dirty && !confirm(t.discardConfirm)) return
    window.onbeforeunload = null
    void api.closeDoc()
  }
  const select = (i: number) => setSel(Math.max(-1, Math.min(steps.length - 1, i)))
  const addStep = () => {
    const at = Math.min(sel < 0 ? steps.length : sel + 1, steps.length)
    const act = sel >= 0 && steps[sel] ? actOf(steps[sel]) : 'read'
    edit((d) => insertStep(d, at, { act, say: '' }))
    setSel(at)
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return
    edit((d) => moveStep(d, from, to))
    setSel(to)
  }
  const startPick = async (i: number, where: 'web' | 'app') => {
    const r = await api.pick(true, where)
    if (r.ok) {
      setPickWhere(where)
      setPickFor(i)
    } else if (where === 'web') setToast(t.pickNoBrowser)
    else if (r.reason === 'denied') {
      setToast(t.pickAppDenied)
      void api.nativeAsk('ax')
    } else setToast(t.pickAppNone)
  }
  const cancelPick = () => {
    setPickFor(null)
    void api.pick(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A sheet on top (AI, its setup) has the keyboard to itself.
      if (document.querySelector('.sheet-back')) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 's') {
        e.preventDefault()
        void save(e.shiftKey)
      } else if (mod && (k === 'z' || k === 'y')) {
        e.preventDefault()
        dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' })
      } else if (!inField(e.target) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const { sel: i } = cur.current
        const d = e.key === 'ArrowDown' ? 1 : -1
        if (e.altKey && i >= 0) move(i, i + d)
        else select(i + d)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (!ready) return null
  const st = sel >= 0 ? steps[sel] : undefined
  const total = parsed.ok ? 0 : parsed.issues.length

  return (
    <div className="editor">
      <div className="tile ed-head">
        <div className="ed-title">
          <input
            className="title-input"
            aria-label={t.title}
            value={textOf(doc.title)}
            placeholder={t.untitled}
            onChange={(e) => edit((d) => setRootKey(d, 'title', e.target.value), 'title')}
          />
          <div className="chips">
            <span className="chip">{fill(t.steps, { n: steps.length })}</span>
            {est !== null && (
              <span className="chip">
                <Clock size={13} /> {duration(est, t)}
              </span>
            )}
            <span className={'chip ' + (dirty || !info.path ? 'warn' : 'ok')}>{dirty || !info.path ? t.unsaved : t.saved}</span>
          </div>
          <p className="muted mono small path" title={info.path ?? ''}>
            {info.example ? t.exampleNote : (info.path ?? t.notSaved)}
          </p>
        </div>
        <div className="ed-actions">
          <div className="ed-cta">
            <button className="secondary big" onClick={() => setAi('all')}>
              <Sparkles size={17} /> {t.aiWrite}
            </button>
            <button className="primary big" disabled={!idle || !parsed.ok} onClick={() => void play(0)}>
              <Play size={18} /> {t.play}
            </button>
          </div>
          <div className="toolbar">
            <IconBtn icon={CircleDot} label={t.recordSteps} disabled={!idle || !!s.recording} onClick={() => void api.record(true, false).then((r) => r.ok || setToast(t.pickNoBrowser))} />
            <span className="sep" />
            <IconBtn icon={Undo2} label={`${t.undo} (⌘Z)`} disabled={!h.past.length} onClick={() => dispatch({ type: 'undo' })} />
            <IconBtn icon={Redo2} label={`${t.redo} (⇧⌘Z)`} disabled={!h.future.length} onClick={() => dispatch({ type: 'redo' })} />
            <button className="secondary" onClick={() => void save(false)} title="⌘S">
              <Save size={15} /> {t.save}
            </button>
            <button className="secondary" onClick={() => void save(true)} title="⇧⌘S">
              {t.saveAs}
            </button>
            <IconBtn icon={X} label={t.close} onClick={close} />
          </div>
        </div>
      </div>

      {total > 0 && (
        <div className="tile issues-tile" role="alert">
          <div className="row-title">
            <CircleAlert size={17} />
            <strong>{total === 1 ? t.issue1 : fill(t.issues, { n: total })}</strong>
          </div>
          <ul className="issue-list">
            {issues.root.map((i) => (
              <li key={i}>
                <button className="link" onClick={() => setSel(-1)}>
                  {i}
                </button>
              </li>
            ))}
            {[...issues.steps].map(([n, list]) => (
              <li key={n}>
                <button className="link" onClick={() => setSel(n)}>
                  {fill(t.stepN, { n: n + 1 })}: {list.join('; ')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ed-body">
        <StepList doc={doc} sel={sel} issues={issues.steps} lang={boardLang} t={t} onSelect={select} onAdd={addStep} edit={edit} setSel={setSel} />
        {sel < 0 || !st ? (
          <BoardSettings doc={doc} t={t} edit={edit} />
        ) : (
          <StepDetail
            key={sel}
            st={st}
            i={sel}
            n={steps.length}
            pace={(doc.pace ?? {}) as Partial<Pace>}
            lang={boardLang}
            t={t}
            issues={issues.steps.get(sel) ?? []}
            edit={edit}
            canPlay={idle && parsed.ok}
            canPick={idle && s.bridge.browsers.some((b) => b.connected)}
            canPickApp={idle && s.native.available}
            picking={pickFor === sel ? pickWhere : null}
            onPick={(where) => void startPick(sel, where)}
            onCancelPick={cancelPick}
            onRehearse={() => void play(sel, true)}
            onAi={() => setAi('step')}
            onPlayFrom={() => void play(sel)}
            onMove={(d) => move(sel, sel + d)}
            onDuplicate={() => {
              edit((d) => duplicateStep(d, sel))
              setSel(sel + 1)
            }}
            onDelete={() => {
              edit((d) => removeStep(d, sel))
              setSel(Math.min(sel, steps.length - 2))
            }}
          />
        )}
      </div>
      {ai && (
        <AiPanel
          doc={doc}
          sel={sel}
          startScope={ai}
          info={s.ai}
          uiLang={s.lang}
          t={t}
          onApply={(next, n) => {
            edit(() => next)
            setAi(null)
            setToast(fill(t.aiApplied, { n }))
          }}
          onBrief={() => {
            setAi(null)
            setSel(-1)
          }}
          onClose={() => setAi(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- step list

function StepList(p: {
  doc: Doc
  sel: number
  issues: Map<number, string[]>
  lang: Lang
  t: Strings
  onSelect: (i: number) => void
  onAdd: () => void
  edit: Edit
  setSel: (i: number) => void
}) {
  const { doc, sel, t } = p
  const [drag, setDrag] = useState<{ from: number; over: number; after: boolean } | null>(null)
  return (
    <div className="tile step-list">
      <button className={'sl-settings' + (sel === -1 ? ' on' : '')} onClick={() => p.onSelect(-1)}>
        <Settings2 size={16} /> {t.boardSettings}
      </button>
      <ol>
        {doc.steps.map((st, i) => {
          const act = actOf(st)
          const Icon = ACT_ICON[act]
          const drop = drag && drag.over === i && drag.from !== i ? (drag.after ? ' drop-after' : ' drop-before') : ''
          return (
            <li key={i} className={drop}>
              <button
                className={'sl-item' + (sel === i ? ' on' : '') + (drag?.from === i ? ' dragging' : '')}
                aria-current={sel === i ? 'step' : undefined}
                draggable
                title={t.dragHint}
                onClick={() => p.onSelect(i)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(i))
                  setDrag({ from: i, over: i, after: false })
                }}
                onDragOver={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > r.top + r.height / 2
                  if (drag.over !== i || drag.after !== after) setDrag({ ...drag, over: i, after })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (!drag) return
                  const to = dropIndex(drag.from, i, drag.after)
                  if (to !== drag.from) {
                    p.edit((d) => moveStep(d, drag.from, to))
                    p.setSel(to)
                  }
                  setDrag(null)
                }}
                onDragEnd={() => setDrag(null)}
              >
                <GripVertical className="grip" size={14} aria-hidden />
                <span className="n">{i + 1}</span>
                <span className="act">
                  <Icon size={15} />
                </span>
                <span className="text">
                  <strong>{defaultTag({ act, tag: textOf(st.tag) || undefined }, p.lang)}</strong>
                  <span className="muted">{textOf(st.say) || t.noLine}</span>
                </span>
                {p.issues.has(i) && <CircleAlert className="bad" size={15} aria-label="!" />}
              </button>
            </li>
          )
        })}
      </ol>
      <button className="add-step" onClick={p.onAdd}>
        <Plus size={15} /> {t.addStep}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- one step

function StepDetail(p: {
  st: StepDoc
  i: number
  n: number
  pace: Partial<Pace>
  lang: Lang
  t: Strings
  issues: string[]
  edit: Edit
  canPlay: boolean
  canPick: boolean
  canPickApp: boolean
  picking: 'web' | 'app' | null
  onPick: (where: 'web' | 'app') => void
  onCancelPick: () => void
  onRehearse: () => void
  onAi: () => void
  onPlayFrom: () => void
  onMove: (d: 1 | -1) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { st, i, t, lang } = p
  const act = actOf(st)
  const set = (key: string, value: unknown, coalesce = true) => p.edit((d) => setStepKey(d, i, key, value), coalesce ? `s${i}.${key}` : undefined)
  const say = textOf(st.say)
  const secs = typeof st.secs === 'number' ? st.secs : undefined
  return (
    <div className="tile detail">
      <div className="detail-head">
        <h2>{fill(t.stepN, { n: i + 1 })}</h2>
        <div className="row">
          <button className="secondary small" disabled={!p.canPlay} onClick={p.onRehearse}>
            <Play size={13} /> {t.rehearse}
          </button>
          <button className="secondary small" disabled={!p.canPlay} onClick={p.onPlayFrom}>
            {t.playFrom}
          </button>
          <IconBtn icon={Sparkles} label={t.aiRewriteStep} onClick={p.onAi} />
          <span className="sep" />
          <IconBtn icon={ArrowUp} label={t.moveUp} disabled={i === 0} onClick={() => p.onMove(-1)} />
          <IconBtn icon={ArrowDown} label={t.moveDown} disabled={i === p.n - 1} onClick={() => p.onMove(1)} />
          <IconBtn icon={Copy} label={t.duplicate} onClick={p.onDuplicate} />
          <IconBtn icon={Trash2} label={t.delete} disabled={p.n <= 1} onClick={p.onDelete} />
        </div>
      </div>
      {p.issues.length > 0 && (
        <ul className="step-issues">
          {p.issues.map((x) => (
            <li key={x}>
              <CircleAlert size={14} /> {x}
            </li>
          ))}
        </ul>
      )}

      <Group label={t.act}>
        <div className="acts" role="radiogroup" aria-label={t.act}>
          {ACTS.map((a) => {
            const Icon = ACT_ICON[a]
            return (
              <button key={a} role="radio" aria-checked={act === a} className={'act-tile' + (act === a ? ' on' : '')} onClick={() => set('act', a, false)}>
                <Icon size={18} />
                <strong>{t[`act_${a}`]}</strong>
                <span>{t[`actSub_${a}`]}</span>
              </button>
            )
          })}
        </div>
      </Group>

      <Field label={t.line} hint={say ? fill(t.readTime, { s: readSecs({ say, secs }, p.pace).toFixed(1) }) : undefined}>
        <textarea className="say" rows={3} value={say} placeholder={t.linePh} onChange={(e) => set('say', e.target.value)} />
      </Field>
      <div className="two">
        <Field label={t.tag}>
          <input value={textOf(st.tag)} placeholder={defaultTag({ act }, lang)} onChange={(e) => set('tag', e.target.value)} />
        </Field>
        <Field label={t.how}>
          <input value={textOf(st.how)} placeholder={howTo({ act, say, target: st.target as Step['target'] }, lang)} onChange={(e) => set('how', e.target.value)} />
        </Field>
      </div>

      <TargetEditor
        target={st.target}
        t={t}
        set={(v) => set('target', v, false)}
        canPick={p.canPick}
        canPickApp={p.canPickApp}
        picking={p.picking}
        onPick={p.onPick}
        onCancelPick={p.onCancelPick}
      />
      {act === 'wait' && <WaitEditor st={st} t={t} set={set} />}

      <details className="more">
        <summary>{t.more}</summary>
        <div className="more-body">
          <label className="toggle">
            <input type="checkbox" checked={st.optional === true} onChange={(e) => set('optional', e.target.checked || undefined, false)} />
            <span>{t.optional}</span>
          </label>
          <div className="two">
            {act === 'read' && (
              <Field label={t.readSecs} hint={t.readSecsHint}>
                <input type="number" min={0.5} step={0.5} value={secs ?? ''} onChange={(e) => set('secs', num(e.target.value))} />
              </Field>
            )}
            <Group label={t.cardPlace}>
              <Segmented
                value={typeof st.card === 'string' ? st.card : 'auto'}
                options={(['auto', 'top', 'bottom'] as const).map((v) => [v, t[`place_${v}`]])}
                onChange={(v) => set('card', v === 'auto' ? undefined : v, false)}
              />
            </Group>
          </div>
          <div className="two">
            <Field label={t.stepId}>
              <input className="mono" value={textOf(st.id)} placeholder={`s${i + 1}`} onChange={(e) => set('id', e.target.value)} />
            </Field>
            <Field label={t.note}>
              <input value={textOf(st.note)} onChange={(e) => set('note', e.target.value)} />
            </Field>
          </div>
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------- targets

function TargetEditor(p: {
  target: unknown
  t: Strings
  set: (v: unknown) => void
  canPick: boolean
  canPickApp: boolean
  picking: 'web' | 'app' | null
  onPick: (where: 'web' | 'app') => void
  onCancelPick: () => void
}) {
  const { t } = p
  const list = (Array.isArray(p.target) ? p.target : []) as Obj[]
  return (
    <section className="target">
      <div className="section-head">
        <h4>{t.target}</h4>
        <span className="muted small">{list.length ? t.targetSub : t.noTarget}</span>
      </div>
      {p.picking ? (
        <div className="picking" role="status">
          <span className="pulse" aria-hidden />
          <span>{p.picking === 'app' ? t.pickingApp : t.picking}</span>
          <button className="secondary small" onClick={p.onCancelPick}>
            {t.cancel}
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="pick-btn" disabled={!p.canPick} onClick={() => p.onPick('web')}>
            <Crosshair size={16} /> {t.pick}
          </button>
          {p.canPickApp && (
            <button className="pick-btn" onClick={() => p.onPick('app')}>
              <AppWindow size={16} /> {t.pickApp}
            </button>
          )}
          <button className="ghost" onClick={() => p.set([...list, { kind: 'dom' }])}>
            <Plus size={13} /> {t.addLocator}
          </button>
          {!p.canPick && <span className="muted small">{t.pickNoBrowser}</span>}
        </div>
      )}
      {list.length > 0 && (
        <ol className="locators">
          {list.map((l, k) => (
            <LocatorRow
              key={k}
              l={l}
              k={k}
              n={list.length}
              t={t}
              onChange={(nl) => p.set(list.map((x, j) => (j === k ? nl : x)))}
              onRemove={() => p.set(list.filter((_, j) => j !== k))}
              onMove={(d) => p.set(moveInList(list, k, k + d))}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

const DOM_FIELDS = ['testId', 'role', 'name', 'text', 'css', 'nth', 'url'] as const
const TEXT_FIELDS = new Set(['name', 'text'])

/** True when every field of a dom locator fits the form; anything else is edited as JSON. */
const fitsForm = (l: Obj) =>
  l.kind === 'dom' && Object.keys(l).every((k) => k === 'kind' || (DOM_FIELDS as readonly string[]).includes(k) || k === 'within' || k === 'closest')

function LocatorRow(p: { l: Obj; k: number; n: number; t: Strings; onChange: (l: Obj) => void; onRemove: () => void; onMove: (d: 1 | -1) => void }) {
  const { l, t } = p
  const isNew = l.kind === 'dom' && Object.keys(l).length === 1
  const [mode, setMode] = useState<'closed' | 'form' | 'json'>(isNew ? 'form' : 'closed')
  return (
    <li className={'locator' + (mode !== 'closed' ? ' open' : '')}>
      <div className="loc-row">
        <span className="rank">{p.k + 1}</span>
        <span className="chip small">{String(l.kind ?? '?')}</span>
        <button className="loc-sum mono" onClick={() => setMode(mode === 'closed' ? (fitsForm(l) ? 'form' : 'json') : 'closed')} title={t.editFields}>
          {summarize(l, t) || '…'}
        </button>
        <span className="loc-tools">
          <IconBtn icon={ArrowUp} label={t.moveUp} disabled={p.k === 0} onClick={() => p.onMove(-1)} />
          <IconBtn icon={ArrowDown} label={t.moveDown} disabled={p.k === p.n - 1} onClick={() => p.onMove(1)} />
          {fitsForm(l) && <IconBtn icon={Pencil} label={t.editFields} onClick={() => setMode(mode === 'form' ? 'closed' : 'form')} />}
          <IconBtn icon={Braces} label={t.editJson} onClick={() => setMode(mode === 'json' ? 'closed' : 'json')} />
          <IconBtn icon={Trash2} label={t.remove} onClick={p.onRemove} />
        </span>
      </div>
      {mode === 'form' && fitsForm(l) && <DomFields l={l} t={t} onChange={p.onChange} />}
      {mode === 'json' && (
        <JsonEdit
          value={l}
          t={t}
          onDone={(v) => {
            if (v && typeof v === 'object' && !Array.isArray(v)) p.onChange(v as Obj)
            setMode('closed')
          }}
        />
      )}
    </li>
  )
}

function DomFields({ l, t, onChange }: { l: Obj; t: Strings; onChange: (l: Obj) => void }) {
  const set = (k: string, v: unknown) => onChange(withKey(l, k, v, LOCATOR_ORDER))
  return (
    <div className="dom-fields">
      {l.within !== undefined && (
        <p className="muted small mono within-line">
          {t.within}: {summarize({ kind: 'dom', ...(l.within as Obj) }, t)}
        </p>
      )}
      {DOM_FIELDS.map((f) =>
        TEXT_FIELDS.has(f) ? (
          <TextMatchField key={f} label={t[`f_${f}`]} value={l[f] as TextMatch | undefined} t={t} onChange={(v) => set(f, v)} />
        ) : (
          <Field key={f} label={t[`f_${f}`]}>
            <input
              className="mono"
              type={f === 'nth' ? 'number' : 'text'}
              min={f === 'nth' ? 0 : undefined}
              value={l[f] === undefined ? '' : String(l[f])}
              placeholder={f === 'role' ? 'button' : f === 'css' ? '.class, #id' : f === 'url' ? 'https://example.com/*' : ''}
              onChange={(e) => set(f, f === 'nth' ? num(e.target.value) : e.target.value)}
            />
          </Field>
        ),
      )}
    </div>
  )
}

function TextMatchField({ label, value, t, onChange }: { label: string; value: TextMatch | undefined; t: Strings; onChange: (v: TextMatch | undefined) => void }) {
  const mode = value && typeof value === 'object' ? ('exact' in value ? 'exact' : 're') : 'contains'
  const text = value === undefined ? '' : typeof value === 'string' ? value : 'exact' in value ? value.exact : value.re
  const flags = value && typeof value === 'object' && 're' in value ? value.flags : undefined
  const build = (m: string, v: string): TextMatch | undefined => (!v ? undefined : m === 'exact' ? { exact: v } : m === 're' ? { re: v, ...(flags ? { flags } : {}) } : v)
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="match">
        <select value={mode} onChange={(e) => onChange(build(e.target.value, text))} aria-label={label}>
          <option value="contains">{t.m_contains}</option>
          <option value="exact">{t.m_exact}</option>
          <option value="re">{t.m_re}</option>
        </select>
        <input className="mono" value={text} onChange={(e) => onChange(build(mode, e.target.value))} />
      </div>
    </div>
  )
}

function JsonEdit({ value, t, onDone }: { value: unknown; t: Strings; onDone: (v: unknown) => void }) {
  const [text, setText] = useState(() => formatJson(value, 60).trimEnd())
  const [bad, setBad] = useState(false)
  const done = () => {
    try {
      onDone(JSON.parse(text))
    } catch {
      setBad(true)
    }
  }
  return (
    <div className="json-edit">
      <textarea
        className="mono"
        rows={Math.min(14, text.split('\n').length + 1)}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setBad(false)
        }}
      />
      <div className="row">
        {bad && <span className="bad small">{t.badJson}</span>}
        <button className="secondary small" onClick={done}>
          {t.done}
        </button>
      </div>
    </div>
  )
}

function WaitEditor({ st, t, set }: { st: StepDoc; t: Strings; set: (k: string, v: unknown, coalesce?: boolean) => void }) {
  const until = (st.until && typeof st.until === 'object' ? st.until : {}) as Obj
  const setUntil = (k: string, v: unknown, coalesce = true) => {
    const u = withKey(until, k, v, UNTIL_ORDER)
    set('until', Object.keys(u).length ? u : undefined, coalesce)
  }
  return (
    <section className="wait">
      <div className="section-head">
        <h4>{t.waitFor}</h4>
      </div>
      <div className="two">
        <Field label={t.untilUrl}>
          <input className="mono" value={textOf(until.url)} placeholder="https://example.com/done*" onChange={(e) => setUntil('url', e.target.value)} />
        </Field>
        <Field label={t.timeout}>
          <input type="number" min={1} value={typeof until.timeoutSecs === 'number' ? until.timeoutSecs : ''} onChange={(e) => setUntil('timeoutSecs', num(e.target.value))} />
        </Field>
      </div>
      <JsonField label={t.appear} hint={t.jsonHint} value={until.appear} t={t} onChange={(v) => setUntil('appear', v, false)} />
      <JsonField label={t.gone} hint={t.jsonHint} value={until.gone} t={t} onChange={(v) => setUntil('gone', v, false)} />
      <Field label={t.fixedSecs}>
        <input type="number" min={0.5} step={0.5} value={typeof st.secs === 'number' ? st.secs : ''} onChange={(e) => set('secs', num(e.target.value))} />
      </Field>
    </section>
  )
}

function JsonField({ label, hint, value, t, onChange }: { label: string; hint: string; value: unknown; t: Strings; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const list = Array.isArray(value) ? (value as Obj[]) : []
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {open ? (
        <JsonEdit
          value={value ?? []}
          t={t}
          onDone={(v) => {
            onChange(Array.isArray(v) && v.length ? v : undefined)
            setOpen(false)
          }}
        />
      ) : (
        <button className="json-sum mono" onClick={() => setOpen(true)}>
          {list.length ? list.map((l) => summarize(l, t)).join('  |  ') : hint}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- storyboard settings

function BoardSettings({ doc, t, edit }: { doc: Doc; t: Strings; edit: Edit }) {
  const set = (k: string, v: unknown) => edit((d) => setRootKey(d, k, v), 'root.' + k)
  const start = (doc.start && typeof doc.start === 'object' ? doc.start : {}) as Obj
  const pace = (doc.pace && typeof doc.pace === 'object' ? doc.pace : {}) as Obj
  const brief = (doc.brief && typeof doc.brief === 'object' ? doc.brief : {}) as Obj
  const sub = (k: 'start' | 'pace' | 'brief', obj: Obj, key: string, v: unknown) => {
    const next = withKey(obj, key, v)
    set(k, Object.keys(next).length ? next : undefined)
  }
  return (
    <div className="tile detail">
      <div className="detail-head">
        <h2>{t.boardSettings}</h2>
      </div>
      <Field label={t.title}>
        <input value={textOf(doc.title)} placeholder={t.untitled} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label={t.description}>
        <textarea rows={2} value={textOf(doc.description)} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label={t.startUrl} hint={t.startUrlHint}>
        <input className="mono" value={textOf(start.url)} placeholder="https://" onChange={(e) => sub('start', start, 'url', e.target.value)} />
      </Field>
      <div className="two">
        <Field label={t.spoken} hint={t.spokenHint}>
          <input value={textOf(doc.language)} placeholder="en" onChange={(e) => set('language', e.target.value)} />
        </Field>
        <Field label={t.pace} hint={t.paceHint}>
          <input type="number" min={0.5} max={6} step={0.1} value={typeof pace.unitsPerSec === 'number' ? pace.unitsPerSec : ''} placeholder="2" onChange={(e) => sub('pace', pace, 'unitsPerSec', num(e.target.value))} />
        </Field>
      </div>
      <Group label={t.brief}>
        <div className="brief">
          <div className="two">
            <Field label={t.product}>
              <input value={textOf(brief.product)} placeholder={t.productPh} onChange={(e) => sub('brief', brief, 'product', e.target.value)} />
            </Field>
            <Field label={t.audience}>
              <input value={textOf(brief.audience)} placeholder={t.audiencePh} onChange={(e) => sub('brief', brief, 'audience', e.target.value)} />
            </Field>
          </div>
          <div className="two">
            <Field label={t.tone}>
              <input value={textOf(brief.tone)} placeholder={t.tonePh} onChange={(e) => sub('brief', brief, 'tone', e.target.value)} />
            </Field>
            <Field label={t.targetLen}>
              <input type="number" min={5} step={5} value={typeof brief.targetSecs === 'number' ? brief.targetSecs : ''} placeholder="60" onChange={(e) => sub('brief', brief, 'targetSecs', num(e.target.value))} />
            </Field>
          </div>
          <span className="hint">{t.briefHint}</span>
        </div>
      </Group>
      <Group label={t.cardPlace}>
        <Segmented
          value={typeof doc.card === 'string' ? doc.card : 'auto'}
          options={(['auto', 'top', 'bottom'] as const).map((v) => [v, t[`place_${v}`]])}
          onChange={(v) => edit((d) => setRootKey(d, 'card', v === 'auto' ? undefined : v))}
        />
      </Group>
    </div>
  )
}

// ---------------------------------------------------------------- small parts

/** One line describing a locator, e.g. `button “Sign in”` or `in testid=row › checkbox`. */
export function summarize(l: Obj, t: Strings): string {
  const m = (v: unknown) =>
    v === undefined ? '' : typeof v === 'string' ? `“${v}”` : v && typeof v === 'object' && 'exact' in v ? `= “${String(v.exact)}”` : v && typeof v === 'object' && 're' in v ? `/${String(v.re)}/` : ''
  switch (l.kind) {
    case 'dom': {
      const parts: string[] = []
      if (l.within && typeof l.within === 'object') parts.push(`${t.within} ${summarize({ kind: 'dom', ...(l.within as Obj) }, t)} ›`)
      if (l.testId) parts.push(`testid=${String(l.testId)}`)
      if (l.role) parts.push(String(l.role) + (l.name !== undefined ? ' ' + m(l.name) : ''))
      else if (l.name !== undefined) parts.push(m(l.name))
      if (l.css) parts.push(String(l.css))
      if (l.text !== undefined) parts.push((l.testId || l.role || l.css ? 'text ' : '') + m(l.text))
      if (typeof l.nth === 'number') parts.push(`#${l.nth}`)
      if (l.closest) parts.push(`↑ ${String(l.closest)}`)
      if (l.url) parts.push(`@ ${String(l.url)}`)
      return parts.join(' ')
    }
    case 'ax':
      return [l.app, l.role, m(l.title ?? l.identifier)].filter(Boolean).join(' ')
    case 'visual':
      return [l.app, l.text !== undefined ? 'OCR ' + m(l.text) : 'image'].filter(Boolean).join(' ')
    case 'region':
      return `${String(l.relativeTo ?? 'screen')} ${JSON.stringify(l.rect ?? [])}${l.units === 'fraction' ? ' ×' : ' pt'}`
    default:
      return JSON.stringify(l)
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

/** Like Field, for a group of buttons: a <label> would forward its clicks to the first one. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  )
}

function Segmented<V extends string>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function IconBtn({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Icon size={16} />
    </button>
  )
}

