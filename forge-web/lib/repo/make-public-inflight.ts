/**
 * The runs of "Make this repo public" in flight in this tab, by network and repo. A run outlives the
 * dialog that started it: closing the dialog stops it only at the next step boundary, so the step
 * under way may still be signing. While one is in flight the Danger zone waits for it (Finish and
 * Make public are disabled), so two runs never sign side by side.
 */

import type { Network } from '../constants'

const running = new Set<string>()
const listeners = new Set<() => void>()

function keyOf(network: Network, repoId: string): string {
  return `${network}:${repoId}`
}

function notify(): void {
  for (const l of listeners) l()
}

/** Whether a run on `repoId` is in flight in this tab. */
export function makePublicInFlight(network: Network, repoId: string): boolean {
  return running.has(keyOf(network, repoId))
}

/**
 * Mark a run on `repoId` in flight. Returns the function to call once it settles (however it
 * ended), or null when one is in flight already: then the caller doesn't start.
 */
export function beginMakePublicRun(network: Network, repoId: string): (() => void) | null {
  const key = keyOf(network, repoId)
  if (running.has(key)) return null
  running.add(key)
  notify()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    running.delete(key)
    notify()
  }
}

/** Be told whenever a run starts or settles (for `useSyncExternalStore`). */
export function subscribeMakePublicRuns(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
