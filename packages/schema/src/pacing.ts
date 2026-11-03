import type { Pace, Step, Storyboard } from './storyboard.ts'

export const DEFAULT_PACE: Pace = { unitsPerSec: 2, leadSecs: 1.2, minSecs: 2.5 }

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g

/**
 * How long a line takes to say, in "speech units": a Latin-script word is 1 unit,
 * a CJK character is half a unit (people say about 4 characters in the time of 2 English words).
 */
export function speechUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  const words = text.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return words + cjk / 2
}

/**
 * Seconds to read a step aloud. Tuned on a real 71-step recording: 2 words per second plus
 * 1.2 s to start and finish, never under 2.5 s. The timer only runs while the cursor rests
 * in the spotlight, so a presenter who pauses is not rushed.
 */
export function readSecs(step: Pick<Step, 'say' | 'secs'>, pace: Partial<Pace> = {}): number {
  if (step.secs !== undefined) return step.secs
  const p = { ...DEFAULT_PACE, ...pace }
  return Math.max(p.minSecs, speechUnits(step.say) / p.unitsPerSec + p.leadSecs)
}

/** Planned seconds for one step: its line, a wait (its timeout, else 3 s), or 1.5 s for a silent click. */
export function stepSecs(s: Step, pace: Partial<Pace> = {}): number {
  if (s.act === 'wait') return s.secs ?? s.until?.timeoutSecs ?? 3
  return s.say ? readSecs(s, pace) : 1.5
}

/** Rough length of a run, for the storyboard summary and exports without a rehearsal. */
export function estimateSecs(sb: Storyboard): number {
  return sb.steps.reduce((t, s) => t + stepSecs(s, sb.pace), 0)
}
