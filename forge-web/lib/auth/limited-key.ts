/**
 * PV14 limited keys (`ux-dx-spec.md` §2.1; platform `authentication-key-limits.md`,
 * `contract-bound-authentication-keys.md`).
 *
 * A browser signs with an AUTHENTICATION / HIGH key that is:
 *   - bound to the `dash-forge` contract group (`contractBounds: contractGroup`) — it can sign
 *     only Batch transitions on forge-core and forge-collab; an identity update, a credit
 *     transfer or a write to any other contract is refused at consensus;
 *   - budgeted (`totalBudget`, default 0.05 DASH) — it can take at most that from the identity;
 *   - expiring (`expiresAt`, default 90 days).
 *
 * The master key signs the one IdentityUpdate that registers it (and the new key signs its own
 * proof of possession) and is not retained: the WASM objects holding it are freed (which
 * releases, but does not zero, their memory) and no reference to the WIF is kept. JS strings
 * cannot be zeroed; the design minimizes how long they live.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { CREDITS_PER_DASH } from '../sdk/cost'
import { authSdk, type WasmKey } from '../sdk/facade'
import type { KeyLimits } from '../view/funds'

/** Browser key defaults (spec §2.1). */
export const BROWSER_KEY_DEFAULTS = { budgetDash: 0.05, days: 90 } as const
const DAY_MS = 24 * 60 * 60 * 1000

export interface LimitedKeyRequest {
  readonly budgetCredits: bigint
  readonly expiresAt: number
}

/** The default request: 0.05 DASH for 90 days from `now`. */
export function defaultLimits(now = Date.now()): LimitedKeyRequest {
  return {
    budgetCredits: BigInt(Math.round(BROWSER_KEY_DEFAULTS.budgetDash * CREDITS_PER_DASH)),
    expiresAt: now + BROWSER_KEY_DEFAULTS.days * DAY_MS,
  }
}

/** A registered limited key: its id and private key (WIF). */
export interface LimitedKey {
  readonly keyId: number
  readonly wif: string
  readonly limits: KeyLimits
}

/**
 * Register a limited key on `identityId`, signed once by `masterWif`. Generates the new key
 * in the WASM (not retained beyond the returned WIF), registers it, verifies on chain that it
 * landed with the group bound, the requested budget and expiry, and returns it. The group is
 * first checked on chain to hold forge-core and forge-collab.
 *
 * `replaceKeyId`: a renewal disables this browser's previous limited key in the same update,
 * so renewing never leaves a live key nobody holds. Only a live group-bound HIGH key is
 * disabled; anything else named is ignored.
 */
export async function registerLimitedKey(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly identityId: string
    readonly masterWif: string
    readonly group: string
    readonly request?: LimitedKeyRequest
    readonly replaceKeyId?: number
    /** The contracts the group must hold (forge-core, forge-collab), checked on chain first. */
    readonly contracts?: readonly string[]
  },
): Promise<LimitedKey> {
  const { IdentityPublicKeyInCreation, ContractBounds, IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const request = params.request ?? defaultLimits()
  if (params.contracts) await assertGroupHolds(sdk, params.group, params.contracts)
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  if (!identity) throw new Error(`identity ${params.identityId} not found on ${params.network}`)

  // The master key must be one of this identity's MASTER keys; say so plainly rather than
  // letting consensus refuse an update signed by the wrong key.
  const master = PrivateKey.fromWIF(params.masterWif)
  const masterBytes = master.toBytes()
  const isMaster = identity.publicKeys.some(
    (k) => k.securityLevelNumber === 0 && k.disabledAt === undefined && safeValidate(k, masterBytes, params.network),
  )
  masterBytes.fill(0)
  if (!isMaster) {
    master.free()
    throw new Error("that key is not this identity's master key")
  }

  const fresh = PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), params.network === 'mainnet' ? 'mainnet' : 'testnet')
  const keyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1
  const signer = new IdentitySigner()
  try {
    signer.addKey(master)
    signer.addKey(fresh)
    const key = new IdentityPublicKeyInCreation({
      keyId,
      purpose: 'authentication',
      securityLevel: 'high',
      keyType: 'ecdsa_secp256k1',
      data: fresh.getPublicKey().toBytes(),
      contractBounds: ContractBounds.ContractGroup(params.group),
      totalBudget: request.budgetCredits,
      expiresAt: BigInt(request.expiresAt),
    })
    const old = identity.publicKeys.find((k) => k.keyId === params.replaceKeyId)
    const disable =
      old && old.disabledAt === undefined && old.securityLevelNumber === 2 && old.contractBounds?.toJSON().id === params.group
        ? [old.keyId]
        : []
    try {
      await authSdk(sdk).identities.update({ identity, addPublicKeys: [key], ...(disable.length ? { disablePublicKeys: disable } : {}), signer })
    } catch (e) {
      // Two tabs registering at once both pick max+1; the second is refused.
      if (/revision|duplicate|already exists|key id/i.test(String((e as { message?: unknown })?.message ?? e))) {
        throw new Error('another key was registered on this identity at the same moment; try again')
      }
      throw e
    }
  } finally {
    signer.free()
    master.free()
  }
  const wif = fresh.toWIF()
  fresh.free()
  const limits = await verifyLimitedKey(sdk, params.identityId, keyId, params.group, params.network, wif, request)
  return { keyId, wif, limits }
}

function safeValidate(k: WasmKey, bytes: Uint8Array, network: Network): boolean {
  try {
    return k.validatePrivateKey(bytes, network)
  } catch {
    return false
  }
}

/**
 * Read a key back from the chain and check it is what a Forge browser key must be: live,
 * AUTHENTICATION / HIGH, bound to `group`, with a budget and an expiry, and (when `wif` is
 * given) controlled by that private key. Returns its limits (remaining budget included).
 */
export async function verifyLimitedKey(
  sdk: EvoSDK,
  identityId: string,
  keyId: number,
  group: string,
  network: Network,
  wif?: string,
  request?: LimitedKeyRequest,
): Promise<KeyLimits> {
  const identity = await authSdk(sdk).identities.fetch(identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === keyId)
  if (!k) throw new Error(`key ${keyId} is not on identity ${identityId}`)
  if (k.disabledAt !== undefined) throw new Error(`key ${keyId} is disabled`)
  if (k.purposeNumber !== 0 || k.securityLevelNumber !== 2) throw new Error(`key ${keyId} is not an AUTHENTICATION/HIGH key`)
  const bounds = k.contractBounds?.toJSON()
  if (bounds?.$type !== 'contractGroup' || bounds.id !== group) {
    throw new Error(`key ${keyId} is not bound to the dash-forge contract group`)
  }
  if (k.totalBudget === undefined || k.expiresAt === undefined) throw new Error(`key ${keyId} has no budget or expiry`)
  if (Number(k.expiresAt) <= Date.now()) throw new Error(`key ${keyId} has expired`)
  if (request) {
    if (k.totalBudget !== request.budgetCredits) throw new Error(`key ${keyId} has a different budget than requested`)
    if (Number(k.expiresAt) !== request.expiresAt) throw new Error(`key ${keyId} has a different expiry than requested`)
  }
  if (wif !== undefined) {
    const { PrivateKey } = await import('@dashevo/evo-sdk')
    const pk = PrivateKey.fromWIF(wif)
    const bytes = pk.toBytes()
    const ok = safeValidate(k, bytes, network)
    bytes.fill(0)
    pk.free()
    if (!ok) throw new Error(`the stored private key does not control key ${keyId}`)
  }
  const remaining = await readRemainingBudget(sdk, identityId, keyId)
  if (remaining !== null && remaining <= 0n) throw new Error(`key ${keyId} has no budget left`)
  return { remaining, total: k.totalBudget, expiresAt: Number(k.expiresAt) }
}

/** What is left of a key's budget (null when it has none). */
export async function readRemainingBudget(sdk: EvoSDK, identityId: string, keyId: number): Promise<bigint | null> {
  const map = await authSdk(sdk).identities.keysRemainingBudgets(identityId, [keyId])
  return map.get(keyId) ?? null
}

/** The limits of a key already on the identity (for a session resumed from the vault). */
export async function readKeyLimits(sdk: EvoSDK, identityId: string, keyId: number): Promise<KeyLimits | null> {
  const identity = await authSdk(sdk).identities.fetch(identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === keyId)
  if (!k) return null
  if (k.totalBudget === undefined && k.expiresAt === undefined) return null
  const remaining = k.totalBudget === undefined ? null : await readRemainingBudget(sdk, identityId, keyId)
  return {
    remaining,
    total: k.totalBudget ?? null,
    expiresAt: k.expiresAt === undefined ? null : Number(k.expiresAt),
  }
}

/**
 * Refuse to bind a key to a group the chain does not show holding the forge contracts. The
 * group id comes from the bundled deployment file; this checks it against state. (Its owner
 * can add contracts later, which widens every group-bound key: see docs/guides/identity-and-keys.md.)
 */
export async function assertGroupHolds(sdk: EvoSDK, group: string, contracts: readonly string[]): Promise<void> {
  const facade = (sdk as unknown as { contractGroups: { forContract(id: string): Promise<{ toJSON?(): { contract: string[] }; contract?: string[] }> } }).contractGroups
  for (const id of contracts) {
    const m = await facade.forContract(id)
    const groups = (m.toJSON ? m.toJSON() : m).contract ?? []
    if (!groups.includes(group)) throw new Error(`contract ${id} is not in the dash-forge group on chain; refusing to bind a key to it`)
  }
}

/**
 * Disable `keyId` on chain (an IdentityUpdate signed by the master key, used once and not
 * retained). Only a group-bound HIGH key — a Forge browser key — may be disabled this way.
 */
export async function revokeLimitedKey(
  sdk: EvoSDK,
  params: { readonly network: Network; readonly identityId: string; readonly masterWif: string; readonly keyId: number; readonly group: string },
): Promise<void> {
  const { IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === params.keyId)
  if (!identity || !k) throw new Error(`key ${params.keyId} is not on identity ${params.identityId}`)
  if (k.disabledAt !== undefined) return
  if (k.securityLevelNumber !== 2 || k.contractBounds?.toJSON().id !== params.group) {
    throw new Error(`key ${params.keyId} is not a Forge browser key; refusing to disable it here`)
  }
  const master = PrivateKey.fromWIF(params.masterWif)
  const signer = new IdentitySigner()
  try {
    signer.addKey(master)
    await authSdk(sdk).identities.update({ identity, disablePublicKeys: [params.keyId], signer })
  } finally {
    signer.free()
    master.free()
  }
}
