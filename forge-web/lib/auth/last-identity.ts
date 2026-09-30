/**
 * Which stored identity this browser signed in with last, per network (QW2-025): the Unlock
 * sheet preselects it when several keys are stored, as an account switcher preselects the
 * current account, and a locked page names it ("Unlock to merge"). Only the public identity
 * id is kept (localStorage), never a key; forgetting that identity's key removes it.
 */

import type { Network } from '../constants'

const KEY = 'forge:last-identity:'

export function readLastIdentity(network: Network): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(KEY + network)
  } catch {
    return null
  }
}

export function rememberLastIdentity(network: Network, identityId: string): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem(KEY + network) !== identityId) window.localStorage.setItem(KEY + network, identityId)
  } catch {
    /* storage disabled: Unlock preselects the first key */
  }
}

/** Drop the marker if it names `identityId` (its key was forgotten here). */
export function forgetLastIdentity(network: Network, identityId: string): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem(KEY + network) === identityId) window.localStorage.removeItem(KEY + network)
  } catch {
    /* storage disabled */
  }
}

/**
 * The stored identity a locked session belongs to: the last one used here when it is still
 * stored, else the first finished one (a staged, unfinished record only when nothing else is).
 * The Unlock sheet preselects the same, so a page's "Unlock to merge" opens that identity.
 */
export function lockedIdentityOf(
  vaults: readonly { readonly identityId: string; readonly staged?: true }[],
  last: string | null,
): string | null {
  const usable = vaults.filter((v) => v.staged !== true)
  return (usable.find((v) => v.identityId === last) ?? usable[0] ?? vaults[0])?.identityId ?? null
}
