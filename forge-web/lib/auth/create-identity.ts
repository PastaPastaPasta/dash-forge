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
 *   - the identity is there: it was created, so finish (check key 5, else renew it as above);
 *   - it is not, and the asset lock is still unspent: {@link IdentityNotCreatedError}. "Try
 *     again" sends the creation again with the same lock (the journal keeps it): no new payment.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import type { GroupTrust } from '../deployments'
import { idbDelete, idbGet, idbPut } from '../idb'
import { authSdk, isAbort, sleep } from '../sdk/facade'
import { evoSdkService, isStaleConnectionError } from '../sdk/service'
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
import { defaultLimits, registerLimitedKey, verifyLimitedKey, type LimitedKey, type LimitedKeyRequest } from './limited-key'

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

async function platformClh(sdk: EvoSDK): Promise<number | null> {
  const h = (await authSdk(sdk).system.status()).toJSON()?.chain?.coreChainLockedHeight
  return typeof h === 'number' ? h : null
}

export type CreateStage = 'waiting-deposit' | 'locking' | 'proving' | 'registering' | 'verifying'

/** The browser key's id on a created identity: right after the canonical five. */
export const BROWSER_KEY_ID = CANONICAL_KEYS.length

/**
 * An IdentityCreate whose answer could not be verified, and Platform shows neither the identity
 * nor a used asset lock: it was not created. The journal still holds the lock, so creating again
 * reuses it; nothing new has to be paid.
 */
export class IdentityNotCreatedError extends Error {
  constructor(identityId: string, cause: unknown) {
    super(
      `Platform did not record identity ${identityId} (${errorMessage(cause)}). Your deposit is still locked for it: "Try again" sends the creation again with the same deposit, with nothing new to pay.`,
    )
    this.name = 'IdentityNotCreatedError'
  }
}

/**
 * Whether an IdentityCreate error leaves the outcome open: Platform may have executed the
 * transition although the SDK could not verify or wait for the answer. Stale quorum keys and
 * proof failures (L-06), transport errors and timeouts, no usable node, and "already used" /
 * "already exists" (an earlier attempt landed). A consensus refusal (bad signature, too little
 * in the lock) is definite and reported as it is.
 */
export function createOutcomeUnknown(e: unknown): boolean {
  return (
    isStaleConnectionError(e) ||
    /proof verification|context provider|invalid quorum|dapi client error|deadline exceeded|timeout|timed out|already completely used|already exists/i.test(errorMessage(e, ''))
  )
}

/** Reads of an identity whose create reported an error (a node may be a block behind). */
const LANDED_CHECKS = 8
/** Between those reads. */
const LANDED_CHECK_MS = 2_000

/** Where Platform records the asset-lock outpoints it has used (rs-drive `RootTree::SpentAssetLockTransactions`). */
const SPENT_ASSET_LOCKS = Uint8Array.of(72)

/**
 * Whether Platform has used the asset lock at `outPoint` (its 36 bytes: txid, then vout LE). No
 * element: never used. An empty item: fully used. Any other item: partly used, value left
 * (rs-drive `fetch_asset_lock_outpoint_info`). A proven read, like every other.
 */
async function assetLockUsed(sdk: EvoSDK, outPoint: Uint8Array): Promise<'unused' | 'partly' | 'fully'> {
  const [element] = await authSdk(sdk).system.pathElements([SPENT_ASSET_LOCKS], [outPoint])
  if (element?.elementType === undefined) return 'unused'
  return element.valueBytes === undefined || element.valueBytes.length === 0 ? 'fully' : 'partly'
}

/**
 * After an IdentityCreate whose outcome is unknown: did it land? Reads the identity a bounded
 * number of times, then asks whether the lock is still unused. `unknown` when neither answers
 * (the lock is used but the identity is not visible yet, or Platform cannot be read).
 */
async function probeCreate(
  sdk: EvoSDK,
  identityId: string,
  outPoint: Uint8Array,
  delayMs: number,
  signal?: AbortSignal,
): Promise<'landed' | 'not-landed' | 'unknown'> {
  let lastReadFailed = false
  for (let i = 0; i < LANDED_CHECKS; i++) {
    if (i > 0) await sleep(delayMs, signal)
    try {
      if ((await authSdk(sdk).identities.fetch(identityId)) !== undefined) return 'landed'
      lastReadFailed = false
    } catch (e) {
      if (isAbort(e)) throw e
      lastReadFailed = true
    }
  }
  if (lastReadFailed) return 'unknown'
  const lock = await assetLockUsed(sdk, outPoint).catch(() => null)
  // Fully used without a visible identity, or unreadable: nothing to conclude yet.
  return lock === 'fully' || lock === null ? 'unknown' : 'not-landed'
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
    readonly persistKey: (identityId: string, key: { keyId: number; wif: string }) => Promise<void>
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
     * comment). Default: the SDK service's `ensureFresh`.
     */
    readonly freshen?: () => Promise<unknown>
    /** Between reads of an identity whose create reported an error (default {@link LANDED_CHECK_MS}). */
    readonly landedCheckMs?: number
  },
): Promise<{ identityId: string; key: LimitedKey }> {
  const { network, group } = params
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
  const readBalance = (): Promise<bigint | undefined> => authSdk(sdk).identities.balance(identityId).catch(() => undefined)
  /** The identity exists, but this browser holds none of its keys: the master key renews key 5. */
  const renewBrowserKey = async (balanceBefore: bigint | null): Promise<{ identityId: string; key: LimitedKey }> => {
    params.onStage?.('registering', 'The identity exists; registering a key for this browser…')
    const master = await deriveMasterKey(mnemonic, network)
    // The earlier run's key 5 may be live (its vault copy is locked or gone): disable it in
    // the same update, so no key nobody holds stays live.
    // The group was checked at the start of this run (assertGroupHolds above).
    const key = await registerLimitedKey(sdk, { network, identityId, masterWif: master.wif, group, request: limits, replaceKeyId: BROWSER_KEY_ID, groupChecked: true })
    params.onCharge?.(identityId, { kind: 'key:renew', keyId: key.keyId, balanceBefore })
    await params.persistKey(identityId, key)
    return { identityId, key }
  }
  const existingBalance = await readBalance()
  // Created by an earlier run whose browser key was lost.
  if (existingBalance !== undefined) return renewBrowserKey(existingBalance)

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
    await (params.freshen ? params.freshen() : evoSdkService.ensureFresh())
    try {
      await authSdk(sdk).identities.create({ identity, assetLockProof, assetLockPrivateKey, signer })
    } catch (e) {
      const outPoint = assetLockProof.outPoint?.toBytes()
      if (isAbort(e) || !createOutcomeUnknown(e) || outPoint === undefined) throw e
      // The answer could not be verified: ask Platform whether the identity is there.
      params.onStage?.('registering', 'Checking whether Platform recorded your identity…')
      const outcome = await probeCreate(sdk, identityId, outPoint, params.landedCheckMs ?? LANDED_CHECK_MS, params.signal)
      if (outcome === 'not-landed') throw new IdentityNotCreatedError(identityId, e)
      if (outcome === 'unknown') {
        throw new Error(
          `Could not confirm whether identity ${identityId} was created (${errorMessage(e)}). "Try again" checks first and reuses your deposit, so nothing is paid twice.`,
        )
      }
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
    // attempt's key 5 (this one was refused as a duplicate): the master key renews it.
    if (!landedAfterError || isAbort(e)) throw e
    return renewBrowserKey((await readBalance()) ?? null)
  }
}
