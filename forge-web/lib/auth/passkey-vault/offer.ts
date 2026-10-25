/**
 * The one-time offer to add a passkey after signing in (`components/passkey-offer.tsx`): it must
 * never nag. Per identity on this browser it shows at most {@link MAX_OFFERS} times, once per page
 * load, and never again after "Not now" or once a passkey exists (added here or signed in with).
 * The record is localStorage, per network and identity; a browser that blocks it shows nothing.
 */

import type { Network } from '../../constants'

/** How many page loads may show the offer, whatever the user does with it. */
export const MAX_OFFERS = 2

interface OfferRecord {
  readonly shown: number
  readonly done: boolean
}

const key = (network: Network, identityId: string): string => `forge.passkey-offer:${network}:${identityId}`

function read(network: Network, identityId: string): OfferRecord | null {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(key(network, identityId)) ?? 'null')
    if (typeof v !== 'object' || v === null) return { shown: 0, done: false }
    const r = v as Partial<OfferRecord>
    return { shown: typeof r.shown === 'number' && r.shown >= 0 ? r.shown : 0, done: r.done === true }
  } catch {
    // Storage blocked or unreadable: no record, so no way to promise it will not repeat.
    return null
  }
}

function write(network: Network, identityId: string, record: OfferRecord): boolean {
  try {
    window.localStorage.setItem(key(network, identityId), JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/** Whether to show the offer now: not dismissed, not shown {@link MAX_OFFERS} times, and storage works. */
export function shouldOffer(network: Network, identityId: string): boolean {
  const r = read(network, identityId)
  return r !== null && !r.done && r.shown < MAX_OFFERS
}

/** Count a showing. Returns false when it could not be recorded (then nothing is shown). */
export function noteOffered(network: Network, identityId: string): boolean {
  const r = read(network, identityId)
  return r !== null && write(network, identityId, { shown: r.shown + 1, done: r.done })
}

/** Never offer again for this identity on this browser ("Not now", or a passkey was added). */
export function dismissOffer(network: Network, identityId: string): void {
  const r = read(network, identityId)
  write(network, identityId, { shown: r?.shown ?? 0, done: true })
}
