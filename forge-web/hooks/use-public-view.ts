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
/** Where focus goes once the page remounted after a switch: the way back, or "View as public". */
let focusNext: { readonly repoId: string; readonly to: 'exit' | 'enter'; readonly at: number } | null = null
/** A hint older than this is stale (the page it was for never showed the control). */
const FOCUS_HINT_MS = 3000

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
  focusNext = { repoId, to: value ? 'exit' : 'enter', at: Date.now() }
  version += 1
  for (const l of listeners) l()
}

/**
 * Whether the control `to` of `repoId` should take focus now: once, right after the switch that
 * remounted the page (the button pressed is gone, so focus would fall to the page's start).
 */
export function takePublicViewFocus(repoId: string, to: 'exit' | 'enter'): boolean {
  if (focusNext !== null && Date.now() - focusNext.at > FOCUS_HINT_MS) focusNext = null
  if (focusNext === null || focusNext.repoId !== repoId || focusNext.to !== to) return false
  focusNext = null
  // Unless the reader already moved on (focus is somewhere on the page).
  return typeof document === 'undefined' || document.activeElement === null || document.activeElement === document.body

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
