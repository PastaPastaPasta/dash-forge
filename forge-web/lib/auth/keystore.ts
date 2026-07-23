/**
 * Network-scoped in-browser key storage — the forge-web analogue of yappr's `secure-storage`.
 *
 * Private keys (WIF) are held in `localStorage` under a `forge_key_<network>_pk_<identityId>`
 * key so testnet and mainnet material never collide. Keys are **never** placed in React state
 * or logged; only this module and the signer read them, and only in the browser. All access is
 * SSR-guarded (`typeof window`) so the Next static-export prerender never touches storage.
 *
 * This is the M3 shape: WIF at rest in `localStorage`. Password-vault / passkey-PRF wrapping
 * (encrypting these at rest behind a user secret) is the documented follow-up — the storage
 * surface here is intentionally the same one those wrappers would slot in front of.
 */

import type { Network } from '../constants'

const PREFIX = 'forge_key_'

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function pkKey(network: Network, identityId: string): string {
  return `${PREFIX}${network}_pk_${identityId}`
}

/** Persist an identity's signing key (WIF) for a network. No-op outside the browser. */
export function storePrivateKey(network: Network, identityId: string, wif: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(pkKey(network, identityId), wif)
  } catch {
    // Storage full / disabled — treat as absent; the caller re-prompts on the next write.
  }
}

/** Read an identity's stored signing key (WIF), or null if none / not in a browser. */
export function getPrivateKey(network: Network, identityId: string): string | null {
  const s = storage()
  if (!s) return null
  try {
    return s.getItem(pkKey(network, identityId))
  } catch {
    return null
  }
}

/** Whether an identity has a stored signing key on this network. */
export function hasPrivateKey(network: Network, identityId: string): boolean {
  return getPrivateKey(network, identityId) !== null
}

/** Forget one identity's stored signing key on this network. */
export function clearPrivateKey(network: Network, identityId: string): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(pkKey(network, identityId))
  } catch {
    // Ignore.
  }
}

/** Forget every stored key on this network (full logout / device wipe). */
export function clearAllPrivateKeys(network: Network): void {
  const s = storage()
  if (!s) return
  try {
    const scope = `${PREFIX}${network}_pk_`
    const toRemove: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(scope)) toRemove.push(k)
    }
    for (const k of toRemove) s.removeItem(k)
  } catch {
    // Ignore.
  }
}

/** The identity ids that currently have a stored key on this network. */
export function storedIdentityIds(network: Network): string[] {
  const s = storage()
  if (!s) return []
  const scope = `${PREFIX}${network}_pk_`
  const ids: string[] = []
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(scope)) ids.push(k.slice(scope.length))
    }
  } catch {
    return []
  }
  return ids
}
