/**
 * Threads this browser saw its identity take part in where no index can find that again
 * (QW2-009): a review (`review` has no index by author) and a mention (free text). The inbox
 * follows them as it follows threads the identity opened or commented on. Kept in the inbox's
 * IndexedDB store, per network and identity, like the rest of the inbox: nothing leaves the
 * device, and another device does not know about them.
 */

import type { Network } from '../constants'
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'

/** Why a thread is followed without an index to say so. */
export type ParticipationReason = 'reviewed' | 'mentioned'

export interface Participation {
  readonly targetId: string
  readonly reason: ParticipationReason
  /** When it happened (ms): activity before it is not news. */
  readonly at: number
}

/** At most this many are kept (the newest). */
export const MAX_PARTICIPATION = 200

function prefix(network: Network, me: string): string {
  return `${network}:${me}:participated:`
}

/**
 * Remember that `me` took part in `targetId`. The earliest time is kept, and a review wins over a
 * mention (it is the stronger reason). Never throws: losing the record only loses the follow.
 */
export async function noteParticipation(network: Network, me: string, targetId: string, reason: ParticipationReason, at = Date.now()): Promise<void> {
  if (targetId === '') return
  try {
    const key = `${prefix(network, me)}${targetId}`
    const prev = await idbGet<Participation>('inbox', key)
    if (prev !== undefined && prev.at <= at && (prev.reason === 'reviewed' || reason === 'mentioned')) return
    await idbPut<Participation>('inbox', key, {
      targetId,
      reason: prev?.reason === 'reviewed' ? 'reviewed' : reason,
      at: Math.min(at, prev?.at ?? at),
    })
    // Bounded: past the cap the oldest go (they are past the inbox's thread cap anyway).
    if (prev === undefined) {
      const rows = await idbEntries<Participation>('inbox', prefix(network, me))
      const old = rows.sort((a, b) => b[1].at - a[1].at).slice(MAX_PARTICIPATION)
      for (const [k] of old) await idbDelete('inbox', k)
    }
  } catch {
    // Storage unavailable: the thread is not followed.
  }
}

/** Every thread `me` took part in here, newest first, at most {@link MAX_PARTICIPATION}. */
export async function listParticipation(network: Network, me: string): Promise<Participation[]> {
  const rows = await idbEntries<Participation>('inbox', prefix(network, me))
  return rows
    .map(([, v]) => v)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PARTICIPATION)
}
