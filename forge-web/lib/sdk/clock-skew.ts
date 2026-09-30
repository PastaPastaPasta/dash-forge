/**
 * A device clock too far off Platform's (QW2-018). Every Platform answer carries the time its
 * block was made, and the SDK refuses one whose time is more than its tolerance (31 min) from
 * this device's clock, as a stale node: "received invalid time: expected <now> ms, received
 * <block time> ms, tolerance <t> ms". When the clock is the thing that is off, every read,
 * sign-in and write fails that way, and "try another server" (the SDK's hint) never helps.
 *
 * `expected` is this device's clock and `received` the network's, so their difference is how
 * far the device runs ahead (negative: behind). A single stale node is possible, but the SDK
 * has already tried others before it gives up, so the message is reported as the clock.
 *
 * A session store, so the app shell and the Verification card can say it once: the offset is
 * noted with a monotonic timestamp, and it clears by itself once the device clock agrees with
 * the network's again (the user fixed it), without a reload.
 */

import { errorMessage } from '../utils'

const CLOCK_SKEW = /received invalid time: expected (\d+)\s*ms, received (\d+)\s*ms(?:, tolerance (\d+)\s*ms)?/i

/** The SDK's tolerance, used when the message does not state one. */
export const CLOCK_TOLERANCE_MS = 31 * 60_000

export interface ClockSkew {
  /** How far this device's clock runs ahead of the network's (negative: behind), in ms. */
  readonly aheadMs: number
  /** The tolerance the SDK applied. */
  readonly toleranceMs: number
}

/** The clock offset an SDK error reports, or null for any other error. */
export function clockSkewOf(e: unknown): ClockSkew | null {
  const m = CLOCK_SKEW.exec(errorMessage(e, ''))
  if (m === null) return null
  const expected = Number(m[1])
  const received = Number(m[2])
  const tolerance = m[3] === undefined ? CLOCK_TOLERANCE_MS : Number(m[3])
  if (!Number.isFinite(expected) || !Number.isFinite(received)) return null
  return { aheadMs: expected - received, toleranceMs: tolerance }
}

/** "about 2 h", "about 45 min", "about 3 days": the size of an offset, for copy. */
export function skewAmount(ms: number): string {
  const abs = Math.abs(ms)
  const min = Math.round(abs / 60_000)
  if (min < 90) return `about ${min} min`
  const hours = Math.round(abs / 3_600_000)
  if (hours < 48) return `about ${hours} h`
  return `about ${Math.round(abs / 86_400_000)} days`
}

/**
 * The plain sentence for a clock offset: what is wrong and how to fix it. `short`: for a view's
 * own error state, under the app shell's banner that already explains why.
 */
export function clockSkewCopy(skew: ClockSkew, { short = false }: { readonly short?: boolean } = {}): { readonly title: string; readonly body: string } {
  const way = skew.aheadMs >= 0 ? 'ahead' : 'behind'
  const tolerance = Math.round(skew.toleranceMs / 60_000)
  const off = `This device's clock is ${skewAmount(skew.aheadMs)} ${way} of the Dash network's`
  const fix = 'Set your clock to update automatically, then try again.'
  return {
    title: 'Your device clock is wrong',
    body: short
      ? `${off}, so this read was refused. ${fix}`
      : `${off}. Every answer from the network is stamped with its time, and one more than ${tolerance} minutes off your clock is refused, so nothing can be read, checked or signed. ${fix}`,
  }
}

/** The copy for `e` when it is a clock offset, else null. */
export function clockSkewErrorCopy(e: unknown, opts?: { readonly short?: boolean }): { readonly title: string; readonly body: string } | null {
  const skew = clockSkewOf(e)
  return skew === null ? null : clockSkewCopy(skew, opts)
}

interface Noted {
  readonly skew: ClockSkew
  /** `performance.now()` when it was noted: the network's time moves on from `received` with it. */
  readonly at: number
  /** `Date.now()` when noted. */
  readonly wall: number
}

let noted: Noted | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function emit(): void {
  for (const l of listeners) l()
}

/** How often a noted offset is re-measured against the device clock. */
const RECHECK_MS = 5_000

function recheck(): void {
  if (noted === null) return
  // The network's time now, from the noted answer, carried forward by the monotonic clock; the
  // wall clock the user may have corrected is compared with it.
  const elapsed = monotonicNow() - noted.at
  const networkNow = noted.wall - noted.skew.aheadMs + elapsed
  const aheadMs = Date.now() - networkNow
  if (Math.abs(aheadMs) <= noted.skew.toleranceMs) {
    clearClockSkew()
    return
  }
  if (Math.abs(aheadMs - noted.skew.aheadMs) > 60_000) {
    noted = { ...noted, skew: { ...noted.skew, aheadMs } }
    emit()
  }
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Record the offset `e` reports (no-op for any other error). Returns whether it was one. */
export function noteClockSkew(e: unknown): boolean {
  const skew = clockSkewOf(e)
  if (skew === null) return false
  const changed = noted === null || Math.abs(noted.skew.aheadMs - skew.aheadMs) > 60_000
  noted = { skew, at: monotonicNow(), wall: Date.now() }
  if (timer === null && typeof setInterval !== 'undefined') timer = setInterval(recheck, RECHECK_MS)
  if (changed) emit()
  return true
}

/** The offset this session last saw, while the device clock still disagrees; else null. */
export function currentClockSkew(): ClockSkew | null {
  return noted?.skew ?? null
}

/** Forget the offset (the clock agrees again; tests). */
export function clearClockSkew(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  if (noted === null) return
  noted = null
  emit()
}

export function subscribeClockSkew(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Re-measure now (tests; the interval does it otherwise). */
export function recheckClockSkew(): void {
  recheck()
}
