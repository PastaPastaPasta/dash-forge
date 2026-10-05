/**
 * Devices & keys (trust and safety TS-07): every key of the signed-in identity as the chain has
 * it, what each one is for, what is left of its budget and when it expires, with local labels
 * ("work laptop") that never leave this browser. A lost device's key is disabled from here.
 *
 * Platform keeps no "last used" per key: what the page can say is how much of a budget is spent
 * (the chain's remaining budget) and when this browser last wrote (its own spend ledger).
 */

import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { WasmKey } from '../sdk/facade'
import { keyScope } from './key-registration'

/** What a key is, in the words Devices & keys uses. */
export type KeyRole = 'master' | 'forge' | 'forge-contract' | 'signing' | 'encryption' | 'transfer' | 'other'

export interface KeyRow {
  readonly keyId: number
  readonly role: KeyRole
  readonly purpose: number
  readonly level: number
  /** When it was disabled (ms), or null while live. */
  readonly disabledAt: number | null
  readonly budgetTotal: bigint | null
  readonly budgetLeft: bigint | null
  readonly expiresAt: number | null
  /** A key this browser holds (its signing key, a wallet grant, a key held to be disabled). */
  readonly thisBrowser: boolean
}

/** Classify a chain key for the page (Forge's bounds as `keyScope` reads them). */
export function keyRole(k: Pick<WasmKey, 'purposeNumber' | 'securityLevelNumber' | 'contractBounds'>, forge: ForgeIds | undefined): KeyRole {
  if (k.securityLevelNumber === 0) return 'master'
  if (k.purposeNumber === 1) return 'encryption'
  if (k.purposeNumber === 3) return 'transfer'
  if (k.purposeNumber !== 0) return 'other'
  if (forge === undefined) return 'other'
  const scope = keyScope(k, forge)
  if (scope === null) return 'other'
  if (scope.unbounded) return 'signing'
  return scope.core && scope.collab && scope.community ? 'forge' : 'forge-contract'
}

/** Roles Devices & keys may disable: keys bound to Forge, which nothing else signs with. */
export const DISABLEABLE: ReadonlySet<KeyRole> = new Set(['forge', 'forge-contract'])

/** One line on what a key is for. */
export const ROLE_TEXT: Readonly<Record<KeyRole, string>> = {
  master: 'Master key. Adds and disables keys; never used to sign here.',
  forge: 'Forge key with a budget and an expiry: a browser, dg or a CI runner.',
  'forge-contract': 'Key for one Forge contract (a wallet sign-in or a CI runner).',
  signing: 'Signing key with no contract limits: your wallet and other apps may sign with it.',
  encryption: 'Encryption key for private repos.',
  transfer: 'Transfer key. Moves credits out of the identity.',
  other: 'Key for another app or contract.',
}

/** The rows for an identity's keys, newest first, live before disabled. */
export function keyRows(keys: readonly WasmKey[], budgets: ReadonlyMap<number, bigint | null>, forge: ForgeIds | undefined, held: readonly number[]): KeyRow[] {
  return keys
    .map((k) => ({
      keyId: k.keyId,
      role: keyRole(k, forge),
      purpose: k.purposeNumber,
      level: k.securityLevelNumber,
      disabledAt: k.disabledAt === undefined ? null : Number(k.disabledAt),
      budgetTotal: k.totalBudget ?? null,
      budgetLeft: k.totalBudget === undefined ? null : (budgets.get(k.keyId) ?? null),
      expiresAt: k.expiresAt === undefined ? null : Number(k.expiresAt),
      thisBrowser: held.includes(k.keyId),
    }))
    .sort((a, b) => Number(a.disabledAt !== null) - Number(b.disabledAt !== null) || b.keyId - a.keyId)
}

/**
 * Why this page can't disable `row`, or null when it can. The master key can't be disabled at
 * all; this browser's own keys go through Revoke (which also forgets them here); the encryption
 * key is never disabled here (private repos open with it); unbounded signing keys (a wallet's), transfer and other apps'
 * keys are left to `dg auth keys disable --force`, where their effect is spelled out.
 */
export function disableRefusal(row: KeyRow): string | null {
  if (row.disabledAt !== null) return 'Already disabled.'
  if (row.role === 'master') return "The master key can't be disabled."
  if (row.thisBrowser) return 'This browser holds it: use Revoke on Platform in Settings.'
  if (row.role === 'encryption') return 'Your private repos open with it, so it is not disabled here.'
  if (!DISABLEABLE.has(row.role)) return `Not a Forge key: other apps may rely on it. Use dg auth keys disable ${row.keyId} --force.`
  return null
}

const labelsKey = (network: Network, identityId: string): string => `forge:key-labels:${network}:${identityId}`

/** The labels this browser gave the identity's keys ("work laptop"). Never sent anywhere. */
export function readKeyLabels(network: Network, identityId: string): Record<number, string> {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(labelsKey(network, identityId)) ?? '{}')
    if (typeof v !== 'object' || v === null) return {}
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => /^\d+$/.test(k) && typeof x === 'string')) as Record<number, string>
  } catch {
    return {}
  }
}

/** Label a key on this browser (empty clears it). At most 40 characters. */
export function writeKeyLabel(network: Network, identityId: string, keyId: number, label: string): Record<number, string> {
  const labels = { ...readKeyLabels(network, identityId) }
  const text = label.trim().slice(0, 40)
  if (text === '') delete labels[keyId]
  else labels[keyId] = text
  try {
    globalThis.localStorage?.setItem(labelsKey(network, identityId), JSON.stringify(labels))
  } catch {
    /* storage blocked: the label lasts for this page */
  }
  return labels
}

/**
 * Whether this browser's storage is persistent (TS-17): the vault, journals and spend ledger
 * live in IndexedDB, which a browser may clear under storage pressure, and Safari clears after
 * seven days without a visit unless the site's storage is persistent.
 */
export type StoragePersistence = 'persistent' | 'may-clear' | 'unknown'

export async function storagePersistence(): Promise<StoragePersistence> {
  const storage = globalThis.navigator?.storage
  if (storage?.persisted === undefined) return 'unknown'
  try {
    return (await storage.persisted()) ? 'persistent' : 'may-clear'
  } catch {
    return 'unknown'
  }
}

/** Ask the browser to keep this site's storage (no prompt in most browsers). */
export async function requestPersistence(): Promise<StoragePersistence> {
  const storage = globalThis.navigator?.storage
  if (storage?.persist === undefined) return 'unknown'
  try {
    return (await storage.persist()) ? 'persistent' : 'may-clear'
  } catch {
    return 'unknown'
  }
}
