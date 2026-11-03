/**
 * Writing lines with an AI model: the sheet that asks for a draft or a rewrite and shows the
 * answer as changes to take or leave, the sheet that sets up the service, and the sidebar tile.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Bot, CircleAlert, CircleCheck, Cpu, KeyRound, LoaderCircle, Server, Sparkles, X, type LucideIcon } from 'lucide-react'
import { langFromLocale, type Act, type Lang } from '@cuelight/schema'
import { AI_DEFAULTS, AI_PROVIDERS, aiReady, profileOf, type AiErrorCode, type AiInfo, type AiOutput, type AiPing, type AiProvider, type AiSetup } from '../../../shared/ai.ts'
import { aiRows, applyAiRows, isChange, readableDiff, type AiRow } from './aidiff.ts'
import type { Doc, StepDoc } from './doc.ts'
import { ACT_ICON } from './editor.tsx'
import { fill, type Strings } from './i18n.ts'

const api = window.cuelight
const PROVIDER_ICON: Record<AiProvider, LucideIcon> = { anthropic: Sparkles, openai: Bot, compatible: Server, ollama: Cpu }
const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** Ask the app to open the AI setup sheet, from wherever the request comes. */
export const openAiSetup = () => dispatchEvent(new Event('cuelight:ai-setup'))

function Sheet({ label, onClose, wide, children }: { label: string; onClose?: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'sheet tile' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- writing

type Phase =
  | { k: 'ask' }
  | { k: 'run'; chars: number }
  | { k: 'review'; rows: AiRow[]; on: boolean[]; out: AiOutput; model: string; base: Doc }
  | { k: 'error'; code: AiErrorCode; detail?: string }

export function AiPanel(p: {
  doc: Doc
  sel: number
  startScope: 'all' | 'step'
  info: AiInfo
  uiLang: Lang
  t: Strings
  onApply: (doc: Doc, n: number) => void
  onBrief: () => void
  onClose: () => void
}) {
  const { doc, sel, info, t } = p
  const [scope, setScope] = useState<'all' | 'step'>(sel >= 0 ? p.startScope : 'all')
  const [ask, setAsk] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'ask' })
  const askRef = useRef<HTMLTextAreaElement>(null)
  const ready = aiReady(info)
  const prof = profileOf(info)
  const boardLang: Lang = text(doc.language) ? langFromLocale(text(doc.language)) : p.uiLang
  const brief = (doc.brief ?? {}) as Record<string, unknown>
  const hasBrief = ['product', 'audience', 'tone', 'targetSecs'].some((k) => brief[k] !== undefined && brief[k] !== '')

  useEffect(() => api.onAiProgress((chars) => setPhase((ph) => (ph.k === 'run' ? { k: 'run', chars } : ph))), [])
  useEffect(() => askRef.current?.focus(), [])

  const run = async () => {
    const base = doc
    setPhase({ k: 'run', chars: 0 })
    const r = await api.aiRun({ doc: base, scope: scope === 'step' ? [sel] : null, instruction: ask, uiLang: p.uiLang })
    if (!r.ok) return setPhase(r.error === 'cancelled' ? { k: 'ask' } : { k: 'error', code: r.error, detail: r.detail })
    const rows = aiRows(base, scope === 'step' ? [sel] : null, r.out)
    setPhase({ k: 'review', rows, on: rows.map(isChange), out: r.out, model: r.model, base })
  }
  const close = () => {
    if (phase.k === 'run') void api.aiCancel()
    p.onClose()
  }

  const chips =
    scope === 'all'
      ? [t.aiChipWrite, t.aiChipShorter, t.aiChipFriendly, fill(t.aiChipTranslate, { lang: boardLang === 'zh' ? t.aiLang_en : t.aiLang_zh })]
      : [t.aiChipShorter, t.aiChipFriendly, fill(t.aiChipTranslate, { lang: boardLang === 'zh' ? t.aiLang_en : t.aiLang_zh })]

  return (
    <Sheet label={t.aiWrite} onClose={close} wide={phase.k === 'review'}>
      <div className="sheet-head">
        <h2>
          <Sparkles size={18} /> {phase.k === 'review' ? t.aiReview : t.aiWrite}
        </h2>
        <button className="icon-btn" aria-label={t.close} title={t.close} onClick={close}>
          <X size={16} />
        </button>
      </div>

      {phase.k === 'ask' && (
        <>
          {sel >= 0 && (
            <div className="segmented ai-scope" role="radiogroup">
              {(['all', 'step'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={scope === v} className={scope === v ? 'on' : ''} onClick={() => setScope(v)}>
                  {v === 'all' ? t.aiScopeAll : fill(t.aiScopeStep, { n: sel + 1 })}
                </button>
              ))}
            </div>
          )}
          <label className="field">
            <span className="field-label">{t.aiAsk}</span>
            <textarea
              ref={askRef}
              className="ai-ask"
              rows={3}
              value={ask}
              placeholder={scope === 'all' ? t.aiAskPhAll : t.aiAskPhStep}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && void run()}
            />
          </label>
          <div className="ai-chips">
            {chips.map((c) => (
              <button key={c} className={'chip-btn' + (ask === c ? ' on' : '')} onClick={() => setAsk(ask === c ? '' : c)}>
                {c}
              </button>
            ))}
          </div>
          {scope === 'all' && (
            <div className="ai-brief">
              {hasBrief ? (
                <p className="small">
                  {[text(brief.product), text(brief.audience), text(brief.tone), typeof brief.targetSecs === 'number' ? fill(t.seconds, { s: brief.targetSecs }) : '']
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : (
                <p className="small muted">{t.aiBriefNone}</p>
              )}
              <button className="link small" onClick={p.onBrief}>
                {t.aiBriefEdit}
              </button>
            </div>
          )}
          <div className="sheet-foot">
            <div className="ai-using small">
              {ready ? (
                <span className="muted">{fill(t.aiUsing, { model: prof.model, provider: t[`aiProv_${info.provider}`] })}</span>
              ) : (
                <span className="warn-text">
                  <CircleAlert size={14} /> {t.aiNeedSetup}
                </span>
              )}
              <button className="link small" onClick={openAiSetup}>
                {ready ? t.aiChange : t.aiSetUp}
              </button>
            </div>
            <button className="primary" disabled={!ready} onClick={() => void run()} title="⌘↩">
              <Sparkles size={15} /> {t.aiRun}
            </button>
          </div>
        </>
      )}

      {phase.k === 'run' && (
        <div className="ai-running" role="status">
          <LoaderCircle size={22} className="spin" />
          <p>{phase.chars ? fill(t.aiWriting, { n: phase.chars }) : t.aiThinking}</p>
          <p className="small muted">{fill(t.aiUsing, { model: prof.model, provider: t[`aiProv_${info.provider}`] })}</p>
          <button className="secondary" onClick={() => void api.aiCancel()}>
            {t.aiCancel}
          </button>
        </div>
      )}

      {phase.k === 'error' && (
        <div className="ai-error" role="alert">
          <div className="row-title">
            <CircleAlert size={18} />
            <strong>{t[`aiErr_${phase.code}`]}</strong>
          </div>
          {phase.detail && phase.code !== 'setup' && <p className="mono small muted ai-detail">{phase.detail}</p>}
          <div className="sheet-foot">
            {(phase.code === 'setup' || phase.code === 'key') && (
              <button className="secondary" onClick={openAiSetup}>
                {t.aiSetUp}
              </button>
            )}
            <button className="primary" onClick={() => setPhase({ k: 'ask' })}>
              {t.aiAgain}
            </button>
          </div>
        </div>
      )}

      {phase.k === 'review' && <Review phase={phase} t={t} setOn={(on) => setPhase({ ...phase, on })} onAgain={() => setPhase({ k: 'ask' })} onApply={p.onApply} onDiscard={p.onClose} />}
    </Sheet>
  )
}

function Review(p: {
  phase: Extract<Phase, { k: 'review' }>
  t: Strings
  setOn: (on: boolean[]) => void
  onAgain: () => void
  onApply: (doc: Doc, n: number) => void
  onDiscard: () => void
}) {
  const { rows, on, out, model, base } = p.phase
  const { t } = p
  const changes = rows.map((r, k) => (isChange(r) ? k : -1)).filter((k) => k >= 0)
  const picked = changes.filter((k) => on[k]).length
  const same = rows.length - changes.length
  const result = applyAiRows(base, rows, on)
  return (
    <>
      {out.notes.trim() && <p className="ai-notes">{out.notes.trim()}</p>}
      <p className="small muted">{fill(t.aiBy, { model })}</p>
      {changes.length === 0 ? (
        <p className="ai-none">{t.aiNoChange}</p>
      ) : (
        <ul className="ai-rows">
          {changes.map((k) => (
            <li key={k}>
              <RowView row={rows[k]} on={on[k]} t={t} onToggle={() => p.setOn(on.map((v, j) => (j === k ? !v : v)))} />
            </li>
          ))}
        </ul>
      )}
      {same > 0 && <p className="small muted">{same === 1 ? t.aiUnchanged1 : fill(t.aiUnchanged, { n: same })}</p>}
      <div className="sheet-foot">
        <button className="link" onClick={p.onAgain}>
          {t.aiAgain}
        </button>
        <span className="grow" />
        <button className="secondary" onClick={p.onDiscard}>
          {t.aiDiscard}
        </button>
        <button className="primary" disabled={!picked || result.steps.length === 0} onClick={() => p.onApply(result, picked)}>
          {picked === 1 ? t.aiApply1 : fill(t.aiApply, { n: picked })}
        </button>
      </div>
    </>
  )
}

function Diff({ a, b }: { a: string; b: string }) {
  return (
    <>
      {readableDiff(a, b).map((d, i) =>
        d.op === '=' ? <span key={i}>{d.t}</span> : d.op === '+' ? <ins key={i}>{d.t}</ins> : <del key={i}>{d.t}</del>,
      )}
    </>
  )
}

function ActChange({ before, after }: { before: StepDoc; after: StepDoc }) {
  const A = ACT_ICON[before.act as Act] ?? ACT_ICON.manual
  const B = ACT_ICON[after.act as Act] ?? ACT_ICON.manual
  if (before.act === after.act) return <A size={15} />
  return (
    <span className="act-change">
      <A size={15} /> <ArrowRight size={12} /> <B size={15} />
    </span>
  )
}

function RowView({ row, on, t, onToggle }: { row: AiRow; on: boolean; t: Strings; onToggle: () => void }) {
  if (row.kind === 'title')
    return (
      <label className={'ai-row' + (on ? ' on' : '')}>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <div className="ai-row-body">
          <span className="ai-row-head">{t.aiTitleRow}</span>
          <p className="ai-say">
            <Diff a={row.before} b={row.after} />
          </p>
        </div>
      </label>
    )
  if (row.kind === 'drop')
    return (
      <label className={'ai-row drop' + (on ? ' on' : '')}>
        <input type="checkbox" checked={on} onChange={onToggle} />
        <div className="ai-row-body">
          <span className="ai-row-head">{fill(t.aiDropped, { n: row.from[0] + 1 })}</span>
          <p className="ai-say">
            <del>{text(row.before[0].tag) || text(row.before[0].say) || '…'}</del>
          </p>
        </div>
      </label>
    )
  const [first] = row.before
  const a = row.from[0] + 1
  const b = row.from[row.from.length - 1] + 1
  const tagBefore = text(first.tag)
  const tagAfter = text(row.after.tag)
  const sayBefore = row.before.map((s) => text(s.say)).filter(Boolean).join(' ')
  const sayAfter = text(row.after.say)
  return (
    <label className={'ai-row' + (on ? ' on' : '')}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <div className="ai-row-body">
        <span className="ai-row-head">
          <ActChange before={first} after={row.after} />
          {row.from.length > 1 ? fill(t.aiMerged, { a, b }) : fill(t.stepN, { n: a })}
          {(tagBefore || tagAfter) && (
            <span className="ai-tag">
              <Diff a={tagBefore} b={tagAfter} />
            </span>
          )}
        </span>
        <p className={'ai-say' + (sayAfter ? '' : ' silent')}>{sayBefore || sayAfter ? <Diff a={sayBefore} b={sayAfter} /> : t.aiSilent}</p>
      </div>
    </label>
  )
}

// ---------------------------------------------------------------- setup

type KeyMode = 'keep' | 'new' | 'remove'

export function AiSetupSheet({ info, t, onClose }: { info: AiInfo; t: Strings; onClose: () => void }) {
  const [provider, setProvider] = useState<AiProvider>(info.provider)
  const [model, setModel] = useState(profileOf(info).model)
  const [baseUrl, setBaseUrl] = useState(profileOf(info).baseUrl)
  const [proxy, setProxy] = useState(info.proxy)
  const [key, setKey] = useState('')
  const [keyMode, setKeyMode] = useState<KeyMode>(info.keys[info.provider] ? 'keep' : 'new')
  const [test, setTest] = useState<AiPing | 'running' | null>(null)
  const saved = info.keys[provider]
  const keyKind = AI_DEFAULTS[provider].key

  const choose = (p: AiProvider) => {
    const prof = profileOf(info, p)
    setProvider(p)
    setModel(prof.model)
    setBaseUrl(prof.baseUrl)
    setKey('')
    setKeyMode(info.keys[p] ? 'keep' : 'new')
    setTest(null)
  }
  const setup = (): AiSetup => ({
    provider,
    profile: { model: model.trim(), baseUrl: baseUrl.trim() },
    proxy: proxy.trim(),
    key: keyMode === 'new' ? (key.trim() ? key.trim() : saved ? undefined : null) : keyMode === 'remove' ? null : undefined,
  })
  const runTest = async () => {
    setTest('running')
    setTest(await api.aiTest(setup()))
  }
  const save = async () => {
    await api.aiSetup(setup())
    onClose()
  }

  return (
    <Sheet label={t.aiSettings} onClose={onClose}>
      <div className="sheet-head">
        <h2>
          <Sparkles size={18} /> {t.aiSettings}
        </h2>
        <button className="icon-btn" aria-label={t.close} title={t.close} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p className="small muted">{t.aiSettingsSub}</p>
      <div className="providers" role="radiogroup" aria-label={t.aiSettings}>
        {AI_PROVIDERS.map((p) => {
          const Icon = PROVIDER_ICON[p]
          return (
            <button key={p} role="radio" aria-checked={provider === p} className={'act-tile provider' + (provider === p ? ' on' : '')} onClick={() => choose(p)}>
              <Icon size={18} />
              <strong>{t[`aiProv_${p}`]}</strong>
              <span>{t[`aiProvSub_${p}`]}</span>
            </button>
          )
        })}
      </div>
      <div className="two">
        <label className="field">
          <span className="field-label">{t.aiModel}</span>
          <input className="mono" name="ai-model" value={model} placeholder={AI_DEFAULTS[provider].model} onChange={(e) => (setModel(e.target.value), setTest(null))} />
          <span className="hint">{t.aiModelHint}</span>
        </label>
        <label className="field">
          <span className="field-label">{t.aiAddress}</span>
          <input
            className="mono"
            name="ai-address"
            value={baseUrl}
            placeholder={AI_DEFAULTS[provider].baseUrl || 'https://'}
            onChange={(e) => (setBaseUrl(e.target.value), setTest(null))}
          />
          <span className="hint">{AI_DEFAULTS[provider].baseUrl ? fill(t.aiAddressDefault, { url: AI_DEFAULTS[provider].baseUrl }) : t.aiAddressNeeded}</span>
        </label>
      </div>
      {keyKind !== 'none' && (
        <div className="field">
          <span className="field-label">
            <KeyRound size={13} /> {t.aiKey}
          </span>
          {saved && keyMode !== 'new' ? (
            <div className="key-saved">
              <span className={keyMode === 'remove' ? 'muted strike' : ''}>{info.secure ? t.aiKeySaved : t.aiKeySavedMem}</span>
              <button className="link small" onClick={() => setKeyMode('new')}>
                {t.aiKeyReplace}
              </button>
              <button className="link small" onClick={() => setKeyMode(keyMode === 'remove' ? 'keep' : 'remove')}>
                {keyMode === 'remove' ? t.aiKeyKeep : t.aiKeyRemove}
              </button>
            </div>
          ) : (
            <>
              <input
                type="password"
                name="ai-key"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={keyKind === 'optional' ? t.aiKeyOptional : 'sk-…'}
                onChange={(e) => (setKey(e.target.value), setTest(null))}
              />
              {saved && (
                <button className="link small" onClick={() => (setKey(''), setKeyMode('keep'))}>
                  {t.aiKeyKeep}
                </button>
              )}
            </>
          )}
          <span className="hint">{info.secure ? t.aiKeyHint : t.aiKeyHintMem}</span>
        </div>
      )}
      <label className="field">
        <span className="field-label">{t.aiProxy}</span>
        <input className="mono" name="ai-proxy" value={proxy} placeholder="http://127.0.0.1:7890" onChange={(e) => (setProxy(e.target.value), setTest(null))} />
        <span className="hint">{t.aiProxyHint}</span>
      </label>
      {test && test !== 'running' && (
        <p className={'ai-test small ' + (test.ok ? 'ok-text' : 'warn-text')} role="status">
          {test.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          {test.ok ? fill(t.aiTestOk, { model: test.model }) : t[`aiErr_${test.error}`]}
          {!test.ok && test.detail && test.error !== 'setup' && <span className="mono muted"> {test.detail}</span>}
        </p>
      )}
      <div className="sheet-foot">
        <button className="secondary" disabled={test === 'running' || !model.trim()} onClick={() => void runTest()}>
          {test === 'running' ? (
            <>
              <LoaderCircle size={14} className="spin" /> {t.aiTesting}
            </>
          ) : (
            t.aiTest
          )}
        </button>
        <span className="grow" />
        <button className="secondary" onClick={onClose}>
          {t.cancel}
        </button>
        <button className="primary" onClick={() => void save()}>
          {t.aiSave}
        </button>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- sidebar

export function AiTile({ info, t }: { info: AiInfo; t: Strings }) {
  const prof = profileOf(info)
  const ready = aiReady(info)
  const missingKey = AI_DEFAULTS[info.provider].key === 'required' && !info.keys[info.provider]
  return (
    <div className="tile ai-tile">
      <h3>{t.aiTile}</h3>
      {prof.model && (ready || missingKey) ? (
        <p className="ai-tile-model">
          <span className={'dot' + (ready ? ' on' : '')} aria-hidden />
          <span>
            <span className="mono">{prof.model}</span>
            <span className="muted small"> · {missingKey ? t.aiKeyMissing : t[`aiProv_${info.provider}`]}</span>
          </span>
        </p>
      ) : (
        <p className="note">{t.aiTileOff}</p>
      )}
      <button className="secondary small" onClick={openAiSetup}>
        {ready ? t.aiChange : t.aiSetUp}
      </button>
    </div>
  )
}
