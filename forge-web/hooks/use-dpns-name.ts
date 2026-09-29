'use client'

import { useEffect, useState } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { resolveDpnsName } from '@/lib/view'

const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/

/**
 * The DPNS name of identity `identityId`, once resolved (a cached lookup, shared by every
 * caller on the page); undefined until then, or when it has none or `identityId` is not an id.
 */
export function useDpnsName(identityId: string): string | undefined {
  const { sdk, ready, network } = useSdk()
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!ready || !sdk || !IDENTITY_ID.test(identityId)) return
    let live = true
    resolveDpnsName(sdk, identityId, network)
      .then((name) => live && setResolved({ id: identityId, name }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [sdk, ready, identityId, network])
  return resolved?.id === identityId ? resolved.name ?? undefined : undefined
}
