import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearClockSkew,
  noteClockOk,
  clockSkewCopy,
  clockSkewErrorCopy,
  clockSkewOf,
  currentClockSkew,
  noteClockSkew,
  recheckClockSkew,
  skewAmount,
  subscribeClockSkew,
} from './clock-skew'

// The SDK's message, as QA captured it with the device clock 2 h ahead (QW2-018).
const AHEAD =
  'received invalid time: expected 1790800506217ms, received 1790793299956 ms, tolerance 1860000 ms; try another server'

afterEach(() => {
  clearClockSkew()
  vi.useRealTimers()
})

describe('clockSkewOf', () => {
  it('reads how far the device runs ahead, and the tolerance', () => {
    expect(clockSkewOf(new Error(AHEAD))).toEqual({ aheadMs: 7_206_261, toleranceMs: 1_860_000 })
    expect(clockSkewOf(`Could not connect to Dash Platform (${AHEAD}).`)?.aheadMs).toBe(7_206_261)
  })

  it('reads a clock that is behind as negative', () => {
    expect(clockSkewOf('received invalid time: expected 1000ms, received 4000000 ms, tolerance 1860000 ms')?.aheadMs).toBe(-3_999_000)
  })

  it('is null for any other error', () => {
    expect(clockSkewOf(new Error('timed out'))).toBeNull()
    expect(clockSkewOf(undefined)).toBeNull()
  })
})

describe('copy', () => {
  it('names the size and direction of the offset and the fix', () => {
    const copy = clockSkewErrorCopy(AHEAD)
    expect(copy?.title).toBe('Your device clock is wrong')
    expect(copy?.body).toContain('about 2 h ahead')
    expect(copy?.body).toContain('31 minutes')
    expect(copy?.body).toContain('update automatically')
    expect(copy?.body).not.toContain('try another server')
    expect(clockSkewCopy({ aheadMs: -45 * 60_000, toleranceMs: 1_860_000 }).body).toContain('about 45 min behind')
    expect(clockSkewErrorCopy('timed out')).toBeNull()
    // Under the app shell's banner, a view says it in one line.
    expect(clockSkewErrorCopy(AHEAD, { short: true })?.body).toBe(
      "This device's clock is about 2 h ahead of the Dash network's, so this read was refused. Set your clock to update automatically, then try again.",
    )
  })

  it('rounds to a readable amount', () => {
    expect(skewAmount(40 * 60_000)).toBe('about 40 min')
    expect(skewAmount(5 * 3_600_000)).toBe('about 5 h')
    expect(skewAmount(-3 * 86_400_000)).toBe('about 3 days')
  })
})

describe('the session store', () => {
  it('notes a clock error once and ignores others', () => {
    const listener = vi.fn()
    const off = subscribeClockSkew(listener)
    expect(noteClockSkew(new Error('timed out'))).toBe(false)
    expect(currentClockSkew()).toBeNull()
    expect(noteClockSkew(AHEAD)).toBe(true)
    expect(noteClockSkew(AHEAD)).toBe(true)
    expect(currentClockSkew()?.aheadMs).toBe(7_206_261)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('clears once an answer is accepted', () => {
    noteClockSkew(AHEAD)
    noteClockOk()
    expect(currentClockSkew()).toBeNull()
  })

  it('re-anchors a changed offset, so a partial fix is not read as a full one', () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_790_800_506_217)
    noteClockSkew(AHEAD)
    // Set back by 1 h: still about 1 h ahead.
    vi.setSystemTime(Date.now() - 3_600_000)
    vi.advanceTimersByTime(5_000)
    const once = currentClockSkew()?.aheadMs ?? 0
    expect(Math.abs(once - (7_206_261 - 3_600_000))).toBeLessThan(60_000)
    vi.advanceTimersByTime(5_000)
    expect(currentClockSkew()?.aheadMs).toBe(once)
  })

  it('clears by itself once the device clock agrees with the network again', () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_790_800_506_217)
    noteClockSkew(AHEAD)
    recheckClockSkew()
    expect(currentClockSkew()).not.toBeNull()
    // The user sets the clock right: the wall clock jumps back by the offset.
    vi.setSystemTime(Date.now() - 7_206_261)
    vi.advanceTimersByTime(5_000)
    expect(currentClockSkew()).toBeNull()
  })
})
