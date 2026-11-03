import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  FileJson,
  FilePlus,
  FolderOpen,
  ListChecks,
  Mic,
  RefreshCw,
  ShieldCheck,
  Square,
  type LucideIcon,
} from 'lucide-react'
import { keyLabels } from '@cuelight/schema'
import type { AppState, ControlApi, ProbeResult } from '../../../shared/types.ts'
import { Editor } from './editor.tsx'
import { fill, strings, type Strings } from './i18n.ts'
import './control.css'

declare global {
  interface Window {
    cuelight: ControlApi
  }
}

const api = window.cuelight

const EXAMPLE_ICON: Record<string, LucideIcon> = { todomvc: ListChecks, 'wikipedia-tour': BookOpen, 'talk-only': Mic }

function App() {
  const [s, setS] = useState<AppState | null>(null)
  useEffect(() => {
    void api.getState().then(setS)
    return api.onState(setS)
  }, [])
  if (!s) return null
  const t = strings[s.lang]
  const keys = keyLabels(s.platform)
  document.documentElement.lang = s.lang === 'zh' ? 'zh-CN' : 'en'
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden />
          <span className="name">Cuelight</span>
          <span className="tagline">{t.tagline}</span>
        </div>
        <span className="version">v{s.version}</span>
      </header>
      <main className="grid">
        <section className="main">
          {s.player.phase !== 'idle' && <NowPlaying s={s} t={t} keys={keys} />}
          {s.doc ? <Editor s={s} t={t} /> : <Picker s={s} t={t} />}
          {s.loadError && (
            <div className="tile error">
              <div className="row-title">
                <CircleAlert size={18} />
                <strong>{t.loadError}</strong>
              </div>
              <p className="muted mono small">{s.loadError.path}</p>
              <ul className="issues">
                {s.loadError.issues.slice(0, 12).map((i) => (
                  <li key={i} className="mono small">
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <aside className="side">
          <BrowserTile s={s} t={t} />
          <CaptureTile s={s} t={t} />
          <div className="tile">
            <h3>{t.hotkeys}</h3>
            <dl className="keys">
              <dt>
                <kbd>{keys.nextKey}</kbd>
              </dt>
              <dd>{t.hkNext}</dd>
              <dt>
                <kbd>{keys.prevKey}</kbd>
              </dt>
              <dd>{t.hkPrev}</dd>
              <dt>
                <kbd>{keys.hideKey}</kbd>
              </dt>
              <dd>{t.hkHide}</dd>
            </dl>
            <p className="note">{t.hkNote}</p>
          </div>
          <div className="lang" role="radiogroup" aria-label={t.language}>
            {(['auto', 'en', 'zh'] as const).map((l) => (
              <button key={l} role="radio" aria-checked={s.langSetting === l} className={s.langSetting === l ? 'on' : ''} onClick={() => void api.setLang(l)}>
                {l === 'auto' ? t.auto : l === 'en' ? 'English' : '中文'}
              </button>
            ))}
          </div>
        </aside>
      </main>
    </div>
  )
}

function Picker({ s, t }: { s: AppState; t: Strings }) {
  return (
    <>
      <div className="heading">
        <h1>{t.pickTitle}</h1>
        <p className="muted">{t.pickSub}</p>
      </div>
      <div className="tiles">
        <button className="choice" onClick={() => void api.newDoc()}>
          <span className="choice-icon">
            <FilePlus size={22} />
          </span>
          <strong>{t.newBoard}</strong>
          <span className="muted">{t.newBoardSub}</span>
        </button>
        <button className="choice" onClick={() => void api.openDialog()}>
          <span className="choice-icon">
            <FolderOpen size={22} />
          </span>
          <strong>{t.openFile}</strong>
          <span className="muted">{t.openFileSub}</span>
        </button>
        {s.examples.map((e) => {
          const Icon = EXAMPLE_ICON[e.id] ?? FileJson
          return (
            <button key={e.id} className="choice" onClick={() => void api.openExample(e.id)}>
              <span className="choice-icon">
                <Icon size={22} />
              </span>
              <strong>{e.title}</strong>
              <span className="muted clamp">{e.description}</span>
              <span className="chip">{fill(t.steps, { n: e.steps })}</span>
            </button>
          )
        })}
      </div>
      {s.recent.length > 0 && (
        <div className="tile">
          <h3>{t.recent}</h3>
          <ul className="recent">
            {s.recent.map((p) => (
              <li key={p}>
                <button className="link mono small" onClick={() => void api.openPath(p)}>
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function NowPlaying({ s, t, keys }: { s: AppState; t: Strings; keys: ReturnType<typeof keyLabels> }) {
  const p = s.player
  const label = p.phase === 'preroll' ? fill(t.prerollNote, { next: keys.nextKey }) : p.phase === 'done' ? t.finished : fill(t.stepOf, { n: p.n, total: p.total })
  return (
    <div className="tile playing">
      <span className="live" aria-hidden />
      <div>
        <strong>{t.playing}</strong>
        <span className="muted"> · {label}</span>
        {p.hidden && <p className="muted small">{fill(t.hiddenNote, { hide: keys.hideKey })}</p>}
      </div>
      <button className="secondary" onClick={() => void api.stop()}>
        <Square size={14} /> {t.stop}
      </button>
    </div>
  )
}

function BrowserTile({ s, t }: { s: AppState; t: Strings }) {
  const live = s.bridge.browsers.filter((b) => b.connected)
  const pairing = live.length === 0
  return (
    <div className="tile">
      <h3>{pairing ? t.pairTitle : t.browser}</h3>
      {s.bridge.browsers.length > 0 && (
        <ul className="browsers">
          {s.bridge.browsers.map((b) => (
            <li key={b.id}>
              <span className={'dot' + (b.connected ? ' on' : '')} aria-hidden />
              <span>
                {b.browser}
                <span className="muted small"> · {b.connected ? (b.active ? t.active : t.connected) : t.notConnected}</span>
              </span>
              <button className="link small" onClick={() => void api.forgetBrowser(b.id)}>
                {t.forget}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pairing && (
        <ol className="pair">
          <li>
            <p>{t.pair1}</p>
            <button className="secondary small" onClick={() => void api.revealExtension()}>
              <FolderOpen size={14} /> {t.pair1Btn}
            </button>
          </li>
          <li>
            <p>{t.pair2}</p>
          </li>
          <li>
            <p>{t.pair3}</p>
            <div className="code" aria-label="pairing code">
              {s.bridge.code.slice(0, 3)}
              <span> </span>
              {s.bridge.code.slice(3)}
            </div>
            <button className="link small" onClick={() => void api.newCode()}>
              <RefreshCw size={12} /> {t.newCode}
            </button>
          </li>
        </ol>
      )}
      {s.bridge.port && <p className="note mono">{fill(t.listening, { port: s.bridge.port })}</p>}
    </div>
  )
}

function CaptureTile({ s, t }: { s: AppState; t: Strings }) {
  const r = s.selftest
  const state = !r ? 'never' : r.pass ? 'pass' : r.probes.every((p) => p.verdict === 'inconclusive') ? 'inconclusive' : 'fail'
  const Icon = state === 'pass' ? ShieldCheck : state === 'fail' ? CircleAlert : CircleHelp
  return (
    <div className="tile">
      <h3>{t.captureTitle}</h3>
      <div className={'verdict ' + state}>
        <Icon size={20} />
        <div>
          <strong>{t[state]}</strong>
          {r && <p className="muted small">{new Date(r.at).toLocaleString()}</p>}
        </div>
      </div>
      {r && (
        <ul className="probes">
          {r.probes.map((p) => (
            <Probe key={p.name} p={p} t={t} />
          ))}
        </ul>
      )}
      {r?.probes.some((p) => p.verdict === 'inconclusive') && <p className="note">{t.permissionHint}</p>}
      {s.capturable && <p className="note warn">{t.capturableWarn}</p>}
      <p className="note">{t.captureSub}</p>
      <button className="secondary" disabled={s.selftestRunning || s.player.phase !== 'idle'} onClick={() => void api.runSelftest()}>
        <ShieldCheck size={15} /> {s.selftestRunning ? t.running : t.runCheck}
      </button>
      <p className="note">{t.testRecorder}</p>
    </div>
  )
}

function Probe({ p, t }: { p: ProbeResult; t: Strings }) {
  const Icon = p.verdict === 'pass' ? CircleCheck : p.verdict === 'fail' ? CircleAlert : CircleHelp
  return (
    <li className={p.verdict}>
      <Icon size={15} />
      <span>
        {t[`probe_${p.name}`]} · <strong>{t[`verdict_${p.verdict}`]}</strong>
        <span className="muted small block">
          {p.error ?? fill(t.probeNumbers, { a: Math.round(p.visibleWhenAllowed * 100), p: Math.round(p.visibleWhenProtected * 100) })}
        </span>
      </span>
    </li>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
