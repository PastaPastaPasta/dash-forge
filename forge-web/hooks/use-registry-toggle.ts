'use client'

/**
 * useRegistryToggle — the viewer's own on/off registry relation (a star on a listing, a follow
 * of an identity) with an honest initial state and honest failures.
 *
 * The initial state is READ, not assumed: until the viewer's own documents have been checked
 * the toggle reports `on: null` and callers must not offer an action. A read failure or a write
 * failure surfaces as `error`, and a write that broadcast but was not seen on Platform before
 * the confirm timeout is reported as such rather than flipping the button as if it landed.
 */

import { useCallback, useState } from 'react'

import { useAsync } from '@/hooks/use-async'
import { errorMessage } from '@/lib/utils'

export interface RegistryToggle {
  /** Current relation; `null` while unknown (logged out, loading, or the read failed). */
  readonly on: boolean | null
  readonly busy: boolean
  /** A read or write failure, or an unconfirmed write, to show next to the control. */
  readonly error: string | null
  /** Net change in the relation's public count caused by this session's writes. */
  readonly delta: number
  readonly toggle: () => Promise<void>
}

/**
 * Last known relation per key, for the session. The repo header remounts on every repo page,
 * so without this each navigation would show a spinner until the viewer's own documents were
 * re-read. The read still runs (and refreshes this); it just no longer blocks the first paint.
 */
const known = new Map<string, boolean>()

export function useRegistryToggle(params: {
  /** False until the SDK is connected and the viewer + target are known. */
  readonly enabled: boolean
  /** Changes whenever the viewer or target changes (reset + re-read). */
  readonly key: string
  readonly read: () => Promise<boolean>
  /** Create the relation; resolve `false` if it broadcast but was not confirmed in time. */
  readonly add: () => Promise<boolean>
  /** Remove the relation; resolve `false` if it broadcast but was not confirmed in time. */
  readonly remove: () => Promise<boolean>
}): RegistryToggle {
  const { enabled, key, read, add, remove } = params
  const initial = useAsync<boolean>(
    async () => {
      const value = await read()
      known.set(key, value)
      return value
    },
    [key],
    { enabled, initial: () => known.get(key) },
  )

  // What this session's confirmed writes changed, keyed so a different viewer/target never
  // inherits it — not even for the one render before an effect could reset it.
  const [writes, setWrites] = useState<{ key: string; on: boolean | null; delta: number; error: string | null }>(
    { key, on: null, delta: 0, error: null },
  )
  const [busy, setBusy] = useState(false)
  const mine = writes.key === key ? writes : { key, on: null, delta: 0, error: null }

  const on = !enabled ? null : mine.on ?? (initial.settled && initial.error === null ? initial.data : null)

  const toggle = useCallback(async (): Promise<void> => {
    if (on === null) return
    const at = key
    const record = (patch: { on?: boolean; delta?: number; error: string | null }): void =>
      setWrites((w) => {
        const base = w.key === at ? w : { key: at, on: null, delta: 0, error: null }
        return { ...base, on: patch.on ?? base.on, delta: base.delta + (patch.delta ?? 0), error: patch.error }
      })
    setBusy(true)
    record({ error: null })
    try {
      const confirmed = on ? await remove() : await add()
      if (!confirmed) {
        record({ error: 'Sent, but not yet visible on Platform. Reload in a moment to check.' })
        return
      }
      known.set(at, !on)
      record({ on: !on, delta: on ? -1 : 1, error: null })
    } catch (e) {
      record({ error: errorMessage(e, 'the write failed') })
    } finally {
      setBusy(false)
    }
  }, [on, key, add, remove])

  const readError = enabled && initial.error !== null ? `Couldn't read your current state: ${initial.error}` : null
  return { on, busy, error: mine.error ?? readError, delta: mine.delta, toggle }
}
