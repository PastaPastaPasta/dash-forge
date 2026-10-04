/**
 * What this browser keeps about an identity's top-ups after its key is forgotten or revoked
 * (QW3-034), in words for the forget and revoke confirmations: said rather than silently kept.
 */

import { topUpRecords } from '@/lib/auth/identity-top-up'
import { ACTIVE_NETWORK } from '@/lib/constants'

/**
 * What stays after a forget or a revoke, for an identity topped up in this browser (QW3-034).
 * Said rather than silently kept. `next`: where its next top-up starts; `unfinished`: a top-up
 * that has not finished.
 */
export function topUpRecordsStay(r: { readonly next: boolean; readonly unfinished: boolean }): string | null {
  if (r.unfinished) {
    return 'Your unfinished top-up stays in this browser (its deposit address and lock, no keys or recovery phrase), so Top up can still finish it.'
  }
  if (r.next) {
    return 'This browser keeps where your next top-up starts (no keys or recovery phrase), so the next top-up collects anything left at the last address.'
  }
  return null
}

/**
 * What a forget (and so a revoke, which forgets after it disables) deletes besides the key
 * (QW4-021): what this browser recorded for the identity, its spend history and its
 * notifications (QW2-028: a shared computer keeps no trace of the identity). Said in both
 * confirmations rather than erased silently; the history is not on chain, so it cannot be read back.
 */
export const FORGET_DELETES =
  "This browser also deletes what it recorded for this identity: its spend history (Settings → Spend), which is kept only here and can't be brought back, and its notifications."

/** How long the forget confirmation waits to learn what stays: a stalled storage read never blocks it. */
const RECORDS_READ_MS = 1500

/** What stays for `identityId` ({@link topUpRecordsStay}), or null; never waits long. */
export async function topUpStays(identityId: string): Promise<string | null> {
  const none = { next: false, unfinished: false }
  const records = await Promise.race([
    topUpRecords(ACTIVE_NETWORK.network, identityId).catch(() => none),
    new Promise<typeof none>((resolve) => setTimeout(() => resolve(none), RECORDS_READ_MS)),
  ])
  return topUpRecordsStay(records)
}
