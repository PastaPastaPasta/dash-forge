/**
 * The rules that decide which wallet-granted keys Forge signs with: an App Connect v2 grant, or a
 * key an older wallet sign-in (DashConnect, removed) left in this browser's vault, which still
 * unlocks and signs where its bounds allow (docs/design/wallet-login.md).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { contractKind, forgeContractIds, type ForgeIds } from '../deployments'
import { authSdk, type WasmKey } from '../sdk/facade'
import type { KeyLimits } from '../view/funds'
import { controlsKey, readRemainingBudget } from './limited-key'

/** What a key may sign on the dash-forge contracts. */
export interface KeyScope {
  readonly core: boolean
  readonly collab: boolean
  /** forge-community (stars, watches, follows, check runs, policies, webhooks). */
  readonly community: boolean
  /**
   * forge-meta (D44: repo keys, bans, labels, topics, pack mirrors, profiles, follows). True on a
   * three-contract set, which has no forge-meta to grant: those types are in the other three.
   */
  readonly meta: boolean
  /** No contract bounds: consensus lets it sign on any contract (the Android wallet's keys). */
  readonly unbounded: boolean
}

/**
 * The scope of an AUTHENTICATION key over Forge's contracts, or null when Forge must not use
 * it: bound to another contract or group (it is another app's key, or a key left on a
 * superseded group), or to a single document type. A key bound to the group covers all of them.
 * On a deployment that predates the split forge-community is forge-collab, so a forge-collab key
 * covers it too.
 */
export function keyScope(k: Pick<WasmKey, 'contractBounds'>, forge: ForgeIds): KeyScope | null {
  const bounds = k.contractBounds?.toJSON()
  if (bounds === undefined || bounds === null) return { core: true, collab: true, community: true, meta: true, unbounded: true }
  if (bounds.$type === 'contractGroup') return bounds.id === forge.group ? { core: true, collab: true, community: true, meta: true, unbounded: false } : null
  if (bounds.$type === 'singleContract') {
    if (!forgeContractIds(forge).includes(bounds.id)) return null
    // forge-meta is covered on a three-contract set: its types sit in the other three.
    return { core: bounds.id === forge.core, collab: bounds.id === forge.collab, community: bounds.id === forge.community, meta: bounds.id === forge.meta || forge.meta === undefined, unbounded: false }
  }
  return null
}

/**
 * Whether a scope lets the key sign on `contractId`. Only Forge's contracts are ever asked
 * about; anything else is refused, whatever the key's bounds.
 */
export function scopeCovers(scope: KeyScope, forge: ForgeIds, contractId: string): boolean {
  const kind = contractKind(forge, contractId)
  return kind !== null && scope[kind]
}

/** Whether `contractId` is one of Forge's contracts. */
export function isForgeContract(forge: ForgeIds, contractId: string | undefined): contractId is string {
  return contractKind(forge, contractId) !== null
}

/** A wallet-granted key Forge verified on chain. */
export interface WalletKey {
  readonly keyId: number
  readonly wif: string
  readonly scope: KeyScope
  /** Budget and expiry; null for a key that has neither (what an older wallet sign-in registered). */
  readonly limits: KeyLimits | null
}

/** Why a key the wallet granted is not one Forge will use. */
export class UnusableWalletKey extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableWalletKey'
  }
}

/** The wallet's key for Forge is on the identity but disabled: Forge never signs with a revoked key. */
export class RevokedWalletKey extends UnusableWalletKey {
  constructor(readonly keyId: number) {
    super(
      `Your wallet's key for Dash Forge (key ${keyId}) was disabled on this identity. Sign in again with your wallet, or with your identity file or recovery phrase.`,
    )
    this.name = 'RevokedWalletKey'
  }
}

/**
 * Check a key Forge may sign with: live, AUTHENTICATION/HIGH (never CRITICAL or MASTER: more
 * than Forge needs), inside Forge's contracts, not expired, and controlled by `wif`. Returns its
 * scope; throws {@link UnusableWalletKey}. Synchronous: the budget is read separately.
 */
export function checkWalletKey(k: WasmKey, wif: string, forge: ForgeIds, network: Network): KeyScope {
  if (k.disabledAt !== undefined) throw new RevokedWalletKey(k.keyId)
  if (k.purposeNumber !== 0 || k.securityLevelNumber !== 2) throw new UnusableWalletKey(`key ${k.keyId} is not an AUTHENTICATION/HIGH key; Forge only signs with HIGH keys`)
  const scope = keyScope(k, forge)
  if (scope === null) throw new UnusableWalletKey(`key ${k.keyId} is bound to contracts outside Dash Forge`)
  if (k.expiresAt !== undefined && Number(k.expiresAt) <= Date.now()) throw new UnusableWalletKey(`key ${k.keyId} has expired`)
  if (!controlsKey(k, wif, network)) throw new UnusableWalletKey(`the granted private key does not control key ${k.keyId}`)
  return scope
}

/**
 * The key `wif` controls on `identityId`, checked ({@link checkWalletKey}) with its limits; null
 * when no key matches (not registered yet). A match that is only a disabled key throws
 * {@link RevokedWalletKey}.
 */
export async function findWalletKey(sdk: EvoSDK, p: { identityId: string; wif: string; forge: ForgeIds; network: Network }): Promise<WalletKey | null> {
  const identity = await authSdk(sdk).identities.fetch(p.identityId)
  const matches = (identity?.publicKeys ?? []).filter((k) => controlsKey(k, p.wif, p.network))
  const k = matches.find((x) => x.disabledAt === undefined) ?? matches[0]
  if (!k) return null
  const scope = checkWalletKey(k, p.wif, p.forge, p.network)
  let limits: KeyLimits | null = null
  if (k.totalBudget !== undefined || k.expiresAt !== undefined) {
    const remaining = k.totalBudget === undefined ? null : await readRemainingBudget(sdk, p.identityId, k.keyId)
    if (remaining !== null && remaining <= 0n) throw new UnusableWalletKey(`key ${k.keyId} has no budget left`)
    limits = { remaining, total: k.totalBudget ?? null, expiresAt: k.expiresAt === undefined ? null : Number(k.expiresAt) }
  }
  return { keyId: k.keyId, wif: p.wif, scope, limits }
}

/** A key without a budget or without an expiry. */
export function hasNoLimits(k: Pick<WasmKey, 'totalBudget' | 'expiresAt'>): boolean {
  return k.totalBudget === undefined || k.expiresAt === undefined
}

/** A key has no budget or no expiry: whoever copies it can spend until it is disabled. */
export function isUnlimited(key: Pick<WalletKey, 'limits'>): boolean {
  return key.limits === null || key.limits.total === null || key.limits.expiresAt === null
}
