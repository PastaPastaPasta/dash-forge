'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

import { useSdk } from '@/hooks/use-sdk'
import { cachedDpnsName, DPNS_FAILURE_TTL_MS, dpnsCacheVersion, dpnsReadFailed, lookupDpnsName, resolveDpnsName, subscribeDpnsCache } from '@/lib/view/dpns'
import { isIdentityId } from '@/lib/utils'
import { resolveOwner } from '@/lib/repo'

/** How many times a failed read is tried again while the component stays mounted. */
const MAX_RETRIES = 5

/**
 * The DPNS name of identity `identityId`, once resolved (a cached lookup, shared by every
 * caller on the page); undefined until then, or when it has none or `identityId` is not an id.
 * A name read already is there on the first render, and a failed read is tried again later
 * ({@link useSettledDpnsName}).
 */
export function useDpnsName(identityId: string): string | undefined {
  return useSettledDpnsName(identityId) ?? undefined
}

/**
 * The DPNS name of `identityId` as {@link useDpnsName} reads it, telling "still reading"
 * (undefined) from "none" (null: no name, a failed read, or `identityId` is not an id). A name this
 * tab has read already is there on the first render: what waits for the name, and should not
 * show the id meanwhile, needs that (the address bar's short URL).
 *
 * A failed read answers none for now, not for the life of the tab: it is not cached, and this
 * reads again after {@link DPNS_FAILURE_TTL_MS} (a few times), so a name that only a flaky node
 * hid shows up in the end.
 */
export function useSettledDpnsName(identityId: string): string | null | undefined {
  const { sdk, ready, network } = useSdk()
  // A name this tab registers is written into the cache, not read: render again when it is (#452).
  useDpnsCacheVersion()
  const cached = isIdentityId(identityId) ? cachedDpnsName(network, identityId) : null
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  // Tries so far for this id on this network: a mounted hook that is handed another owner starts over.
  const readKey = `${network}:${identityId}`
  const [tries, setTries] = useState<{ key: string; n: number }>({ key: readKey, n: 0 })
  const attempt = tries.key === readKey ? tries.n : 0
  useEffect(() => {
    if (cached !== undefined || !ready || !sdk) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Never throws: a failed read is none, remembered as failed (not as a name that does not exist).
    void resolveDpnsName(sdk, identityId, network).then((name) => {
      if (!live) return
      setResolved({ id: identityId, name })
      if (name === null && dpnsReadFailed(network, identityId) && attempt < MAX_RETRIES) {
        timer = setTimeout(() => live && setTries({ key: readKey, n: attempt + 1 }), DPNS_FAILURE_TTL_MS + 50)
      }
    })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [sdk, ready, identityId, network, cached, attempt, readKey])
  if (cached !== undefined) return cached
  return resolved?.id === identityId ? resolved.name : undefined
}

/**
 * The DPNS name of the owner a route writes as `owner`: an identity id, or the name or label it was
 * typed as (`alice`, `Alice.dash`). The name is read for the identity either one names, so every
 * way of writing the owner finds the same name (Copy link then writes the owner as the address
 * bar does). Undefined until read, or when the owner has none or does not resolve.
 */
export function useOwnerDpnsName(owner: string): string | undefined {
  const { sdk, ready } = useSdk()
  const [resolved, setResolved] = useState<{ owner: string; id: string | null } | null>(null)
  const direct = isIdentityId(owner)
  useEffect(() => {
    if (direct || !ready || !sdk || owner === '') return
    let live = true
    // The repo page has resolved this owner already: a cached answer, no request.
    resolveOwner(sdk, owner)
      .then((id) => live && setResolved({ owner, id }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [sdk, ready, owner, direct])
  const id = direct ? owner : resolved?.owner === owner ? resolved.id : null
  // Settled, not one-shot: the header's retry after a failed read (cached by then) reaches this too.
  return useSettledDpnsName(id ?? '') ?? undefined
}

/**
 * The DPNS name of `identityId`, telling "no name" (null) from "not known" (undefined: not read
 * yet, or the read failed): what a page needs before it offers a way to get one (QW3-035).
 */
export function useDpnsLookup(identityId: string): string | null | undefined {
  const { sdk, ready, network } = useSdk()
  useDpnsCacheVersion()
  const [resolved, setResolved] = useState<{ id: string; name: string | null } | null>(null)
  // A name registered in this tab since the read (#452): the page stops offering one at once.
  const known = isIdentityId(identityId) ? cachedDpnsName(network, identityId) : undefined
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
  if (typeof known === 'string') return known
  return resolved?.id === identityId ? resolved.name : undefined
}

/** Render again whenever the DPNS name cache changes ({@link subscribeDpnsCache}). */
function useDpnsCacheVersion(): number {
  return useSyncExternalStore(subscribeDpnsCache, dpnsCacheVersion, dpnsCacheVersion)
}
