/**
 * Which public repos are known to have a members key (members-only content), by repo id: a key,
 * once there, never goes; "none" is trusted only for {@link NO_KEY_TTL_MS}. Fed by the members-key
 * reads, by any read that meets a sealed document of a public repo, and by this client turning
 * members-only content on, so a write's parent check is skipped only where nothing can be
 * members-only. Kept apart so the content gate and the write path can both reach it.
 */

const known = new Map<string, { readonly has: boolean; readonly at: number }>()

/** How long a "no members key" answer is trusted. */
export const NO_KEY_TTL_MS = 15_000

/** What is known about `repoId`'s members key: true, false (fresh), or undefined (read it). */
export function knownMembersKey(repoId: string, now = Date.now()): boolean | undefined {
  const hit = known.get(repoId)
  if (hit === undefined) return undefined
  return hit.has || now - hit.at < NO_KEY_TTL_MS ? hit.has : undefined
}

/** Record a read of `repoId`'s members key. */
export function recordMembersKey(repoId: string, has: boolean): void {
  if (!has && known.get(repoId)?.has === true) return
  known.set(repoId, { has, at: Date.now() })
}

/** `repoId` has a members key (a sealed document or anchor was seen, or this client turned it on). */
export function noteMembersKey(repoId: string): void {
  recordMembersKey(repoId, true)
}
