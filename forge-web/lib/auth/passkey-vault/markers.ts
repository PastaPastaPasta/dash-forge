/**
 * What this device records about its own vault passkeys, in IndexedDB beside the browser vault
 * (public facts only, no key material):
 *
 * - `pv-own:<network>:<identity>`: a trust marker per passkey this device made or signed in with,
 *   `{credentialId, recipientKey, keyIds, encryptionKeyId?, addedAt}`. Its recipient key came from
 *   the passkey's own PRF output in this browser, never from a read of Platform, so it is the one
 *   thing a re-seal without a prompt may trust (`PasskeyVault.trustMarker`): an entry anyone with a
 *   live key could plant carries the attacker's recipient key, which no marker here names.
 * - `pv-pending:<network>:<identity>`: an enrolment made but not yet stored and seen on Platform,
 *   as `{ownerId, credentialId}` only, so "Check again" works after a reload.
 *
 * Forgetting the identity on this device deletes both ({@link forgetPasskeyRecords}).
 */

import type { Network } from '../../constants'
import { idbDelete, idbGet, idbUpdate } from '../../idb'
import { bytesEqual } from '../../vendor/platform-auth/passkey-vault'

/** This device's record of one of its passkeys. */
export interface PasskeyMarker {
  readonly credentialId: Uint8Array
  /** The HPKE recipient key the passkey's PRF output derived here. */
  readonly recipientKey: Uint8Array
  /** The key ids last sealed to it, in slot order (slot 0 first). */
  readonly keyIds: readonly number[]
  /** The encryption key sealed with them, when the user chose to include it. */
  readonly encryptionKeyId?: number
  /** When this device made it or first signed in with it (ms). */
  readonly addedAt: number
}

/** A passkey made by an enrolment that has not finished (public ids only). */
export interface PendingPasskey {
  readonly ownerId: Uint8Array
  readonly credentialId: Uint8Array
}

const markersKey = (network: Network, identityId: string): string => `pv-own:${network}:${identityId}`
const pendingKey = (network: Network, identityId: string): string => `pv-pending:${network}:${identityId}`

/** A Uint8Array from any realm (a structured clone may come back from another one). */
const isBytes = (v: unknown, length?: number): v is Uint8Array =>
  Object.prototype.toString.call(v) === '[object Uint8Array]' && (length === undefined || (v as Uint8Array).length === length)
const isKeyId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function isMarker(v: unknown): v is PasskeyMarker {
  const m = v as Partial<PasskeyMarker> | null
  return (
    typeof m === 'object' &&
    m !== null &&
    isBytes(m.credentialId) &&
    isBytes(m.recipientKey, 32) &&
    Array.isArray(m.keyIds) &&
    m.keyIds.every(isKeyId) &&
    (m.encryptionKeyId === undefined || isKeyId(m.encryptionKeyId)) &&
    typeof m.addedAt === 'number'
  )
}

/** The well-formed markers of a stored value (a malformed one is ignored: it trusts nothing). */
const validMarkers = (v: unknown): PasskeyMarker[] => (Array.isArray(v) ? v.filter(isMarker) : [])

/** The markers of a stored value but the one of `credentialId`. */
const withoutCredential = (v: unknown, credentialId: Uint8Array): PasskeyMarker[] => validMarkers(v).filter((m) => !bytesEqual(m.credentialId, credentialId))

/** This device's markers for `identityId`. */
export async function readMarkers(network: Network, identityId: string): Promise<PasskeyMarker[]> {
  const v = await idbGet<unknown>('vault', markersKey(network, identityId))
  return validMarkers(v).map((m) => ({ ...m, credentialId: new Uint8Array(m.credentialId), recipientKey: new Uint8Array(m.recipientKey) }))
}

/** The marker of `credentialId`, or null. */
export function markerFor(markers: readonly PasskeyMarker[], credentialId: Uint8Array): PasskeyMarker | null {
  return markers.find((m) => bytesEqual(m.credentialId, credentialId)) ?? null
}

/**
 * The marker that makes `entry` this device's: the one of its credential, recording its recipient
 * key. An entry replaced since (sealed to another key under the same credential id) has none.
 */
export function ownMarkerFor(markers: readonly PasskeyMarker[], entry: { readonly credentialId: Uint8Array; readonly recipientKey: Uint8Array }): PasskeyMarker | null {
  const m = markerFor(markers, entry.credentialId)
  return m !== null && bytesEqual(m.recipientKey, entry.recipientKey) ? m : null
}

/** Record (or replace) the marker of `marker.credentialId`, in one transaction with the others. */
export async function putMarker(network: Network, identityId: string, marker: PasskeyMarker): Promise<void> {
  const at = markersKey(network, identityId)
  await idbUpdate<unknown>('vault', at, (current) => [[at, [...withoutCredential(current, marker.credentialId), marker]]])
}

/** Forget the marker of `credentialId` (its entry was removed). */
export async function dropMarker(network: Network, identityId: string, credentialId: Uint8Array): Promise<void> {
  const at = markersKey(network, identityId)
  await idbUpdate<unknown>('vault', at, (current) => {
    const kept = withoutCredential(current, credentialId)
    return [[at, kept.length > 0 ? kept : undefined]]
  })
}

/** The enrolment of `identityId` that has not finished, or null. */
export async function readPending(network: Network, identityId: string): Promise<PendingPasskey | null> {
  const v = await idbGet<Partial<PendingPasskey>>('vault', pendingKey(network, identityId))
  return v && isBytes(v.ownerId, 32) && isBytes(v.credentialId) ? { ownerId: new Uint8Array(v.ownerId), credentialId: new Uint8Array(v.credentialId) } : null
}

/** Record an enrolment until it is stored and seen (one per identity: a newer one replaces it). */
export async function writePending(network: Network, identityId: string, pending: PendingPasskey): Promise<void> {
  const at = pendingKey(network, identityId)
  await idbUpdate<unknown>('vault', at, () => [[at, { ownerId: pending.ownerId.slice(), credentialId: pending.credentialId.slice() }]])
}

/** Drop the pending enrolment of `credentialId` (any, when omitted). */
export async function clearPending(network: Network, identityId: string, credentialId?: Uint8Array): Promise<void> {
  const at = pendingKey(network, identityId)
  await idbUpdate<Partial<PendingPasskey>>('vault', at, (current) =>
    credentialId === undefined || (isBytes(current?.credentialId) && bytesEqual(current.credentialId, credentialId)) ? [[at, undefined]] : [],
  )
}

/** Delete every passkey record this device keeps for `identityId` (forgetting it here). */
export async function forgetPasskeyRecords(network: Network, identityId: string): Promise<void> {
  await idbDelete('vault', markersKey(network, identityId))
  await idbDelete('vault', pendingKey(network, identityId))
}
