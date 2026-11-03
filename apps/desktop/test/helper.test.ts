import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Helper, HelperError, type HelperEvent } from '../src/main/helper.ts'

const fake = join(import.meta.dirname, 'fixtures', 'fake-helper.mjs')
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof HelperError ? e.code : String(e)))

describe('Helper', () => {
  it('starts on first use, pairs replies with requests, and passes events on', async () => {
    let now = 0
    const h = new Helper([process.execPath, fake], () => now)
    const events: HelperEvent[] = []
    h.onEvent((e) => events.push(e))
    const [a, b] = await Promise.all([h.request('echo', { n: 1 }), h.request('status')])
    expect(a).toMatchObject({ ok: true, args: { cmd: 'echo', n: 1 } })
    expect(b).toMatchObject({ trusted: false, screen: false })
    await h.request('click', { x: 5, y: 6 })
    expect(events).toEqual([
      { ev: 'ready', version: 'test' },
      { ev: 'click', x: 5, y: 6 },
    ])
    expect(await code(h.request('nope'))).toBe('unknown command')
    expect(await code(h.request('hang', {}, 50))).toBe('timeout')

    // When it dies, waiting requests fail, it says so, and it is not started again right away.
    const pending = code(h.request('hang', {}, 5000))
    const died = code(h.request('die'))
    expect(await died).toBe('unavailable')
    expect(await pending).toBe('unavailable')
    expect(events.at(-1)).toEqual({ ev: 'exit' })
    expect(await code(h.request('status'))).toBe('unavailable')
    now += 3000
    expect(await h.request('status')).toMatchObject({ ok: true })
    h.stop()
  })

  it('gives up for good when the binary is not there', async () => {
    let now = 0
    const h = new Helper(['/nonexistent/cuelight-helper'], () => now)
    expect(await code(h.request('status'))).toBe('unavailable')
    now += 10_000
    expect(await code(h.request('status'))).toBe('unavailable')
    expect(h.usable).toBe(false)
  })
})
