'use client'

/**
 * usePrefs — the display preferences in `lib/view/prefs`, persisted in localStorage and shared
 * by every component that reads them (a change in one diff re-renders the others, and other
 * tabs pick it up through the `storage` event).
 */

import { useCallback, useSyncExternalStore } from 'react'

import { DEFAULT_PREFS, PREFS_KEY, parsePrefs, type Prefs } from '@/lib/view/prefs'

const listeners = new Set<() => void>()
let cachedRaw: string | null | undefined
let cached: Prefs = DEFAULT_PREFS
/** Set when storage refused a write (private mode): the page keeps these for its lifetime. */
let memoryOnly: Prefs | null = null

function read(): Prefs {
  if (memoryOnly !== null) return memoryOnly
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(PREFS_KEY)
  } catch {
    raw = null
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cached = parsePrefs(raw)
  }
  return cached
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent): void => {
    if (e.key === PREFS_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePrefs(): readonly [Prefs, (patch: Partial<Prefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, read, () => DEFAULT_PREFS)
  const update = useCallback((patch: Partial<Prefs>) => {
    const next = { ...read(), ...patch }
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      // Private mode: the change lasts for this page only.
      memoryOnly = next
    }
    for (const l of listeners) l()
  }, [])
  return [prefs, update] as const
}

/** Whether the viewport is at least `px` wide (false during static render). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}
