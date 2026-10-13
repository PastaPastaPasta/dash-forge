'use client'

import { useEffect, useMemo, useState } from 'react'

import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { NAME_LOOKUP_FAILED, lookUpName, parsePersonInput, unknownName } from '@/lib/repo/person-input'

/** How long typing pauses before a name is looked up, so each keystroke does not cost a read. */
const LOOKUP_DELAY_MS = 400

export interface PersonInputState {
  /** The identity id the text names (typed, or the one its name belongs to); null until there is one. */
  readonly id: string | null
  /** The name the text was, when it resolved from one. */
  readonly name: string | null
  /** Why the text is not a person (shown under the field); null while typing, resolving or fine. */
  readonly error: string | null
  /** A name is being looked up. */
  readonly resolving: boolean
  /** Looks the name up again; set only when the last lookup failed (as opposed to finding no such name). */
  readonly retry: (() => void) | null
}

const NOTHING: PersonInputState = { id: null, name: null, error: null, resolving: false, retry: null }

/** The text of a member field as a person: an identity id, or a DPNS name looked up once typing pauses. */
export function usePersonInput(text: string): PersonInputState {
  const { sdk, ready, network } = useSdk()
  const input = useMemo(() => parsePersonInput(text), [text])
  const name = input.kind === 'name' ? input.name : null
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (name === null) return
    const t = setTimeout(() => setSettled(name), LOOKUP_DELAY_MS)
    return () => clearTimeout(t)
  }, [name])
  const looked = name !== null && settled === name
  const found = useAsync(() => lookUpName(sdk!, name!, network), [network, name], { enabled: looked && ready && sdk !== null })
  if (input.kind === 'id') return { ...NOTHING, id: input.id }
  if (input.kind === 'invalid') return { ...NOTHING, error: input.error }
  if (input.kind === 'empty') return NOTHING
  if (!looked || !found.settled) return { ...NOTHING, resolving: true }
  if (found.error !== null) return { ...NOTHING, error: NAME_LOOKUP_FAILED, retry: found.reload }
  if (found.data === null) return { ...NOTHING, error: unknownName(input.name) }
  return { ...NOTHING, id: found.data, name: input.name }
}
