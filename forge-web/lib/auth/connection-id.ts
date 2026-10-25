/**
 * The App Connect v2 state this browser keeps in localStorage (`APP_CONNECT_PROFILE.md`). None of
 * it is secret.
 *
 * - The **connection id** (`CONNECTION_ID`): 16 random bytes per network, carried by every v2
 *   request. A wallet that approves disables the keys of its previous grant for the same
 *   (identity, app, connection id) in the same identity update, so signing in again or renewing
 *   from this browser never leaves this browser's old key live. It survives logout and forget, as
 *   the profile requires: a fresh id would leave the old grant's key live in the wallet.
 * - The **renewal marker**: set while a wallet renewal of this browser's key is shown and being
 *   answered. The wallet disables the old key in the update that adds the new one, a moment
 *   before this tab stores the new one; meanwhile other tabs see their key disabled. The marker
 *   tells them it was replaced, not revoked, so they drop it quietly instead of locking every tab
 *   (`AuthController.superseded`). It names the key being replaced and lapses with the request.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const CONNECTION_KEY = 'forge:app-connect:connection-id:'
const RENEWAL_KEY = 'forge:app-connect:renewing:'
/**
 * The furthest ahead a renewal mark may end: a request lives 10 minutes, and storing its answer a
 * little longer. A mark that ends later (a clock set back since) is not honoured, so it can never
 * keep a revoked key's tabs from locking for long.
 */
export const MAX_RENEWAL_MARK_MS = 20 * 60 * 1000

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * This browser's connection id for `networkKey` (`NETWORKS[n].key`: `testnet`, `devnet-sakura`),
 * made on first use. With storage disabled every request gets a fresh one (a renewal then leaves
 * the old key live until it expires; the master-key revoke still disables it).
 */
export function connectionId(networkKey: string): Uint8Array {
  const s = storage()
  try {
    const kept = s?.getItem(CONNECTION_KEY + networkKey)
    if (kept && /^[0-9a-f]{32}$/.test(kept)) return hexToBytes(kept)
  } catch {
    /* unreadable: make a new one */
  }
  const fresh = crypto.getRandomValues(new Uint8Array(16))
  try {
    s?.setItem(CONNECTION_KEY + networkKey, bytesToHex(fresh))
  } catch {
    /* storage full or disabled: this request only */
  }
  return fresh
}

interface RenewalMarker {
  readonly keyId: number
  readonly until: number
}

function renewalKey(networkKey: string, identityId: string): string {
  return `${RENEWAL_KEY}${networkKey}:${identityId}`
}

/** Mark a wallet renewal of `keyId` on `identityId` as in flight until `until` (ms). */
export function markWalletRenewal(networkKey: string, identityId: string, keyId: number, until: number): void {
  try {
    storage()?.setItem(renewalKey(networkKey, identityId), JSON.stringify({ keyId, until } satisfies RenewalMarker))
  } catch {
    /* storage disabled: another tab may lock while the renewal finishes, as before */
  }
}

/**
 * The renewal of `identityId`'s key ended (stored, cancelled or expired). With `keyId`, only a
 * mark for that key goes: another tab's renewal of another key keeps its own.
 */
export function clearWalletRenewal(networkKey: string, identityId: string, keyId?: number | null): void {
  try {
    if (keyId != null && readMarker(networkKey, identityId)?.keyId !== keyId) return
    storage()?.removeItem(renewalKey(networkKey, identityId))
  } catch {
    /* storage disabled */
  }
}

function readMarker(networkKey: string, identityId: string): Partial<RenewalMarker> | null {
  try {
    const raw = storage()?.getItem(renewalKey(networkKey, identityId))
    return raw ? (JSON.parse(raw) as Partial<RenewalMarker>) : null
  } catch {
    return null
  }
}

/** Whether a wallet renewal of exactly `keyId` on `identityId` is in flight at `now`. */
export function walletRenewalInFlight(networkKey: string, identityId: string, keyId: number, now = Date.now()): boolean {
  const marker = readMarker(networkKey, identityId)
  return marker?.keyId === keyId && typeof marker.until === 'number' && marker.until > now && marker.until <= now + MAX_RENEWAL_MARK_MS
}
