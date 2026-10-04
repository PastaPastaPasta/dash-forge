/**
 * The new-key alert (trust and safety TS-07): each device remembers which keys the identity had
 * when it last looked, and says so when a key appears that it did not add itself. A leaked
 * master key or recovery phrase shows up here first: whoever holds it adds a key of their own.
 *
 * Costs no read of its own: the session's identity fetch (every sign-in, unlock and resumed
 * session) is compared against the snapshot. The snapshot holds key ids only (no secrets), in
 * localStorage per network and identity, and moves on only when the user has seen the change.
 */

import type { Network } from '../constants'

/** What the alert says about a key (from the identity on chain). */
export interface WatchedKey {
  readonly keyId: number
  readonly purpose: number
  readonly level: number
  readonly disabled: boolean
}

/** The ids the device knew when it last looked. */
interface Snapshot {
  readonly v: 1
  readonly ids: readonly number[]
  readonly at: number
}

const key = (network: Network, identityId: string): string => `forge:seen-keys:${network}:${identityId}`

function read(network: Network, identityId: string): Snapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(network, identityId))
    if (!raw) return null
    const s = JSON.parse(raw) as Snapshot
    return s.v === 1 && Array.isArray(s.ids) && s.ids.every((n) => Number.isInteger(n)) ? s : null
  } catch {
    return null
  }
}

function write(network: Network, identityId: string, ids: readonly number[], now: number): void {
  try {
    globalThis.localStorage?.setItem(key(network, identityId), JSON.stringify({ v: 1, ids: [...ids].sort((a, b) => a - b), at: now } satisfies Snapshot))
  } catch {
    /* storage blocked: the alert cannot remember, and says nothing rather than repeat */
  }
}

/**
 * The live keys added since this device last looked, other than `own` (the keys this device
 * holds, which it added itself). The first look records the keys silently: there is nothing
 * to compare with, and a fresh sign-in is the user adding a key.
 */
export function newKeysSince(prev: readonly number[] | null, keys: readonly WatchedKey[], own: readonly number[]): WatchedKey[] {
  if (prev === null) return []
  const known = new Set([...prev, ...own])
  return keys.filter((k) => !k.disabled && !known.has(k.keyId))
}

/**
 * Compare the identity's keys with this device's snapshot. Returns the new keys to tell the user
 * about (the snapshot stays until {@link acknowledgeKeys}); with none, the snapshot moves on.
 */
export function checkKeys(network: Network, identityId: string, keys: readonly WatchedKey[], own: readonly number[], now = Date.now()): WatchedKey[] {
  const prev = read(network, identityId)
  const added = newKeysSince(prev?.ids ?? null, keys, own)
  if (added.length === 0) write(network, identityId, keys.map((k) => k.keyId), now)
  return added
}

/** The user has seen these keys (or disabled them): stop telling. */
export function acknowledgeKeys(network: Network, identityId: string, keys: readonly WatchedKey[], now = Date.now()): void {
  const prev = read(network, identityId)
  write(network, identityId, [...new Set([...(prev?.ids ?? []), ...keys.map((k) => k.keyId)])], now)
}

/** Forget the snapshot (sign out and forget). */
export function forgetKeySnapshot(network: Network, identityId: string): void {
  try {
    globalThis.localStorage?.removeItem(key(network, identityId))
  } catch {
    /* nothing to forget */
  }
}

const PURPOSES: Readonly<Record<number, string>> = { 0: 'signing', 1: 'encryption', 2: 'decryption', 3: 'transfer', 4: 'system', 5: 'voting', 6: 'owner' }
const LEVELS: Readonly<Record<number, string>> = { 0: 'master', 1: 'critical', 2: 'high', 3: 'medium' }

/** "a high-level signing key" — how a key reads in the alert and on Devices & keys. */
export function keyKind(k: Pick<WatchedKey, 'purpose' | 'level'>): string {
  const level = LEVELS[k.level] ?? 'unknown-level'
  const purpose = PURPOSES[k.purpose] ?? 'other'
  return k.level === 0 ? 'master key' : `${level} ${purpose} key`
}
