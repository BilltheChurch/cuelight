/**
 * Wire protocol between the desktop app and the browser extension.
 *
 * The app listens on ws://127.0.0.1:<port> (first free port in BRIDGE_PORTS) and only accepts
 * connections whose Origin is a browser extension. The first connection pairs with a 6-digit
 * code shown in the app; after that the extension keeps a long random token.
 *
 * Coordinates are global screen points (DIP), origin at the top-left of the primary display,
 * the same space as Electron's `screen` module and Chrome's `window.screenX`.
 */
import type { RecEvent } from './record.ts'
import type { Act, DomLocator, Rect, Until } from './storyboard.ts'

export const PROTOCOL_VERSION = 1
export const BRIDGE_PORTS = [41753, 41754, 41755, 41756, 41757] as const

/** What the extension should spotlight. `seq` changes every time a step (re)starts. */
export type WebTarget = {
  seq: number
  act: Act
  locators: DomLocator[]
  until?: WebUntil
}
/** `until` with only the DOM parts the extension can check. */
export type WebUntil = Omit<Until, 'appear' | 'gone'> & { appear?: DomLocator[]; gone?: DomLocator[] }

export type Offscreen = 'below' | 'above' | null

/** An element the presenter picked in the browser for the editor. */
export type Picked = {
  /** Fallback chain, most stable signal first; each entry resolves back to the picked element */
  locators: DomLocator[]
  /** Short human label: the accessible name or the visible text */
  label: string
  role: string | null
  url: string
  title: string
}

// ---------------------------------------------------------------- app → extension
export type AppMessage =
  | { t: 'welcome'; v: number; token?: string; app: string }
  | { t: 'denied'; reason: 'bad-code' | 'bad-token' | 'locked' | 'version' }
  | { t: 'target'; target: WebTarget | null }
  | { t: 'navigate'; url: string }
  /** Editor: start or stop the element picker in the stage tab */
  | { t: 'pick'; on: boolean }
  /** Editor: record what the presenter does in the browser. `typed`: keep the text typed into fields */
  | { t: 'record'; on: boolean; typed: boolean }
  | { t: 'status'; playing: boolean; n: number; total: number; title: string; loaded: boolean }
  | { t: 'pong' }

// ---------------------------------------------------------------- extension → app
export type ExtMessage =
  | { t: 'hello'; v: number; token?: string; code?: string; browser: string; ext: string }
  | {
      t: 'rect'
      seq: number
      /** Spotlight rect in screen points (clipped to the viewport), or null when not on screen */
      rect: Rect | null
      found: boolean
      offscreen: Offscreen
      url: string
    }
  | { t: 'click'; seq: number }
  | { t: 'pointer'; seq: number; inside: boolean }
  | { t: 'until'; seq: number }
  | { t: 'focus'; focused: boolean }
  | { t: 'control'; cmd: 'play' | 'next' | 'prev' | 'hide' | 'stop' }
  | { t: 'picked'; pick: Picked }
  /** The picker closed without a pick (Esc, or the tab went away) */
  | { t: 'pick-end' }
  | { t: 'rec'; ev: RecEvent }
  | { t: 'ping' }
