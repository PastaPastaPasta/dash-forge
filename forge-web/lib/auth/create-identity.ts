/**
 * Create a Platform identity in the browser (`ux-dx-spec.md` §2.2 tile 2).
 *
 * The flow, journaled in IndexedDB so a closed tab resumes rather than stranding the deposit:
 *   1. a fresh 12-word mnemonic; the user proves they wrote it down (three words);
 *   2. the deposit address (the mnemonic's BIP-44 asset-lock key) and QR; funds arrive from
 *      any wallet (or the faucet on dev networks) and are seen on a DAPI transaction feed
 *      that replays from the Core height recorded when the creation started;
 *   3. the asset lock is built, saved to the journal, broadcast, and proven (InstantSend or
 *      chain lock);
 *   4. this browser's limited key is generated and **stored in the vault first**, then one
 *      IdentityCreate registers the canonical key set (MASTER, HIGH, CRITICAL auth, CRITICAL
 *      transfer, MEDIUM encryption; DIP-13 from the mnemonic, so `dg` and the bridge open the
 *      same identity) plus that key (key 5: HIGH, bound to the dash-forge contract group,
 *      budget + expiry), so no second signature is needed.
 *
 * The journal keeps only public facts (the deposit address, the signed asset-lock transaction
 * and its txid, the identity id). A resumed flow re-derives every key from the mnemonic, which
 * the user types again. If the identity already exists on resume (created, but the tab closed
 * before the key was confirmed), the mnemonic's master key registers a fresh limited key. The
 * caller clears the journal only once the key is adopted.
 *
 * L-06: wasm-sdk's `identityCreate` broadcasts and then proof-checks the answer against the
 * connection's quorum keys without refreshing them first (the broadcast facade's calls refresh
 * them), so a quorum rotation fails a create that Platform accepted ("Quorum not found in
 * cache"). The connection is renewed right before the create (`freshen`); when the answer still
 * cannot be verified, the flow asks Platform what happened instead of reporting a failure:
 *   - the identity is there: it was created, so finish (check key 5; renew it only when the
 *     identity's key 5 is provably not the one this run stored);
 *   - it is not, and Platform has not used the whole asset lock: {@link IdentityNotCreatedError}.
 *     "Try again" sends the creation again with the same lock (the journal keeps it). A lock an
 *     earlier attempt partly used (Platform rejected it and kept a fee) says so;
 *   - anything else (a used lock without a visible identity, a read that fails) is reported as
 *     unconfirmed, never as "not created".
 * "Not created" is what Platform shows at the time of the check, not a proof that the creation
 * can never land.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import type { GroupTrust } from '../deployments'
import { idbDelete, idbGet, idbPut } from '../idb'
import { authSdk, isAbort, sleep } from '../sdk/facade'
import { evoSdkService } from '../sdk/service'
import { isStaleConnectionError } from '../sdk/unreachable'
import { assertWritesAllowed, serialized } from '../sdk/write'
import { errorMessage } from '../utils'
import {
  broadcastTx,
  buildAssetLock,
  coreEndpoints,
  currentHeight,
  depositHeld,
  obtainLockProof,
  waitForDeposit,
  wifBytes,
  type CoreEndpoints,
  type LockProof,
} from './asset-lock'
import { CANONICAL_KEYS, assetLockKeyPath, deriveAt, deriveMasterKey, identityKeyPath, normalizeMnemonic } from './hd'
import { assertGroupHolds } from './group-trust'
import { UnusableLimitedKeyError, controlsKey, defaultLimits, registerLimitedKey, verifyLimitedKey, type LimitedKey, type LimitedKeyRequest } from './limited-key'
import type { KeyLimits } from '../view/funds'

/** Minimum deposit (spec §2.2: 0.02 DASH; the asset-lock floor is 0.003). */
export const MIN_DEPOSIT_DUFFS = 2_000_000

/** A pending creation: public facts only (no keys, no mnemonic). */
export interface CreationJournal {
  readonly network: Network
  readonly depositAddress: string
  readonly identityId: string | null
  readonly lockTxid: string | null
  /** The signed asset-lock transaction, saved before it is broadcast (hex). */
  readonly lockRaw: string | null
  /** What the lock holds (duffs): the new identity's balance before Platform takes its fee. */
  readonly lockedDuffs?: number | null
  readonly startedAt: number
  /** The Core height when the creation started: the deposit watch replays from here. */
  readonly startHeight?: number | null
}

function journalKey(network: Network): string {
  return `create-identity:${network}`
}

export function readCreationJournal(network: Network): Promise<CreationJournal | undefined> {
  return idbGet<CreationJournal>('journal', journalKey(network))
}

export function clearCreationJournal(network: Network): Promise<void> {
  return idbDelete('journal', journalKey(network))
}

/** What an unfinished creation's deposit address holds (duffs), to warn before discarding. */
export async function depositBalance(network: Network, journal: CreationJournal, endpoints = coreEndpoints(network)): Promise<number> {
  return depositHeld(endpoints, journal.depositAddress, journal.startHeight ?? { startedAt: journal.startedAt })
}

/** The deposit address a mnemonic funds (its BIP-44 asset-lock key). */
export async function depositAddressOf(mnemonic: string, network: Network): Promise<string> {
  return (await deriveAt(mnemonic, assetLockKeyPath(network), network)).address
}

/** Platform's core chain-locked height (a chain-lock proof must be at or below it). */
export async function platformClh(sdk: EvoSDK): Promise<number | null> {
  const h = (await authSdk(sdk).system.status()).toJSON()?.chain?.coreChainLockedHeight
  return typeof h === 'number' ? h : null
}

export type CreateStage = 'waiting-deposit' | 'locking' | 'proving' | 'registering' | 'verifying'

/** The browser key's id on a created identity: right after the canonical five. */
export const BROWSER_KEY_ID = CANONICAL_KEYS.length

/** What Platform records for an asset lock it has used (rs-dpp `StoredAssetLockInfo`). */
export type LockUse =
  | { readonly kind: 'unused' }
  /** An earlier transition was rejected and Platform kept a fee: `remaining` credits are left (null when unreadable). */
  | { readonly kind: 'partly'; readonly remaining: bigint | null }
  | { readonly kind: 'fully' }

/**
 * The least an asset lock must hold for Platform to start processing an IdentityCreate with
 * {@link CANONICAL_KEYS} plus the browser key, in credits: rs-dpp
 * `calculate_min_required_fee_v1` with PV14's constants (`identity_create_base_cost` 2,000,000;
 * `required_asset_lock_duff_balance_for_processing_start_for_identity_create` 200,000 duffs;
 * `identity_key_in_creation_cost` 6,500,000 per key).
 */
export const CREATE_MIN_LOCK_CREDITS = 2_000_000n + 200_000n * 1_000n + BigInt(CANONICAL_KEYS.length + 1) * 6_500_000n

/**
 * An IdentityCreate whose answer could not be verified, and Platform shows neither the identity
 * nor a fully used asset lock. `retryable`: enough of the lock is left for "Try again" to send
 * the creation again with it (the journal keeps it).
 */
export class IdentityNotCreatedError extends Error {
  readonly retryable: boolean
  constructor(identityId: string, cause: unknown, lock: LockUse) {
    const remaining = lock.kind === 'partly' ? lock.remaining : null
    const retryable = remaining === null || remaining >= CREATE_MIN_LOCK_CREDITS
    const why = `Platform shows no record of identity ${identityId} yet (${errorMessage(cause)}).`
    const partly =
      lock.kind !== 'partly'
        ? ''
        : ` An attempt with this deposit was rejected and Platform kept a fee${remaining === null ? '' : `; ${creditsText(remaining)} remains`}.`
    const next = !retryable
      ? ` That is less than the ${creditsText(CREATE_MIN_LOCK_CREDITS)} Platform needs to process a creation, so trying again with this deposit cannot succeed.`
      : lock.kind === 'partly'
        ? ' "Try again with the same deposit" sends the creation again; if Platform rejects it for the same reason, it keeps another fee.'
        : ' Your deposit is still locked for it: "Try again with the same deposit" sends the creation again with it.'
    super(why + partly + next)
    this.name = 'IdentityNotCreatedError'
    this.retryable = retryable
  }
}

function creditsText(credits: bigint): string {
  return `${(Number(credits) / 1e11).toFixed(5)} DASH`
}

/**
 * Whether an IdentityCreate error leaves the outcome open: Platform may have executed the
 * transition although the SDK could not verify or wait for the answer. Stale quorum keys and
 * proof failures (L-06), transport errors and timeouts, no usable node, and "already used" /
 * "already exists" (an earlier attempt landed). A consensus refusal (bad signature, too little
 * in the lock) is definite and reported as it is.
 */
export function createOutcomeUnknown(e: unknown): boolean {
  return isStaleConnectionError(e) || PROOF_OR_DONE.test(errorMessage(e, '')) || /dapi client error|deadline exceeded|timeout|timed out/i.test(errorMessage(e, ''))
}

/**
 * Errors that came with an answer from Platform (a proof it could not check, or "already
 * done"): the block is committed, so the identity is readable at once if it landed. Everything
 * else (transport errors, timeouts, no usable node) gets the longer probe.
 */
const PROOF_OR_DONE = /quorum not found|proof verification|context provider|invalid quorum|already completely used|already exists/i

/** Reads of the identity after an error that came with Platform's answer ({@link PROOF_OR_DONE}). */
const LANDED_CHECKS_ANSWERED = 4
/** After a transport error or timeout: the transition may still be in a block being made. */
const LANDED_CHECKS_UNANSWERED = 12
/** Between those reads. */
const LANDED_CHECK_MS = 2_000

/** Where Platform records the asset-lock outpoints it has used (rs-drive `RootTree::SpentAssetLockTransactions`). */
const SPENT_ASSET_LOCKS = Uint8Array.of(72)

/**
 * Read one bincode 2 varint (`standard().with_big_endian()`): a byte up to 250, else a marker
 * (251/252/253) and a 2/4/8-byte big-endian integer. Null when the bytes run out.
 */
function varint(b: Uint8Array, at: number): [bigint, number] | null {
  const first = b[at]
  if (first === undefined) return null
  if (first <= 250) return [BigInt(first), at + 1]
  const width = first === 251 ? 2 : first === 252 ? 4 : first === 253 ? 8 : 0
  if (width === 0 || at + 1 + width > b.length) return null
  let v = 0n
  for (let i = 1; i <= width; i++) v = (v << 8n) | BigInt(b[at + i] as number)
  return [v, at + 1 + width]
}

/**
 * The credits left in a partly used asset lock: rs-dpp `AssetLockValue::V0` (variant 0, then
 * `initial_credit_value`, `tx_out_script`, `remaining_credit_value`, `used_tags`), serialized
 * unversioned with bincode `standard().with_big_endian()`. Null for anything else.
 */
export function remainingLockCredits(value: Uint8Array): bigint | null {
  const variant = varint(value, 0)
  if (variant === null || variant[0] !== 0n) return null
  const initial = varint(value, variant[1])
  const scriptLen = initial && varint(value, initial[1])
  if (!scriptLen) return null
  const remaining = varint(value, scriptLen[1] + Number(scriptLen[0]))
  return remaining === null ? null : remaining[0]
}

/**
 * What Platform records for the asset lock at `outPoint` (its 36 bytes: txid, then vout LE): no
 * element, never used; an empty item, fully used; any other item, partly used (rs-drive
 * `fetch_asset_lock_outpoint_info`). A proven read, like every other. Null when the answer is
 * not one of those shapes.
 */
export async function assetLockUse(sdk: EvoSDK, outPoint: Uint8Array): Promise<LockUse | null> {
  const elements = await authSdk(sdk).system.pathElements([SPENT_ASSET_LOCKS], [outPoint])
  if (elements.length !== 1) return null
  const [element] = elements as [(typeof elements)[number]]
  if (element.elementType === undefined) return { kind: 'unused' }
  if (element.elementType !== 'item') return null
  const value = element.valueBytes
  if (value === undefined || value.length === 0) return { kind: 'fully' }
  return { kind: 'partly', remaining: remainingLockCredits(value) }
}

type CreateOutcome = { readonly kind: 'landed' } | { readonly kind: 'not-landed'; readonly lock: LockUse } | { readonly kind: 'unknown' }

/**
 * After an IdentityCreate whose outcome is unknown: did it land? Reads the identity up to
 * `checks` times, then asks what Platform records for the lock. `unknown` when neither answers
 * (the lock is fully used but the identity is not visible yet, or Platform cannot be read).
 */
async function probeCreate(
  sdk: EvoSDK,
  identityId: string,
  outPoint: Uint8Array,
  opts: { readonly checks: number; readonly delayMs: number; readonly signal?: AbortSignal },
): Promise<CreateOutcome> {
  let lastReadFailed = false
  for (let i = 0; i < opts.checks; i++) {
    if (i > 0) await sleep(opts.delayMs, opts.signal)
    try {
      if ((await authSdk(sdk).identities.fetch(identityId)) !== undefined) return { kind: 'landed' }
      lastReadFailed = false
    } catch (e) {
      if (isAbort(e)) throw e
      lastReadFailed = true
    }
  }
  if (lastReadFailed) return { kind: 'unknown' }
  const lock = await assetLockUse(sdk, outPoint).catch(() => null)
  // A fully used lock without a visible identity, or no clear answer: nothing to conclude yet.
  return lock === null || lock.kind === 'fully' ? { kind: 'unknown' } : { kind: 'not-landed', lock }
}

/**
 * Whether key `keyId` on the identity is provably not controlled by `wif` (another attempt's
 * key, or none): only then may the master key replace it. A read that fails rethrows, so the
 * user retries the check rather than paying for a renewal.
 */
async function keyIsNotOurs(sdk: EvoSDK, identityId: string, keyId: number, wif: string, network: Network): Promise<boolean> {
  const identity = await authSdk(sdk).identities.fetch(identityId)
  if (identity === undefined) return false
  const k = identity.publicKeys.find((x) => x.keyId === keyId)
  // Not shown: the IdentityCreate always carries key 5, so only a node behind shows none.
  // The check that follows retries it; a renewal (paid, disabling it) is not the answer.
  return k !== undefined && !controlsKey(k, wif, network)
}

/**
 * The key this browser stores for an identity, and any other keys it holds for it (wallet
 * grants): a renewal disables all of them in the same update, so none stays live unheld.
 */
export interface HeldBrowserKey {
  readonly keyId: number
  readonly wif: string
  readonly alsoHeld?: readonly { readonly keyId: number; readonly wif: string }[]
}

/** The identity exists, but its browser key could not be checked: "Try again" checks it again. */
function keyUncheckedError(identityId: string, cause: unknown): Error {
  return new Error(
    `Identity ${identityId} was created, but this browser's key could not be checked (${errorMessage(cause)}). Choose "Try again". You won't pay twice.`,
  )
}

/**
 * Run (or resume) the creation from the funded deposit onward. Resolves with the new identity
 * id and this browser's limited key. `persistKey` is called with the key before it is
 * registered on chain (store it in the vault there), so a tab closed mid-create can never
 * leave a registered key that nobody holds.
 */
export async function createIdentityFromMnemonic(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly mnemonic: string
    readonly group: string
    /** The group's pinned trust root: checked on chain before a key binds to it (`./group-trust`). */
    readonly trust: GroupTrust
    /**
     * Store the key durably. `staged`: it is about to replace a key on chain (D-016): keep it
     * beside the current record until a second call (without `staged`) commits it.
     */
    readonly persistKey: (identityId: string, key: { keyId: number; wif: string }, options?: { readonly staged?: boolean }) => Promise<void>
    readonly minDepositDuffs?: number
    readonly limits?: LimitedKeyRequest
    readonly endpoints?: CoreEndpoints
    readonly signal?: AbortSignal
    readonly onStage?: (stage: CreateStage, detail?: string) => void
    readonly onDeposit?: (duffs: number) => void
    /**
     * Told what the identity paid, for the spend ledger: the IdentityCreate (its fee comes out
     * of the asset lock, so "before" is the lock's credit value) or, resuming a creation whose
     * key was lost, the key registration.
     */
    readonly onCharge?: (identityId: string, charge: { kind: 'identity:create' | 'key:renew'; keyId: number | null; balanceBefore: bigint | null }) => void
    /**
     * Renews the connection's quorum keys before the IdentityCreate (L-06, see the module
     * comment), when older than `maxAgeMs`. Default: the SDK service's `ensureFresh`, which
     * renews the service's connection: `sdk` must then be the service's handle
     * (`connectPlatform` / `ensureSdk`), which follows the renewal.
     */
    readonly freshen?: (maxAgeMs?: number) => Promise<unknown>
    /** Between reads of an identity whose create reported an error (default {@link LANDED_CHECK_MS}). */
    readonly landedCheckMs?: number
    /**
     * The browser key an earlier run of this creation stored (`persistKey`), if the caller can
     * still read it. When the identity already exists and holds that key, the run checks it and
     * finishes instead of paying for a renewal.
     */
    readonly heldKey?: (identityId: string) => Promise<HeldBrowserKey | null>
  },
): Promise<{ identityId: string; key: LimitedKey }> {
  const { network, group } = params
  // Before a deposit address is shown or a Core lock is spent: nothing is created while the
  // devnet is moving (the identity would be wiped with it).
  assertWritesAllowed()
  await assertGroupHolds(sdk, group, params.trust)
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const ep = params.endpoints ?? coreEndpoints(network)
  const { AssetLockProof, OutPoint, Identity, IdentityPublicKey, IdentitySigner, PrivateKey, ContractBounds } = await import('@dashevo/evo-sdk')

  const lockKey = await deriveAt(mnemonic, assetLockKeyPath(network), network)
  const existing = await readCreationJournal(network)
  let journal: CreationJournal = existing ?? {
    network,
    depositAddress: lockKey.address,
    identityId: null,
    lockTxid: null,
    lockRaw: null,
    startedAt: Date.now(),
  }
  if (journal.depositAddress !== lockKey.address) throw new Error('these words do not match the deposit in progress')
  const save = async (patch: Partial<CreationJournal>): Promise<void> => {
    journal = { ...journal, ...patch }
    await idbPut('journal', journalKey(network), journal)
  }
  await save({})

  // 1-3: deposit → asset lock (saved before broadcast) → proof.
  if (journal.lockTxid === null || journal.lockRaw === null) {
    // A journal this call created records the Core tip (the flow shows the address first, so
    // the watch starts a few blocks earlier). A resumed journal without one is left alone: its
    // watch rewinds past `startedAt` instead of skipping a deposit mined meanwhile.
    if (existing === undefined) await save({ startHeight: await currentHeight(ep) })
    params.onStage?.('waiting-deposit')
    const utxos = await waitForDeposit(ep, lockKey.address, params.minDepositDuffs ?? MIN_DEPOSIT_DUFFS, {
      signal: params.signal,
      onSeen: params.onDeposit,
      from: journal.startHeight ?? { startedAt: journal.startedAt },
    })
    params.onStage?.('locking')
    const priv = wifBytes(lockKey.wif)
    const lock = buildAssetLock(utxos, priv)
    priv.fill(0)
    await save({ lockTxid: lock.txid, lockRaw: bytesToHex(lock.raw), lockedDuffs: lock.lockedDuffs })
  }
  const lockTxid = journal.lockTxid as string
  const lockRaw = hexToBytes(journal.lockRaw as string)
  // Idempotent: re-sending an accepted transaction is harmless (DAPI, else the explorer).
  await broadcastTx(ep, bytesToHex(lockRaw), lockTxid)
  params.onStage?.('proving')
  const proof: LockProof = await obtainLockProof(ep, { txid: lockTxid, raw: lockRaw }, () => platformClh(sdk), {
    signal: params.signal,
    onStatus: (s) => params.onStage?.('proving', s),
  })
  const assetLockProof =
    proof.type === 'instant'
      ? AssetLockProof.createInstantAssetLockProof(proof.islock, proof.raw, 0)
      : AssetLockProof.createChainAssetLockProof(proof.height, new OutPoint(proof.txid, 0))
  const identityId = assetLockProof.createIdentityId().toBase58()
  await save({ identityId })

  const limits = params.limits ?? defaultLimits()
  const freshen = params.freshen ?? ((maxAgeMs?: number) => evoSdkService.ensureFresh(maxAgeMs))
  /** The identity exists, but this browser holds none of its keys: the master key renews key 5. */
  const renewBrowserKey = async (
    balanceBefore: bigint | null,
    disableHeld: readonly { readonly keyId: number; readonly wif: string }[] = [],
  ): Promise<{ identityId: string; key: LimitedKey }> => {
    params.onStage?.('registering', 'The identity exists; registering a key for this browser…')
    const master = await deriveMasterKey(mnemonic, network)
    // The earlier run's key 5 may be live (its vault copy is locked or gone): disable it in
    // the same update, so no key nobody holds stays live.
    // The group was checked at the start of this run (assertGroupHolds above).
    // As this identity's only writer, like every other key update (and so the SDK connection
    // is not swapped under the update's nonce). The new key is stored before the update that
    // registers it and disables the old one (D-016): a browser that cannot keep it changes
    // nothing on chain.
    assertWritesAllowed()
    const key = await serialized(identityId, () =>
      registerLimitedKey(sdk, {
        network,
        identityId,
        masterWif: master.wif,
        group,
        request: limits,
        replaceKeyId: BROWSER_KEY_ID,
        groupChecked: true,
        persist: (k) => params.persistKey(identityId, k, { staged: true }),
        ...(disableHeld.length ? { disableHeld } : {}),
      }),
    )
    params.onCharge?.(identityId, { kind: 'key:renew', keyId: key.keyId, balanceBefore })
    await params.persistKey(identityId, key)
    return { identityId, key }
  }
  // A read that fails is not "no identity": creating again would spend nothing (the lock is
  // already used) but could lead to a paid key renewal, so the user retries the read instead.
  const existingBalance = await authSdk(sdk)
    .identities.balance(identityId)
    .catch((e: unknown) => {
      throw new Error(`Could not check whether identity ${identityId} already exists (${errorMessage(e)}). Try again in a moment.`)
    })
  if (existingBalance !== undefined) {
    // Created by an earlier run. Its browser key, when this browser still holds it and the
    // identity carries it, is checked and kept; only a key that is gone is renewed (paid).
    const held = (await params.heldKey?.(identityId).catch(() => null)) ?? null
    // What a renewal here disables beside the old key 5: every key this browser holds (each
    // only if its stored private key controls it).
    const disable = held === null ? [] : [{ keyId: held.keyId, wif: held.wif }, ...(held.alsoHeld ?? [])]
    if (held === null || (await keyIsNotOurs(sdk, identityId, held.keyId, held.wif, network))) return renewBrowserKey(existingBalance, disable)
    params.onStage?.('verifying')
    let verified: KeyLimits
    try {
      verified = await verifyLimitedKey(sdk, identityId, held.keyId, group, network, held.wif)
    } catch (e) {
      if (isAbort(e)) throw e
      // Ours, but Platform shows it cannot be used (expired, disabled, used up, or not a Forge
      // browser key): renewing is the only way on. A read that failed is retried instead.
      if (e instanceof UnusableLimitedKeyError) return renewBrowserKey(existingBalance, disable)
      throw keyUncheckedError(identityId, e)
    }
    return { identityId, key: { keyId: held.keyId, wif: held.wif, limits: verified } }
  }

  // 4: the browser key goes to the vault first, then IdentityCreate registers it.
  params.onStage?.('registering')
  const browserKey = PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), network === 'mainnet' ? 'mainnet' : 'testnet')
  const wif = browserKey.toWIF()
  await params.persistKey(identityId, { keyId: BROWSER_KEY_ID, wif })
  const identity = new Identity(identityId)
  const signer = new IdentitySigner()
  const assetLockPrivateKey = PrivateKey.fromWIF(lockKey.wif)
  // The create reported an error, but the identity turned out to be there.
  let landedAfterError = false
  try {
    for (const k of CANONICAL_KEYS) {
      const d = await deriveAt(mnemonic, identityKeyPath(network, k.id), network)
      identity.addPublicKey(
        new IdentityPublicKey({
          keyId: k.id,
          purpose: k.purpose.toLowerCase() as 'authentication',
          securityLevel: k.level.toLowerCase() as 'high',
          keyType: 'ecdsa_secp256k1',
          isReadOnly: false,
          data: hexToBytes(d.publicKeyHex),
        }),
      )
      signer.addKeyFromWif(d.wif)
    }
    identity.addPublicKey(
      new IdentityPublicKey({
        keyId: BROWSER_KEY_ID,
        purpose: 'authentication',
        securityLevel: 'high',
        keyType: 'ecdsa_secp256k1',
        isReadOnly: false,
        data: browserKey.getPublicKey().toBytes(),
        contractBounds: ContractBounds.ContractGroup(group),
        totalBudget: limits.budgetCredits,
        expiresAt: BigInt(limits.expiresAt),
      }),
    )
    signer.addKey(browserKey)
    await freshen()
    // The last point before the broadcast.
    params.signal?.throwIfAborted()
    try {
      await authSdk(sdk).identities.create({ identity, assetLockProof, assetLockPrivateKey, signer })
    } catch (e) {
      const outPoint = assetLockProof.outPoint?.toBytes()
      if (isAbort(e) || !createOutcomeUnknown(e) || outPoint === undefined) throw e
      // The answer could not be verified: ask Platform whether the identity is there.
      params.onStage?.('registering', 'Checking whether Platform recorded your identity…')
      // Stale keys would fail the reads too: renew them first.
      if (isStaleConnectionError(e)) await freshen(0)
      // "No available addresses" is a transport failure: it gets the long probe.
      const answered = PROOF_OR_DONE.test(errorMessage(e, ''))
      const outcome = await probeCreate(sdk, identityId, outPoint, {
        checks: answered ? LANDED_CHECKS_ANSWERED : LANDED_CHECKS_UNANSWERED,
        delayMs: params.landedCheckMs ?? LANDED_CHECK_MS,
        signal: params.signal,
      })
      if (outcome.kind === 'not-landed') throw new IdentityNotCreatedError(identityId, e, outcome.lock)
      if (outcome.kind === 'unknown') throw new Error(`Could not confirm whether identity ${identityId} was created (${errorMessage(e)}).`)
      landedAfterError = true
    }
    // 1 duff = 1000 credits (rs-dpp `CREDITS_PER_DUFF`); a journal from an older build lacks it.
    const lockCredits = typeof journal.lockedDuffs === 'number' ? BigInt(journal.lockedDuffs) * 1000n : null
    params.onCharge?.(identityId, { kind: 'identity:create', keyId: null, balanceBefore: lockCredits })
  } finally {
    signer.free()
    assetLockPrivateKey.free()
    browserKey.free()
  }

  params.onStage?.('verifying')
  try {
    const verified = await verifyLimitedKey(sdk, identityId, BROWSER_KEY_ID, group, network, wif, limits)
    return { identityId, key: { keyId: BROWSER_KEY_ID, wif, limits: verified } }
  } catch (e) {
    // The identity found after an unverified create may be an earlier attempt's, with that
    // attempt's key 5 (this one was refused as a duplicate): the master key renews it. Only
    // then: a key 5 this run stored, or a read that fails, is reported and "Try again" checks
    // it again (the `heldKey` path above), never a renewal.
    if (!landedAfterError || isAbort(e)) throw e
    const notOurs = await keyIsNotOurs(sdk, identityId, BROWSER_KEY_ID, wif, network).catch(() => false)
    if (!notOurs) throw keyUncheckedError(identityId, e)
    return renewBrowserKey((await authSdk(sdk).identities.balance(identityId).catch(() => undefined)) ?? null)
  }
}
