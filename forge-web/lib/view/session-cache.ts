/**
 * A tiny per-session read cache for small repo-chrome reads (tab counts, latest release,
 * viewer role): one in-flight or settled promise per key for `ttlMs`, dropped on rejection so
 * a retry reads again. Navigating between a repo's pages then costs no repeat queries.
 *
 * A private repo's keys carry its session (`repoKey`: `repoId#sessionId`), and what they hold may
 * be decrypted (a sealed release list, `private-repos.md` §16.3): when that session ends, its
 * entries go with it, as every other cache keyed by a session does.
 */

import { onPrivateSessionEnded } from '../repo/private-session'

const entries = new Map<string, { at: number; promise: Promise<unknown> }>()

export function sessionCached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key)
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>
  const promise = load()
  const entry = { at: Date.now(), promise }
  entries.set(key, entry)
  promise.catch(() => {
    if (entries.get(key) === entry) entries.delete(key)
  })
  return promise
}

/** Drop every entry whose key starts with `prefix` (e.g. after a write). */
export function invalidateSessionCache(prefix: string): void {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
}

onPrivateSessionEnded((id) => {
  for (const key of [...entries.keys()]) if (key.includes(`#${id}`)) entries.delete(key)
})
