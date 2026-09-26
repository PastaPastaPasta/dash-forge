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
import { retryWhileMissing } from '../view/retry'

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
    const disable = old && old.disabledAt === undefined && isForgeBrowserKey(old) ? [old.keyId] : []
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
  // Called right after registering: a node a block behind does not show the key yet.
  const k = await retryWhileMissing(async () => {
    const identity = await authSdk(sdk).identities.fetch(identityId)
    return identity?.publicKeys.find((x) => x.keyId === keyId) ?? null
  }, 6)
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
 * A key Forge may renew over, revoke or top up: AUTHENTICATION / HIGH, bound to a contract
 * group, with a budget. Any group, not just the current one, so a key left on an old group by a contract
 * re-registration can still be disabled.
 */
export function isForgeBrowserKey(k: Pick<WasmKey, 'purposeNumber' | 'securityLevelNumber' | 'contractBounds' | 'totalBudget'>): boolean {
  return (
    k.purposeNumber === 0 &&
    k.securityLevelNumber === 2 &&
    k.contractBounds?.toJSON().$type === 'contractGroup' &&
    k.totalBudget !== undefined
  )
}

/** The top-up defaults: +0.05 DASH, and an expiry pushed out to 90 days from now if sooner. */
export const TOP_UP_DEFAULTS = { addDash: 0.05, days: 90 } as const
/** The most one top-up adds (a typo guard, not a protocol limit). */
export const TOP_UP_MAX_DASH = 10
/** The latest expiry a top-up may set, in days from now (a browser key should not live for years). */
export const TOP_UP_MAX_DAYS = 365

/**
 * Parse a DASH amount typed by a person into credits: a plain decimal, at most 11 decimal
 * places (1 credit = 10⁻¹¹ DASH), above zero and at most {@link TOP_UP_MAX_DASH}. Exact: the
 * digits are converted as integers, never through a float.
 */
export function parseDashAmount(input: string): bigint {
  const s = input.trim()
  const m = /^(\d{1,6})(?:\.(\d{1,11}))?$|^\.(\d{1,11})$/.exec(s)
  if (m === null) throw new Error('enter an amount in DASH, like 0.05')
  const whole = m[1] ?? '0'
  const frac = (m[2] ?? m[3] ?? '').padEnd(11, '0')
  const credits = BigInt(whole) * BigInt(CREDITS_PER_DASH) + BigInt(frac)
  if (credits <= 0n) throw new Error('the amount must be more than 0')
  if (credits > BigInt(TOP_UP_MAX_DASH * CREDITS_PER_DASH)) throw new Error(`at most ${TOP_UP_MAX_DASH} DASH per top-up`)
  return credits
}

/**
 * The expiry a top-up asks for: `wanted` when it is later than the key's current expiry, else
 * none (the protocol refuses an expiry that is not later, and an unchanged one is not a
 * change). `wanted` must be in the future and at most {@link TOP_UP_MAX_DAYS} days out.
 */
export function topUpExpiry(current: number | null, wanted: number | null, now = Date.now()): number | null {
  if (wanted === null) return null
  if (wanted <= now) throw new Error('the new expiry must be in the future')
  if (wanted > now + TOP_UP_MAX_DAYS * DAY_MS) throw new Error(`the new expiry can be at most ${TOP_UP_MAX_DAYS} days from now`)
  return current === null || wanted > current ? wanted : null
}

/** What a top-up will send: at least one of the two (the protocol requires one). */
export interface TopUpRequest {
  readonly addCredits: bigint | null
  readonly expiresAt: number | null
}

/** Check a top-up request has something to do. */
export function assertTopUp(req: TopUpRequest): void {
  if ((req.addCredits === null || req.addCredits <= 0n) && req.expiresAt === null) {
    throw new Error('nothing to change: add budget, or pick an expiry later than the current one')
  }
}

/**
 * The top-up was broadcast (or may have been), but its effect is not visible yet. Submitting
 * again could add the budget twice: the caller re-reads instead of retrying.
 */
export class TopUpPendingError extends Error {
  constructor(message = 'the update was sent, but the chain does not show the new limits yet') {
    super(message)
    this.name = 'TopUpPendingError'
  }
}

/**
 * Raise a Forge browser key's limits in place (`IdentityKeyLimitsUpdate`, protocol 14): add
 * budget and/or push the expiry out. The key id and private key stay the same. Signed once by
 * `masterWif` (checked to be a live MASTER key of the identity first), which is not retained.
 * Refuses a key that is not a live Forge browser key ({@link isForgeBrowserKey}). Reads the
 * key back from the chain and returns its limits.
 */
export async function topUpLimitedKey(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly identityId: string
    readonly masterWif: string
    readonly keyId: number
    readonly request: TopUpRequest
  },
): Promise<KeyLimits> {
  assertTopUp(params.request)
  const { IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === params.keyId)
  if (!identity || !k) throw new Error(`key ${params.keyId} is not on identity ${params.identityId}`)
  if (k.disabledAt !== undefined) throw new Error(`key ${params.keyId} is disabled; renew instead`)
  if (!isForgeBrowserKey(k)) throw new Error(`key ${params.keyId} is not a Forge browser key; refusing to change its limits here`)
  const expiresAt = topUpExpiry(k.expiresAt === undefined ? null : Number(k.expiresAt), params.request.expiresAt)
  const addBudget = params.request.addCredits !== null && params.request.addCredits > 0n ? params.request.addCredits : null
  assertTopUp({ addCredits: addBudget, expiresAt })

  let master: ReturnType<typeof PrivateKey.fromWIF> | null = null
  let signer: InstanceType<typeof IdentitySigner> | null = null
  let sent = false
  let landed: KeyLimits | null = null
  try {
    master = PrivateKey.fromWIF(params.masterWif)
    signer = new IdentitySigner()
    const bytes = master.toBytes()
    const isMaster = identity.publicKeys.some(
      (x) => x.securityLevelNumber === 0 && x.disabledAt === undefined && safeValidate(x, bytes, params.network),
    )
    bytes.fill(0)
    if (!isMaster) throw new Error("that key is not this identity's master key")
    signer.addKey(master)
    sent = true
    const updated = await authSdk(sdk).identities.updateKeyLimits({
      identity,
      keyId: params.keyId,
      ...(addBudget !== null ? { addBudget } : {}),
      ...(expiresAt !== null ? { expiresAt: BigInt(expiresAt) } : {}),
      signer,
    })
    try {
      if (updated.totalBudget !== undefined || updated.expiresAt !== undefined) {
        landed = { remaining: null, total: updated.totalBudget ?? null, expiresAt: updated.expiresAt === undefined ? null : Number(updated.expiresAt) }
      }
    } finally {
      updated.free()
    }
  } catch (e) {
    // Past the broadcast, a failure may still have landed: never invite a second top-up.
    if (sent) throw new TopUpPendingError(`the update may have been sent (${e instanceof Error ? e.message : String(e)}); check the key's limits before trying again`)
    throw e
  } finally {
    signer?.free()
    master?.free()
  }
  if (landed === null) throw new TopUpPendingError()

  // Read it back until a node shows what the update returned (one a block behind shows the
  // old limits for a moment); the remaining budget comes only from the chain read.
  const want = landed
  const limits = await retryWhileMissing(async () => {
    const l = await readKeyLimits(sdk, params.identityId, params.keyId)
    const ok = l !== null && l.total === want.total && l.expiresAt === want.expiresAt
    return ok ? l : null
  }, 6)
  if (limits === null) throw new TopUpPendingError()
  return limits
}

/**
 * Disable `keyId` on chain (an IdentityUpdate signed by the master key, used once and not
 * retained). Only a group-bound HIGH key — a Forge browser key — may be disabled this way.
 */
export async function revokeLimitedKey(
  sdk: EvoSDK,
  params: { readonly network: Network; readonly identityId: string; readonly masterWif: string; readonly keyId: number },
): Promise<void> {
  const { IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === params.keyId)
  if (!identity || !k) throw new Error(`key ${params.keyId} is not on identity ${params.identityId}`)
  if (k.disabledAt !== undefined) return
  if (!isForgeBrowserKey(k)) {
    throw new Error(`key ${params.keyId} is not a Forge browser key; refusing to disable it here`)
  }
  let master: ReturnType<typeof PrivateKey.fromWIF> | null = null
  let signer: InstanceType<typeof IdentitySigner> | null = null
  try {
    master = PrivateKey.fromWIF(params.masterWif)
    signer = new IdentitySigner()
    signer.addKey(master)
    await authSdk(sdk).identities.update({ identity, disablePublicKeys: [params.keyId], signer })
  } finally {
    signer?.free()
    master?.free()
  }
}
