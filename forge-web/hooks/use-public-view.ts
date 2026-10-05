'use client'

/**
 * "View as public" (DESIGN §10): a member reads a repo as the public does. On per repo, for this
 * tab only (memory, never stored): every page of the repo then renders signed out
 * (`SignedOutView`) until it is turned off.
 */

import { useCallback, useSyncExternalStore } from 'react'

const on = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Turn "View as public" on or off for `repoId` in this tab. */
export function setPublicView(repoId: string, value: boolean): void {
  if (value === on.has(repoId)) return
  if (value) on.add(repoId)
  else on.delete(repoId)
  version += 1
  for (const l of listeners) l()
}

/** Whether `repoId` is shown as the public sees it, and the switch. */
export function usePublicView(repoId: string): readonly [boolean, (value: boolean) => void] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  )
  const set = useCallback((value: boolean) => setPublicView(repoId, value), [repoId])
  return [repoId !== '' && on.has(repoId), set] as const
}
