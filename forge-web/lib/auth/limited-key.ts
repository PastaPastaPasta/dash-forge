/**
 * PV14 limited keys (`ux-dx-spec.md` §2.1; platform `authentication-key-limits.md`,
 * `contract-bound-authentication-keys.md`).
 *
 * A browser signs with an AUTHENTICATION / HIGH key that is:
 *   - bound to the `dash-forge` contract group (`contractBounds: contractGroup`) — it can sign
 *     only Batch transitions on the group's members (forge-core, forge-collab, and any later
 *     Forge contract the deployer adds: `./group-trust`); an identity update, a credit transfer
 *     or a write to any other contract is refused at consensus;
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
import type { GroupTrust } from '../deployments'
import { CREDITS_PER_DASH } from '../sdk/cost'
import { authSdk, type WasmKey } from '../sdk/facade'
import { isQuorumMiss } from '../sdk/unreachable'
import type { KeyLimits } from '../view/funds'
import { retryWhileMissing } from '../view/retry'
import { abbreviate, errorMessage } from '../utils'
import { assertGroupHolds } from './group-trust'
import { controlsKey } from './wif'

export { controlsKey }

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

/** How long a new browser key may live, in days: renewals stay rare, and no key lives past a year (TS-06). */
export const KEY_LIFETIME_DAYS = [30, 90, 180, 365] as const

/** A lifetime as the picker words it. */
export function lifetimeLabel(days: number): string {
  return days === 365 ? '1 year' : days === 180 ? '6 months' : `${days} days`
}

/** The default budget for `days` from `now`. */
export function limitsFor(days: number, now = Date.now()): LimitedKeyRequest {
  return { ...defaultLimits(now), expiresAt: now + days * DAY_MS }
}

/** An identity id as the key-mismatch copy names it: `DhRR5hs…` ({@link abbreviate}'s 7 characters). */
export function shortId(id: string): string {
  return id.length > 8 ? `${abbreviate(id)}…` : id
}

/**
 * The master key given is not a live MASTER key of the identity (QW3-028: the update was refused
 * as "that key is not this identity's master key", or by the SDK's "Signer does not have a
 * private key for any of the identity's master keys" after a network round trip). Checked before
 * anything is signed; the caller words it for what was given (a file, the words).
 */
export class WrongMasterKeyError extends Error {
  constructor(
    readonly identityId: string,
    message = `That master key doesn't belong to identity ${shortId(identityId)}. Use this identity's own identity file or recovery phrase.`,
  ) {
    super(message)
    this.name = 'WrongMasterKeyError'
  }
}

/** Refuse `masterWif` unless it is a live MASTER key of `identity` ({@link WrongMasterKeyError}). */
export async function assertMasterKeyOf(identity: { readonly publicKeys: readonly WasmKey[] }, identityId: string, masterWif: string, network: Network): Promise<void> {
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const master = PrivateKey.fromWIF(masterWif)
  try {
    const bytes = master.toBytes()
    const ok = identity.publicKeys.some((k) => k.securityLevelNumber === 0 && k.disabledAt === undefined && safeValidate(k, bytes, network))
    bytes.fill(0)
    if (!ok) throw new WrongMasterKeyError(identityId)
  } finally {
    master.free()
  }
}

/** wasm-sdk's identity update (`state_transitions/identity.rs`) reads the nonce before it signs or sends anything. */
const NONCE_READ_FAILED = /^Failed to get identity nonce/

/**
 * An identity update that was never sent: its nonce read failed, which happens before anything
 * is signed (QW3-007: during a quorum rotation it surfaced as the raw "Failed to get identity
 * nonce: Proof verification error: … Quorum not found in cache …"). Nothing was charged.
 */
export class IdentityUpdateNotSentError extends Error {
  constructor(readonly causeError: unknown) {
    super(
      isQuorumMiss(causeError)
        ? "Platform is switching to a new quorum and couldn't take this update yet. Nothing was sent, and you weren't charged. Try again in a minute."
        : `Couldn't reach Platform for this update (${errorMessage(causeError)}). Nothing was sent, and you weren't charged. Try again in a moment.`,
    )
    this.name = 'IdentityUpdateNotSentError'
  }
}

/**
 * Send a master-key identity update (`update`, which calls `identities.update` on `sdk`). Its
 * nonce read fails before anything is signed, so such a failure is safe to retry: one on a
 * rotated quorum (#212) waits, as reads do, for the network's quorum service (a proved read of
 * the same nonce, `EvoSdkService.waitForQuorum`, which reconnects), then the update runs again
 * on the new connection. Gives up as {@link IdentityUpdateNotSentError}. A failure past the
 * nonce read (the broadcast) is passed on as it is: that update may have landed.
 */
export async function sendIdentityUpdate(sdk: EvoSDK, identityId: string, update: () => Promise<void>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await update()
      return
    } catch (e) {
      if (!NONCE_READ_FAILED.test(errorMessage(e, ''))) throw e
      if (attempt >= attempts || !isQuorumMiss(e)) throw new IdentityUpdateNotSentError(e)
      try {
        await authSdk(sdk).identities.nonce(identityId)
      } catch (read) {
        throw new IdentityUpdateNotSentError(read)
      }
    }
  }
}

/** A registered limited key: its id and private key (WIF). */
export interface LimitedKey {
  readonly keyId: number
  readonly wif: string
  readonly limits: KeyLimits
}

/** A limited key prepared for registration: the key id it will take and its private key. */
export interface PreparedKey {
  readonly keyId: number
  readonly wif: string
}

/**
 * Register a limited key on `identityId`, signed once by `masterWif`, verify on chain that it
 * landed with the group bound, the requested budget and expiry, and return it. The group is
 * first checked on chain against its pinned owner (`./group-trust`): pass `trust`, or
 * `groupChecked: true` when the caller has just run that check itself.
 *
 * `persist` (D-016): called with the new key's id and private key BEFORE anything changes on
 * chain. It must store the key durably (and read it back); if it throws, nothing is sent: no
 * fee, and the old key keeps working. Only then is the identity update signed. Without it the
 * key exists only in memory until this returns, so a caller that stores it afterwards and fails
 * would leave the old key disabled and the new one held by nobody.
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
    /**
     * Wallet-granted keys this browser holds (with their private keys), disabled in the same
     * update: each is disabled only if the stored private key controls it.
     */
    readonly disableHeld?: readonly HeldKey[]
    /** Store the prepared key durably before the chain changes (see above). */
    readonly persist?: (key: PreparedKey) => Promise<void>
    /**
     * Drop what `persist` stored: called only when the update was provably never sent (its nonce
     * read failed, {@link IdentityUpdateNotSentError}), so no key is left behind that Platform
     * never saw (QW3-007: a "phantom" stored key, "Session locked" and a false renewal offer).
     */
    readonly unpersist?: (key: PreparedKey) => Promise<void>
  } & (
    | {
        /** The group's pinned trust root (`groupTrust`), checked on chain first. */
        readonly trust: GroupTrust
      }
    | {
        /** The caller ran `assertGroupHolds` for this group just before: do not repeat it. */
        readonly groupChecked: true
      }
  ),
): Promise<LimitedKey> {
  const { IdentityPublicKeyInCreation, ContractBounds, IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const request = params.request ?? defaultLimits()
  if ('trust' in params) await assertGroupHolds(sdk, params.group, params.trust)
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  if (!identity) throw new Error(`identity ${params.identityId} not found on ${params.network}`)

  // The master key must be one of this identity's MASTER keys; say so plainly rather than
  // letting consensus refuse an update signed by the wrong key.
  await assertMasterKeyOf(identity, params.identityId, params.masterWif, params.network)
  const master = PrivateKey.fromWIF(params.masterWif)

  const fresh = PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), params.network === 'mainnet' ? 'mainnet' : 'testnet')
  const keyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1
  const wif = fresh.toWIF()
  if (params.persist) {
    try {
      await params.persist({ keyId, wif })
    } catch (e) {
      fresh.free()
      master.free()
      throw e
    }
  }
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
    const disable = new Set(heldToDisable(identity.publicKeys, params.disableHeld ?? [], params.network))
    if (old && old.disabledAt === undefined && isForgeBrowserKey(old)) disable.add(old.keyId)
    try {
      await sendIdentityUpdate(sdk, params.identityId, () =>
        authSdk(sdk).identities.update({ identity, addPublicKeys: [key], ...(disable.size ? { disablePublicKeys: [...disable] } : {}), signer }),
      )
    } catch (e) {
      // Never sent: the stored key is no key of the identity's, so it does not stay here.
      if (e instanceof IdentityUpdateNotSentError) {
        await params.unpersist?.({ keyId, wif }).catch(() => undefined)
        throw e
      }
      // Two tabs registering at once both pick max+1; the second is refused.
      if (/revision|duplicate|already exists|key id/i.test(String((e as { message?: unknown })?.message ?? e))) {
        throw new Error('another key was registered on this identity at the same moment; try again')
      }
      throw e
    }
  } finally {
    signer.free()
    master.free()
    fresh.free()
  }
  const limits = await verifyLimitedKey(sdk, params.identityId, keyId, params.group, params.network, wif, request)
  return { keyId, wif, limits }
}

/** A key this browser holds: its id and the private key that proves it is this browser's. */
export interface HeldKey {
  readonly keyId: number
  readonly wif: string
}

/**
 * The ids of `held` keys that are live AUTHENTICATION / HIGH keys of the identity AND
 * controlled by the private key this browser stored for them. The proof matters: a master-key
 * update may disable any key, so a key id alone (from a tampered record, say) must never pick
 * what gets disabled. (HIGH only: a browser never holds CRITICAL or MASTER keys.)
 */
export function heldToDisable(keys: readonly WasmKey[], held: readonly HeldKey[], network: Network): number[] {
  const out: number[] = []
  for (const h of held) {
    const k = keys.find((x) => x.keyId === h.keyId)
    if (!k || k.disabledAt !== undefined || k.purposeNumber !== 0 || k.securityLevelNumber !== 2) continue
    if (controlsKey(k, h.wif, network)) out.push(k.keyId)
  }
  return out
}

/**
 * Disable the keys this browser holds for the identity (wallet grants included), in one
 * master-key update. Only keys the stored private keys control are disabled
 * ({@link heldToDisable}); if none is still live, nothing is sent. Resolves with whether an
 * update was sent (the spend ledger records only those).
 */
export async function disableHeldKeys(
  sdk: EvoSDK,
  params: { readonly network: Network; readonly identityId: string; readonly masterWif: string; readonly keys: readonly HeldKey[] },
): Promise<boolean> {
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  if (!identity) throw new Error(`identity ${params.identityId} not found`)
  const ids = heldToDisable(identity.publicKeys, params.keys, params.network)
  if (ids.length === 0) return false
  await assertMasterKeyOf(identity, params.identityId, params.masterWif, params.network)
  await withMasterSigner(params.masterWif, (signer) =>
    sendIdentityUpdate(sdk, params.identityId, () => authSdk(sdk).identities.update({ identity, disablePublicKeys: ids, signer })),
  )
  return true
}

/** Run `fn` with an IdentitySigner holding only the master key; both are freed after. */
async function withMasterSigner<T>(masterWif: string, fn: (signer: unknown) => Promise<T>): Promise<T> {
  const { IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  let master: ReturnType<typeof PrivateKey.fromWIF> | null = null
  let signer: InstanceType<typeof IdentitySigner> | null = null
  try {
    master = PrivateKey.fromWIF(masterWif)
    signer = new IdentitySigner()
    signer.addKey(master)
    return await fn(signer)
  } finally {
    signer?.free()
    master?.free()
  }
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
  // Not shown can be a node behind, not a verdict: the caller retries rather than replace it.
  if (!k) throw new Error(`key ${keyId} is not on identity ${identityId}`)
  if (k.disabledAt !== undefined) throw new UnusableLimitedKeyError(`key ${keyId} is disabled`)
  if (k.purposeNumber !== 0 || k.securityLevelNumber !== 2) throw new UnusableLimitedKeyError(`key ${keyId} is not an AUTHENTICATION/HIGH key`)
  const bounds = k.contractBounds?.toJSON()
  if (bounds?.$type !== 'contractGroup' || bounds.id !== group) {
    throw new UnusableLimitedKeyError(`key ${keyId} is not bound to the dash-forge contract group`)
  }
  if (k.totalBudget === undefined || k.expiresAt === undefined) throw new UnusableLimitedKeyError(`key ${keyId} has no budget or expiry`)
  if (Number(k.expiresAt) <= Date.now()) throw new UnusableLimitedKeyError(`key ${keyId} has expired`)
  if (request) {
    if (k.totalBudget !== request.budgetCredits) throw new UnusableLimitedKeyError(`key ${keyId} has a different budget than requested`)
    if (Number(k.expiresAt) !== request.expiresAt) throw new UnusableLimitedKeyError(`key ${keyId} has a different expiry than requested`)
  }
  if (wif !== undefined && !controlsKey(k, wif, network)) throw new UnusableLimitedKeyError(`the stored private key does not control key ${keyId}`)
  // Drive writes a new key's remaining budget with the key (v5 book `data-model/key-limits.md`:
  // "remaining budget = budget"), so a key with a budget always has one: an absent entry is a
  // node that has not seen the key yet (QW4-020: the session then had no budget, and the funds
  // pill read "Balance … · expires …"). A key registered just now (`request`) has spent nothing,
  // so its remaining budget is its total.
  const remaining = (await readRemainingBudget(sdk, identityId, keyId)) ?? (request ? k.totalBudget : null)
  if (remaining !== null && remaining <= 0n) throw new UnusableLimitedKeyError(`key ${keyId} has no budget left`)
  return { remaining, total: k.totalBudget, expiresAt: Number(k.expiresAt) }
}

/**
 * The key Platform returned cannot be used as this browser's key (disabled, expired, wrong
 * bounds, not ours, no budget): a definite answer, unlike a read that failed or a key not shown.
 */
export class UnusableLimitedKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableLimitedKeyError'
  }
}

/** What is left of a key's budget (null when it has none). */
export async function readRemainingBudget(sdk: EvoSDK, identityId: string, keyId: number): Promise<bigint | null> {
  const map = await authSdk(sdk).identities.keysRemainingBudgets(identityId, [keyId])
  return map.get(keyId) ?? null
}

/**
 * `fresh`, a re-read of a key's limits, with `known`'s remaining budget when the re-read has none
 * for a key that has a budget (QW4-020): Drive keeps one for every such key, so an absent entry
 * is a node behind, not a key without a budget, and the session keeps what it knew (at most the
 * total) rather than losing its budget line until the next read.
 */
export function withKnownRemaining(fresh: KeyLimits | null, known: KeyLimits | null): KeyLimits | null {
  if (fresh === null || fresh.remaining !== null || fresh.total === null || known?.remaining == null) return fresh
  return { ...fresh, remaining: known.remaining < fresh.total ? known.remaining : fresh.total }
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
  if (!isForgeBrowserKey(k)) throw new Error(`key ${params.keyId} isn't a key Forge made for a browser; refusing to change its limits here`)
  const expiresAt = topUpExpiry(k.expiresAt === undefined ? null : Number(k.expiresAt), params.request.expiresAt)
  const addBudget = params.request.addCredits !== null && params.request.addCredits > 0n ? params.request.addCredits : null
  assertTopUp({ addCredits: addBudget, expiresAt })

  await assertMasterKeyOf(identity, params.identityId, params.masterWif, params.network)
  // The SDK's limits update reads the nonce itself, and its failures cannot be told apart from a
  // broadcast's (so any is "may have been sent"). A proved read of the same nonce first waits
  // out a quorum rotation like any read (QW3-007) and leaves the connection with current keys.
  try {
    await authSdk(sdk).identities.nonce(params.identityId)
  } catch (e) {
    throw new IdentityUpdateNotSentError(e)
  }
  let master: ReturnType<typeof PrivateKey.fromWIF> | null = null
  let signer: InstanceType<typeof IdentitySigner> | null = null
  let sent = false
  let landed: KeyLimits | null = null
  try {
    master = PrivateKey.fromWIF(params.masterWif)
    signer = new IdentitySigner()
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
 * Resolves with whether an update was sent (false: the key was already disabled).
 */
export async function revokeLimitedKey(
  sdk: EvoSDK,
  params: { readonly network: Network; readonly identityId: string; readonly masterWif: string; readonly keyId: number },
): Promise<boolean> {
  const identity = await authSdk(sdk).identities.fetch(params.identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === params.keyId)
  if (!identity || !k) throw new Error(`key ${params.keyId} is not on identity ${params.identityId}`)
  if (k.disabledAt !== undefined) return false
  if (!isForgeBrowserKey(k)) {
    throw new Error(`key ${params.keyId} isn't a key Forge made for a browser; refusing to disable it here`)
  }
  // Before anything is sent (QW3-028: wrong words surfaced as the SDK's own refusal).
  await assertMasterKeyOf(identity, params.identityId, params.masterWif, params.network)
  await withMasterSigner(params.masterWif, (signer) =>
    sendIdentityUpdate(sdk, params.identityId, () => authSdk(sdk).identities.update({ identity, disablePublicKeys: [params.keyId], signer })),
  )
  return true
}
