/**
 * "Can a recorder see the overlay?" self-test.
 *
 * Draws a four-colour pattern on the overlay, makes the overlay capturable for a moment and
 * grabs the screen (proves the capture path works and the pattern is detectable), then turns
 * protection back on and grabs again (the pattern must be gone). Each capture path is a probe:
 *   screencapture    macOS's own screenshot tool (ScreenCaptureKit underneath)
 *   desktopCapturer  Chromium's screen capture, the path browser-based meeting apps use
 * A probe whose capturable grab does not show the pattern is "inconclusive" (usually: no
 * Screen Recording permission), never a pass.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron'
import type { Rect } from '@cuelight/schema'
import type { ProbeName, ProbeResult, SelftestResult } from '../shared/types.ts'
import type { OverlayManager } from './overlay.ts'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Protection changes apply at the next desktop composition; give it a few frames. */
const SETTLE_MS = 700

/** Quadrants, in the order the overlay draws them: magenta, cyan, yellow, blue. */
const QUADRANTS: ((r: number, g: number, b: number) => boolean)[] = [
  (r, g, b) => r > 150 && g < 125 && b > 150,
  (r, g, b) => r < 125 && g > 150 && b > 150,
  (r, g, b) => r > 150 && g > 150 && b < 125,
  (r, g, b) => r < 125 && g < 125 && b > 150,
]

/** Share of sampled pixels (inner 60% of each quadrant) that have the expected colour. */
export function patternScore(img: NativeImage): number {
  const { width: w, height: h } = img.getSize()
  if (!w || !h) return 0
  const px = img.toBitmap() // BGRA
  let hit = 0
  let total = 0
  for (let q = 0; q < 4; q++) {
    const qx = (q % 2) * (w / 2)
    const qy = Math.floor(q / 2) * (h / 2)
    for (let y = qy + h * 0.1; y < qy + h * 0.4; y += Math.max(1, h / 80))
      for (let x = qx + w * 0.1; x < qx + w * 0.4; x += Math.max(1, w / 80)) {
        const o = (Math.floor(y) * w + Math.floor(x)) * 4
        total++
        if (QUADRANTS[q](px[o + 2], px[o + 1], px[o])) hit++
      }
  }
  return total ? hit / total : 0
}

type Grab = (rect: Rect, displayId: number, file: string) => Promise<NativeImage>

const grabScreencapture: Grab = async ([x, y, w, h], _id, file) => {
  await run('/usr/sbin/screencapture', ['-x', '-t', 'png', `-R${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`, file])
  return nativeImage.createFromPath(file)
}

const grabDesktopCapturer: Grab = async ([x, y, w, h], displayId, file) => {
  const d = screen.getAllDisplays().find((v) => v.id === displayId)!
  const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const src = sources.find((s) => s.display_id === String(displayId)) ?? sources[0]
  if (!src) throw new Error('no screen source')
  const t = src.thumbnail
  const ts = t.getSize()
  const sx = ts.width / d.bounds.width
  const sy = ts.height / d.bounds.height
  const img = t.crop({ x: Math.round((x - d.bounds.x) * sx), y: Math.round((y - d.bounds.y) * sy), width: Math.round(w * sx), height: Math.round(h * sy) })
  writeFileSync(file, img.toPNG())
  return img
}

const PROBES: Record<ProbeName, Grab | null> = {
  screencapture: process.platform === 'darwin' ? grabScreencapture : null,
  desktopCapturer: grabDesktopCapturer,
}

export async function runSelftest(overlay: OverlayManager, opts: { outDir?: string; keepProtection?: boolean } = {}): Promise<SelftestResult> {
  const display = screen.getPrimaryDisplay()
  const b = display.bounds
  const rect: Rect = [b.x + Math.round(b.width / 2 - 160), b.y + Math.round(b.height / 2 - 100), 320, 200]
  // Grabs show whatever is under the overlay, so they are deleted unless asked for.
  const dir = opts.outDir ?? mkdtempSync(join(tmpdir(), 'cuelight-selftest-'))
  mkdirSync(dir, { recursive: true })
  const wasProtected = opts.keepProtection ?? true

  overlay.showPattern(display.id, rect)
  await overlay.whenReady()
  const probes: ProbeResult[] = []
  try {
    for (const [name, grab] of Object.entries(PROBES) as [ProbeName, Grab | null][]) {
      if (!grab) continue
      const files = { allowed: join(dir, `${name}-capturable.png`), protected: join(dir, `${name}-protected.png`) }
      try {
        overlay.setProtection(false)
        await sleep(SETTLE_MS)
        const a = patternScore(await grab(rect, display.id, files.allowed))
        overlay.setProtection(true)
        await sleep(SETTLE_MS)
        const p = patternScore(await grab(rect, display.id, files.protected))
        const verdict = a < 0.8 ? 'inconclusive' : p <= 0.05 ? 'pass' : 'fail'
        probes.push({ name, visibleWhenAllowed: round(a), visibleWhenProtected: round(p), verdict, images: opts.outDir ? files : undefined })
      } catch (e) {
        probes.push({ name, visibleWhenAllowed: 0, visibleWhenProtected: 0, verdict: 'inconclusive', error: String((e as Error).message ?? e) })
      }
    }
  } finally {
    overlay.setProtection(wasProtected)
    overlay.showPattern(display.id, null)
    if (!opts.outDir) rmSync(dir, { recursive: true, force: true })
  }
  const decided = probes.filter((p) => p.verdict !== 'inconclusive')
  return {
    at: new Date().toISOString(),
    os: `${process.platform} ${process.getSystemVersion()}`,
    electron: process.versions.electron,
    display: { id: display.id, bounds: [b.x, b.y, b.width, b.height], scale: display.scaleFactor },
    pass: decided.length > 0 && decided.every((p) => p.verdict === 'pass'),
    probes,
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000
