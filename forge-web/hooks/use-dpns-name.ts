'use client'

import { useEffect, useState } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { resolveDpnsName } from '@/lib/view'
import { cachedDpnsName, lookupDpnsName } from '@/lib/view/dpns'
import { isIdentityId } from '@/lib/utils'

/**
 * The DPNS name of identity `identityId`, once resolved (a cached lookup, shared by every
 * caller on the page); undefined until then, or when it has none or `identityId` is not an id.
 */
export function useDpnsName(identityId: string): string | undefined {
  const { sdk, ready, network } = useSdk()
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!ready || !sdk || !isIdentityId(identityId)) return
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

/**
 * The DPNS name of `identityId` as {@link useDpnsName} reads it, telling "still reading"
 * (undefined) from "none" (null: no name, a failed read, or `identityId` is not an id). A name this
 * tab has read already is there on the first render: what waits for the name, and should not
 * show the id meanwhile, needs that (the address bar's short URL).
 */
export function useSettledDpnsName(identityId: string): string | null | undefined {
  const { sdk, ready, network } = useSdk()
  const cached = isIdentityId(identityId) ? cachedDpnsName(network, identityId) : null
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (cached !== undefined || !ready || !sdk) return
    let live = true
    // Never throws: a failed read is cached as none.
    void resolveDpnsName(sdk, identityId, network).then((name) => live && setResolved({ id: identityId, name }))
    return () => {
      live = false
    }
  }, [sdk, ready, identityId, network, cached])
  if (cached !== undefined) return cached
  return resolved?.id === identityId ? resolved.name : undefined
}

/**
 * The DPNS name of `identityId`, telling "no name" (null) from "not known" (undefined: not read
 * yet, or the read failed): what a page needs before it offers a way to get one (QW3-035).
 */
export function useDpnsLookup(identityId: string): string | null | undefined {
  const { sdk, ready, network } = useSdk()
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!ready || !sdk || !isIdentityId(identityId)) return
    let live = true
    lookupDpnsName(sdk, identityId, network)
      .then((name) => live && setResolved({ id: identityId, name }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [sdk, ready, identityId, network])
  return resolved?.id === identityId ? resolved.name : undefined
}
