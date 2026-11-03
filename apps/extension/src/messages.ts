import type { ExtMessage, WebTarget } from '@cuelight/schema'

/**
 * How far this window's viewport sits from where outerHeight/innerHeight alone put it, in screen
 * points. Learned from the first real mouse move on any page; e.g. Edge draws pages 4pt inside
 * its frame. Kept per window so a freshly loaded page is right before the mouse moves again.
 */
export type Correction = { x: number; y: number }

/** background → content script */
export type ToContent =
  | { t: 'target'; target: WebTarget | null; zoom: number; corr: Correction | null }
  | { t: 'zoom'; zoom: number }
  | { t: 'pick'; on: boolean }
  | { t: 'record'; on: boolean; typed: boolean }
  | { t: 'probe' }
  | { t: 'debug' }

/** content script → background */
export type FromContent =
  | Extract<ExtMessage, { t: 'rect' | 'click' | 'pointer' | 'until' | 'picked' | 'pick-end' | 'rec' }>
  | { t: 'ready' }
  | ({ t: 'corr' } & Correction)

export type BridgeStatus = 'offline' | 'unpaired' | 'connecting' | 'connected' | 'denied'

export type PopupState = {
  status: BridgeStatus
  port: number | null
  error: string | null
  app: string | null
  show: { playing: boolean; n: number; total: number; title: string; loaded: boolean } | null
}

/** popup → background */
export type FromPopup =
  | { t: 'state' }
  | { t: 'pair'; code: string }
  | { t: 'unpair' }
  | { t: 'control'; cmd: 'play' | 'next' | 'prev' | 'hide' | 'stop' }
