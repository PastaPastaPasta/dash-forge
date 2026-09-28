import { describe, expect, it } from 'vitest'

import { consumePrehydrationIntent, INTENT_TTL_MS, PREHYDRATION_KEY, prehydrationScript, stopPrehydrationCatcher } from './prehydration'

/**
 * A window holding the inline script's state, with the script's own `stop` (the script itself
 * runs in the browser specs): it stops catching and clears the busy look, keeping the intent.
 */
function win(intent: string | null, at: number): { w: Window; stops: () => number } {
  // Run the real inline script against a minimal window and document to get its `stop`.
  const noop = { addEventListener: () => undefined, removeEventListener: () => undefined }
  const w: Record<string, unknown> = { ...noop }
  new Function('window', 'document', 'setTimeout', 'clearTimeout', prehydrationScript())(w, noop, () => 0, () => undefined)
  const state = w[PREHYDRATION_KEY] as { intent: string | null; at: number; stop: () => void }
  state.intent = intent
  state.at = at
  let stops = 0
  const stop = state.stop
  state.stop = () => {
    stops += 1
    stop()
  }
  return { w: w as unknown as Window, stops: () => stops }
}

describe('a tap caught before hydration', () => {
  it('is acted on once, whichever of the two mount effects runs first', () => {
    // Providers first (it only stops the catcher), then the header.
    const a = win('sign-in', 1_000)
    stopPrehydrationCatcher(a.w as never)
    expect(consumePrehydrationIntent('sign-in', a.w as never, 2_000)).toBe(true)
    expect(consumePrehydrationIntent('sign-in', a.w as never, 2_000)).toBe(false)
    // The header first, then Providers.
    const b = win('sign-in', 1_000)
    expect(consumePrehydrationIntent('sign-in', b.w as never, 2_000)).toBe(true)
    stopPrehydrationCatcher(b.w as never)
    expect(consumePrehydrationIntent('sign-in', b.w as never, 2_000)).toBe(false)
    expect(a.stops()).toBeGreaterThan(0)
  })

  it('is ignored when stale, and a different or missing intent opens nothing', () => {
    expect(consumePrehydrationIntent('sign-in', win('sign-in', 0).w as never, INTENT_TTL_MS + 1)).toBe(false)
    expect(consumePrehydrationIntent('sign-in', win('other', 0).w as never, 1)).toBe(false)
    expect(consumePrehydrationIntent('sign-in', win(null, 0).w as never, 1)).toBe(false)
    expect(consumePrehydrationIntent('sign-in', {} as never, 1)).toBe(false)
  })
})
