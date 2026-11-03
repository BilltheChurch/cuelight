/**
 * Records what the presenter does on the page while the editor records a run: clicks, with
 * locators for the element, and typing, as where and how much. The typed text itself is kept
 * only when the author asked for it, and never for passwords, card numbers or one-time codes.
 * Navigation between pages is the background worker's to record.
 */
import type { RecEvent } from '@cuelight/schema'
import { pageEnv } from './locate.ts'
import { describe, pickable, suggestLocators } from './suggest.ts'

type Field = { el: HTMLInputElement | HTMLTextAreaElement | HTMLElement; at: number; ev: Extract<RecEvent, { k: 'type' }> }

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''])
const SECRET_AUTOCOMPLETE = /cc-|password|one-time-code|card/i

const isField = (el: EventTarget | null): el is HTMLElement =>
  (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)

const valueOf = (el: HTMLElement) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''))

const secret = (el: HTMLElement) =>
  (el instanceof HTMLInputElement && el.type === 'password') || SECRET_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '') || SECRET_AUTOCOMPLETE.test(el.getAttribute('name') ?? '')

export class Recorder {
  private on = false
  private typed = false
  private field: Field | null = null

  constructor(private emit: (e: RecEvent) => void) {}

  start(typed: boolean) {
    this.typed = typed
    if (this.on) return
    this.on = true
    addEventListener('pointerdown', this.down, { capture: true, passive: true })
    addEventListener('input', this.input, true)
    addEventListener('keydown', this.key, true)
    addEventListener('focusout', this.blur, true)
    addEventListener('pagehide', this.flush, true)
  }

  stop() {
    if (!this.on) return
    this.flush()
    this.on = false
    removeEventListener('pointerdown', this.down, true)
    removeEventListener('input', this.input, true)
    removeEventListener('keydown', this.key, true)
    removeEventListener('focusout', this.blur, true)
    removeEventListener('pagehide', this.flush, true)
  }

  private down = (e: PointerEvent) => {
    if (!e.isTrusted || !e.isPrimary || e.button !== 0) return
    const hit = e.composedPath()[0]
    if (!(hit instanceof Element)) return
    this.flush()
    // Work out the locators now: the click may well change or remove the element.
    const el = pickable(hit)
    const { label, role } = describe(el)
    this.emit({ k: 'click', at: Date.now(), url: location.href, locators: suggestLocators(el, pageEnv()), label, role })
  }

  private input = (e: Event) => {
    const el = e.composedPath()[0] ?? e.target
    if (!e.isTrusted || !isField(el)) return
    if (this.field && this.field.el !== el) this.flush()
    if (!this.field) {
      const { label, role } = describe(el)
      this.field = { el, at: Date.now(), ev: { k: 'type', at: Date.now(), url: location.href, locators: suggestLocators(el, pageEnv()), label, role, chars: 0, enter: false } }
    }
  }

  private key = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing && this.field && e.composedPath()[0] === this.field.el && !(this.field.el instanceof HTMLTextAreaElement)) {
      this.field.ev.enter = true
      this.flush()
    }
  }

  private blur = (e: FocusEvent) => {
    if (this.field && e.composedPath()[0] === this.field.el) this.flush()
  }

  private flush = () => {
    const f = this.field
    if (!f) return
    this.field = null
    const value = valueOf(f.el)
    this.emit({ ...f.ev, chars: [...value].length, ...(this.typed && !secret(f.el) && value ? { text: value } : {}) })
  }
}
