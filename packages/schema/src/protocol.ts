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

// ---------------------------------------------------------------- app → extension
export type AppMessage =
  | { t: 'welcome'; v: number; token?: string; app: string }
  | { t: 'denied'; reason: 'bad-code' | 'bad-token' | 'locked' | 'version' }
  | { t: 'target'; target: WebTarget | null }
  | { t: 'navigate'; url: string }
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
  | { t: 'ping' }
