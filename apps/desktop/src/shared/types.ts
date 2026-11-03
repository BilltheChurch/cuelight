/** Types shared by the main process, preloads and renderers. */
import type { HintKind, HowKind, Lang, Locator, Picked, RecEvent, Rect } from '@cuelight/schema'
import type { AiInfo, AiPing, AiRequest, AiResult, AiSetup } from './ai.ts'

export type CardKind = HowKind | 'preroll' | 'done'

/** The cue card for the current step. */
export type OverlayCard = {
  /** Changes on every step change, so the card animates to its new place */
  key: number
  n: number
  total: number
  tag: string
  how: string
  kind: CardKind
  say: string
  next: string
  /** Shown in green instead of the tag line (scroll hints, waiting, not found) */
  hint: string | null
  hintKind: HintKind | null
  /** Where the card goes when there is no spotlight */
  placement: 'top' | 'bottom'
}

/** What one display's overlay window draws, in that window's local coordinates. */
export type OverlayView = {
  visible: boolean
  /** around: dim everything but the hole; full: the target is on another display; none: no dimming */
  dim: 'around' | 'full' | 'none'
  hole: Rect | null
  inside: boolean
  /** Only the display that holds the spotlight (or the primary display) gets the card */
  card: OverlayCard | null
  progress: number | null
  capturable: boolean
  capturableLabel: string
  /** Self-test pattern, local coordinates */
  pattern: Rect | null
  /** Distance from the top of the display to the bottom of the menu bar */
  topInset: number
}

export type ProbeName = 'screencapture' | 'desktopCapturer'

export type ProbeResult = {
  name: ProbeName
  /** Share of pattern pixels found while the overlay was capturable (should be ~1) */
  visibleWhenAllowed: number
  /** Share of pattern pixels found while protected (should be ~0) */
  visibleWhenProtected: number
  verdict: 'pass' | 'fail' | 'inconclusive'
  error?: string
  images?: { allowed: string; protected: string }
}

export type SelftestResult = {
  at: string
  os: string
  electron: string
  display: { id: number; bounds: Rect; scale: number }
  pass: boolean
  probes: ProbeResult[]
}

/** The storyboard open in the editor. `rev` changes when a different file (or a new one) is opened. */
export type DocInfo = { path: string | null; example: boolean; rev: number }

/** The JSON as opened, in the author's own shape (not parsed, so it may not validate yet). */
export type DocPayload = DocInfo & { json: unknown }

export type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }

export type Rehearsal = { n: number; reason: string; secs: number; est: number | null; at: number }

export type BrowserInfo = { id: string; browser: string; connected: boolean; active: boolean; lastSeen: string | null }

export type AppState = {
  version: string
  platform: string
  lang: Lang
  langSetting: 'auto' | Lang
  doc: DocInfo | null
  loadError: { path: string; issues: string[] } | null
  examples: { id: string; title: string; description: string; steps: number }[]
  recent: string[]
  player: { phase: 'idle' | 'preroll' | 'step' | 'done'; n: number; total: number; hidden: boolean }
  bridge: { port: number | null; code: string; browsers: BrowserInfo[] }
  selftest: SelftestResult | null
  selftestRunning: boolean
  capturable: boolean
  /** The browser, or the native helper, is waiting for the presenter to pick an element */
  picking: boolean
  /** Targets in desktop apps (macOS): whether the helper is there and what the system allows */
  native: NativeStatus
  /** Recording a run in the browser: how many actions so far, and the latest one's label */
  recording: { typed: boolean; count: number; last: string | null } | null
  rehearsal: Rehearsal | null
  /** The AI service for writing lines, and which keys are saved (never the keys) */
  ai: AiInfo
}

export type NativeStatus = {
  available: boolean
  /** Accessibility: app elements and clicks outside the browser. null: not known yet */
  trusted: boolean | null
  /** Screen Recording: finding text on screen */
  screen: boolean | null
}

/** A pick for the editor: from the browser (dom locators) or from any app (ax, visual, region). */
export type PickResult = Omit<Picked, 'locators'> & { locators: Locator[]; app?: string }

export type ControlApi = {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): () => void
  openDialog(): Promise<void>
  openExample(id: string): Promise<void>
  openPath(path: string): Promise<void>
  /** A blank storyboard, or this JSON (a draft from a recording) as a new unsaved one */
  newDoc(json?: unknown): Promise<void>
  closeDoc(): Promise<void>
  getDoc(): Promise<DocPayload | null>
  /** The editor's current JSON: plays from here on, even before it is saved */
  setDraft(json: unknown): Promise<void>
  save(json: unknown, saveAs: boolean): Promise<SaveResult>
  play(from?: number): Promise<void>
  /** Play just this step, then stop */
  rehearse(index: number): Promise<void>
  stop(): Promise<void>
  /** Pick in the browser, or in any app; `reason` says why an app pick could not start */
  pick(on: boolean, where?: 'web' | 'app'): Promise<{ ok: boolean; reason?: 'denied' | 'unavailable' }>
  /** Ask for Accessibility or Screen Recording: the system prompt, or its page in System Settings */
  nativeAsk(what: 'ax' | 'screen'): Promise<void>
  /** Start (or, while on, switch `typed`) or stop recording; stopping returns the run */
  record(on: boolean, typed?: boolean): Promise<{ ok: boolean; events: RecEvent[] }>
  onPick(cb: (p: PickResult | null) => void): () => void
  runSelftest(): Promise<SelftestResult>
  setLang(lang: 'auto' | Lang): Promise<void>
  newCode(): Promise<void>
  forgetBrowser(id: string): Promise<void>
  revealExtension(): Promise<void>
  aiSetup(s: AiSetup): Promise<void>
  /** Try a setup, saved or not, with a tiny request */
  aiTest(s: AiSetup): Promise<AiPing>
  aiRun(req: AiRequest): Promise<AiResult>
  aiCancel(): Promise<void>
  /** Characters of the answer so far, while a request runs */
  onAiProgress(cb: (chars: number) => void): () => void
}

export type OverlayApi = {
  onView(cb: (v: OverlayView) => void): void
  onCursor(cb: (p: { x: number; y: number } | null) => void): void
  ready(): void
}
