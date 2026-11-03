import type { Offscreen } from './protocol.ts'
import type { Rect } from './storyboard.ts'

/** Where a page's viewport sits on screen. */
export type Viewport = {
  /** Viewport top-left in screen points */
  originX: number
  originY: number
  /** Page zoom factor (1 = 100%) */
  zoom: number
  /** innerWidth / innerHeight, in CSS pixels */
  width: number
  height: number
}

export type Box = { x: number; y: number; w: number; h: number }

/**
 * Element box (CSS pixels, relative to the viewport) to a spotlight rect in screen points.
 * When the element is above or below the viewport, the spotlight collapses into a strip
 * along that edge and the card tells the presenter which way to scroll; it follows the
 * element as soon as it scrolls into view.
 */
export function spotlightRect(el: Box, vp: Viewport): { rect: Rect | null; offscreen: Offscreen } {
  const z = vp.zoom
  const W = vp.width * z
  const H = vp.height * z
  if (el.y > vp.height - 8) return { rect: [vp.originX + 40, vp.originY + H - 70, Math.max(0, W - 80), 56], offscreen: 'below' }
  if (el.y + el.h < 8) return { rect: [vp.originX + 40, vp.originY + 14, Math.max(0, W - 80), 56], offscreen: 'above' }
  const x1 = Math.max(0, el.x)
  const y1 = Math.max(0, el.y)
  const x2 = Math.min(vp.width, el.x + el.w)
  const y2 = Math.min(vp.height, el.y + el.h)
  if (x2 <= x1 || y2 <= y1) return { rect: null, offscreen: null }
  return { rect: [vp.originX + x1 * z, vp.originY + y1 * z, (x2 - x1) * z, (y2 - y1) * z], offscreen: null }
}

/**
 * Card placement next to a spotlight, in the overlay's local coordinates: below the light,
 * else above, else to the right, else to the left. Without a light: near the top (under the
 * camera) or at the bottom.
 */
export function placeCard(
  hole: Rect | null,
  card: { w: number; h: number },
  screen: { w: number; h: number; top: number },
  fallback: 'top' | 'bottom' = 'top',
): { x: number; y: number } {
  const m = 24
  const gap = 22
  if (!hole) {
    const x = (screen.w - card.w) / 2
    return fallback === 'top' ? { x, y: screen.top + 16 } : { x, y: screen.h - card.h - 90 }
  }
  const [hx, hy, hw, hh] = hole
  const cx = Math.max(m, Math.min(screen.w - card.w - m, hx + hw / 2 - card.w / 2))
  const midY = Math.max(m, Math.min(screen.h - card.h - m, hy + hh / 2 - card.h / 2))
  if (hy + hh + gap + card.h < screen.h - m) return { x: cx, y: hy + hh + gap }
  if (hy - gap - card.h > m) return { x: cx, y: hy - gap - card.h }
  if (hx + hw + gap + card.w < screen.w - m) return { x: hx + hw + gap, y: midY }
  return { x: Math.max(m, hx - gap - card.w), y: midY }
}
