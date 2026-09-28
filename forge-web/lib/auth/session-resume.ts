/**
 * The kept session ("Stay signed in for public repos", Settings → Security; on by default).
 *
 * A resumed session holds only this browser's limited signing key: capped by its on-chain budget
 * and expiring on chain (90 days by default). Anyone with JavaScript running on this site, or a
 * copy of the browser profile taken within the window, could use that key. The identity's
 * encryption key, the storage credentials and wallet-granted keys are never kept: a resumed tab
 * asks for an interactive unlock the first time it needs one of them, and holds the result in
 * that tab's memory only.
 *
 * - What is kept: one IndexedDB record (`vault` store, `session:<network>`) with the limited
 *   key's WIF, AES-GCM-sealed under a random key made for it (a browser-held `CryptoKey`; it adds
 *   no protection against a script on this site or a copy of the profile, only against the
 *   record being read as plain bytes), and public session facts to show at once (no key
 *   material). The additional data binds the ciphertext to its network, identity, key id and
 *   absolute expiry.
 * - How long: at most 12 hours after the unlock, and not after 4 hours without use. Both are
 *   checked before anything is unwrapped.
 * - Every lock deletes it (Lock, sign-out, forget, revoke, expiry, a key found disabled on
 *   chain), and first stamps `forge:session-locked-at` in localStorage synchronously: a copy whose
 *   IndexedDB delete had not landed before a reload is refused, and the storage event locks every
 *   other tab. A keep or a resume that sees the marker move while it runs is refused too.
 * - Turning the setting off deletes it and makes every page load start locked.
 */

import type { Network } from '../constants'
import { idbBatch, idbGet, idbPut, idbUpdate } from '../idb'

const enc = new TextEncoder()

/** The absolute lifetime of a kept session, from the unlock. */
export const KEPT_TTL_MS = 12 * 60 * 60 * 1000
/** A kept session not used for this long is not resumed. */
export const KEPT_IDLE_MS = 4 * 60 * 60 * 1000

/** The one key a kept session holds: the limited signing key. */
export interface KeptKey {
  readonly identityId: string
  readonly keyId: number
  readonly wif: string
}

/** The stored record. */
export interface ResumeRecord {
  readonly version: 2
  readonly network: Network
  readonly identityId: string
  readonly keyId: number
  /** When the session locks for good (ms since epoch): the unlock time + {@link KEPT_TTL_MS}. */
  readonly expiresAt: number
  /** Last use (a page load, a signature, the user active in a tab): for {@link KEPT_IDLE_MS}. */
  readonly usedAt: number
  readonly savedAt: number
  readonly wrapKey: CryptoKey
  readonly iv: Uint8Array
  readonly wrapped: Uint8Array
  /** Public session facts (identity, balance, key scopes), no key material. */
  readonly hint: unknown
}

const NETWORKS: readonly Network[] = ['testnet', 'mainnet', 'devnet']
/** Set (ms) on every lock, synchronously: records kept before it are refused. */
export const LOCKED_AT_KEY = 'forge:session-locked-at'
/** Set (ms) when a tab keeps a session: other tabs on the sign-in prompt pick it up. */
export const SAVED_AT_KEY = 'forge:session-saved-at'
/** '1' = "Stay signed in for public repos" is off (every page load starts locked). */
const STRICT_KEY = 'forge:ask-unlock-every-visit'
const PROBE_KEY = 'forge:session-probe'

function recordKey(network: Network): string {
  return `session:${network}`
}

function resumeAad(network: Network, identityId: string, keyId: number, expiresAt: number): Uint8Array<ArrayBuffer> {
  return enc.encode(`dash-forge session v2|${network}|${identityId}|${keyId}|${expiresAt}`)
}

/** Whether a kept record is past its absolute or idle limit at `now`. */
export function keptExpired(r: Pick<ResumeRecord, 'expiresAt' | 'usedAt'>, now = Date.now()): boolean {
  return r.expiresAt <= now || now - r.usedAt >= KEPT_IDLE_MS
}

/**
 * Keep `key` for later page loads until `expiresAt`. Refused (and wiped) when a lock landed in
 * any tab since `lockMarkerAtUnlock` (read when the unlock began), while it is written, or when
 * the setting was turned off meanwhile.
 */
export async function saveResume(network: Network, key: KeptKey, expiresAt: number, hint: unknown, lockMarkerAtUnlock: number): Promise<boolean> {
  if (lockMarker() !== lockMarkerAtUnlock || !localStorageWorks()) return false
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = enc.encode(key.wif)
  let wrapped: Uint8Array
  try {
    wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: resumeAad(network, key.identityId, key.keyId, expiresAt) }, wrapKey, plain))
  } finally {
    plain.fill(0)
  }
  const now = Date.now()
  // After the last lock even within the same millisecond (loadResume refuses savedAt <= it).
  const record: ResumeRecord = { version: 2, network, identityId: key.identityId, keyId: key.keyId, expiresAt, usedAt: now, savedAt: Math.max(now, lockMarkerAtUnlock + 1), wrapKey, iv, wrapped, hint }
  await idbPut('vault', recordKey(network), record)
  if (lockMarker() !== lockMarkerAtUnlock || askToUnlockEveryVisit()) {
    await wipeResume()
    return false
  }
  writeMarker(SAVED_AT_KEY)
  return true
}

/**
 * The kept record for `network`, or null when there is none, it is malformed, expired (absolute
 * or idle), or a lock happened after it was kept. Anything refused is wiped.
 */
export async function loadResume(network: Network): Promise<ResumeRecord | null> {
  const v = await idbGet<unknown>('vault', recordKey(network))
  if (v === undefined) return null
  if (!isRecord(v, network) || v.savedAt <= lockMarker() || keptExpired(v)) {
    await wipeResume()
    return null
  }
  return v
}

/** The key a kept record holds, or null when it does not open (tampered, not a real key). */
export async function openResume(r: ResumeRecord): Promise<KeptKey | null> {
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(r.iv), additionalData: resumeAad(r.network, r.identityId, r.keyId, r.expiresAt) },
        r.wrapKey,
        new Uint8Array(r.wrapped),
      ),
    )
    const wif = new TextDecoder().decode(plain)
    plain.fill(0)
    return { identityId: r.identityId, keyId: r.keyId, wif }
  } catch {
    return null
  }
}

/**
 * Mark the kept record used now (the idle limit counts from here). Best effort, and in one
 * transaction: a lock's wipe, or another tab's newer record, is never overwritten with this one.
 */
export async function touchResume(network: Network): Promise<void> {
  const marker = lockMarker()
  await idbUpdate<unknown>('vault', recordKey(network), (v) =>
    isRecord(v, network) && !keptExpired(v) && v.savedAt > marker ? [[recordKey(network), { ...v, usedAt: Date.now() }]] : [],
  )
  // A lock landed meanwhile: whatever the update wrote goes.
  if (lockMarker() !== marker) await wipeResume()
}

/** Whether a value read back from IndexedDB is a usable record (else it is dropped). */
function isRecord(v: unknown, network: Network): v is ResumeRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<ResumeRecord>
  return (
    r.version === 2 &&
    r.network === network &&
    typeof r.identityId === 'string' &&
    typeof r.keyId === 'number' &&
    typeof r.expiresAt === 'number' &&
    typeof r.usedAt === 'number' &&
    typeof r.savedAt === 'number' &&
    r.iv instanceof Uint8Array &&
    r.wrapped instanceof Uint8Array &&
    // A key that did not survive a copy (a test harness's saved state) comes back as a plain
    // object: nothing to open.
    typeof CryptoKey !== 'undefined' &&
    r.wrapKey instanceof CryptoKey
  )
}

/** Delete every kept session (all networks, one transaction). */
export async function wipeResume(): Promise<void> {
  await idbBatch('vault', NETWORKS.map((n) => [recordKey(n), undefined] as const))
}

/** Record a lock before anything async runs (a reload right after still sees it). */
export function markLocked(): void {
  writeMarker(LOCKED_AT_KEY)
}

/** The last lock's marker (0 when none, or when storage is disabled). */
export function lockMarker(): number {
  return readMarker(LOCKED_AT_KEY)
}

/** Whether "Stay signed in for public repos" is off (every page load starts locked). */
export function askToUnlockEveryVisit(): boolean {
  return readLocal(STRICT_KEY) === '1'
}

/** Turn "Stay signed in for public repos" off (the kept session is wiped) or on. */
export async function setAskToUnlockEveryVisit(on: boolean): Promise<void> {
  try {
    if (on) window.localStorage.setItem(STRICT_KEY, '1')
    else window.localStorage.removeItem(STRICT_KEY)
  } catch {
    /* storage disabled: nothing is kept then anyway (see localStorageWorks) */
  }
  if (on) await wipeResume()
}

/** Whether this page is framed by another page: a kept session is never restored there. */
export function framed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.top !== window.self
  } catch {
    return true
  }
}

/**
 * Whether localStorage round-trips. Without it a lock cannot reach the other tabs nor be
 * checked on the next load, so nothing is kept.
 */
function localStorageWorks(): boolean {
  try {
    const v = String(Math.random())
    window.localStorage.setItem(PROBE_KEY, v)
    const ok = window.localStorage.getItem(PROBE_KEY) === v
    window.localStorage.removeItem(PROBE_KEY)
    return ok
  } catch {
    return false
  }
}

/** A numeric localStorage marker (0 when absent or unreadable). */
function readMarker(key: string): number {
  return Number(readLocal(key) ?? 0) || 0
}

/** A localStorage value, or null (no window, or storage disabled). */
function readLocal(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeMarker(key: string): void {
  try {
    if (typeof window === 'undefined') return
    // Strictly increasing, so two events in the same millisecond still fire a storage event.
    const now = Math.max(Date.now(), readMarker(key) + 1)
    window.localStorage.setItem(key, String(now))
  } catch {
    /* storage disabled: the IndexedDB wipe still runs */
  }
}
