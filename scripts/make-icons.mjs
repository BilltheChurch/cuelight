// Draws the Cuelight mark (a gold spotlight ring on a dark rounded square) into PNGs.
// No image libraries: a 4x4 supersampled rasterizer and a minimal PNG encoder.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const BG = [20, 20, 20]
const GOLD = [214, 168, 74]

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function draw(s) {
  const out = Buffer.alloc(s * s * 4)
  const r = s * 0.22
  const ss = 4
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      let bg = 0, ring = 0
      for (let j = 0; j < ss; j++)
        for (let i = 0; i < ss; i++) {
          const px = x + (i + 0.5) / ss, py = y + (j + 0.5) / ss
          // rounded square
          const qx = Math.max(Math.abs(px - s / 2) - (s / 2 - r), 0)
          const qy = Math.max(Math.abs(py - s / 2) - (s / 2 - r), 0)
          if (Math.hypot(qx, qy) <= r) bg++
          const d = Math.hypot(px - s / 2, py - s / 2)
          if (d <= s * 0.3 && d >= s * 0.3 - Math.max(1.5, s * 0.085)) ring++
        }
      const a = bg / (ss * ss), k = ring / (ss * ss)
      const o = (y * s + x) * 4
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(BG[c] * (1 - k) + GOLD[c] * k)
      out[o + 3] = Math.round(255 * a)
    }
  return out
}

const dir = new URL('../apps/extension/public/icons/', import.meta.url)
mkdirSync(dir, { recursive: true })
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`${s}.png`, dir), png(s, s, draw(s)))
const appDir = new URL('../apps/desktop/resources/', import.meta.url)
mkdirSync(appDir, { recursive: true })
writeFileSync(new URL('icon.png', appDir), png(512, 512, draw(512)))
console.log('icons written')
