/**
 * Top up an identity's credits from the browser (QA wave bonsia, QW-012): a deposit address,
 * a watch for the payment, an asset lock, and one `IdentityTopUp`. It is the identity-creation
 * flow's funding half (`./create-identity.ts`), for an identity that already exists, and needs
 * nothing an ordinary Dash wallet (or a devnet faucet, which pays Core addresses only) cannot do:
 * send DASH to an address.
 *
 * The deposit key comes from the identity's recovery phrase, at DIP-13's identity-bound top-up
 * funding path `m/9'/<coin>'/5'/2'/<identity index>'/<top-up index>` (index 0 for identities made
 * here or by `dg`). So:
 * - a deposit is never stranded: the phrase re-derives the key, the flow resumes when the phrase
 *   is typed again, and any DIP-13 wallet holding the phrase can recover it;
 * - the phrase must be this identity's (its master key is checked against key 0 before anything
 *   is shown), so a deposit cannot end up under someone else's words;
 * - it never shares an address with the wallet's ordinary receiving addresses (BIP-44), so a
 *   top-up only ever locks what was sent for it.
 *
 * The journal keeps public facts only (the address, the signed lock transaction, the index), per
 * identity, and is cleared once Platform shows the lock used. Each finished top-up moves to the
 * next index, as DIP-13 asks.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import { idbDelete, idbGet, idbPut } from '../idb'
import { authSdk, isAbort } from '../sdk/facade'
import { evoSdkService } from '../sdk/service'
import { errorMessage } from '../utils'
import { broadcastTx, buildAssetLock, coreEndpoints, currentHeight, obtainLockProof, waitForDeposit, wifBytes, type CoreEndpoints } from './asset-lock'
import { assetLockUse, platformClh } from './create-identity'
import { deriveAt, deriveMasterKey, normalizeMnemonic } from './hd'
import { controlsKey } from './wif'

/** The least a top-up deposit may be (DASH × 1e8): the lock fee and the top-up's own fee come out of it. */
export const MIN_TOP_UP_DUFFS = 1_000_000

/** DIP-13 identity-bound top-up funding key: `m/9'/<coin>'/5'/2'/<identityIndex>'/<index>`. */
export function topUpKeyPath(network: Network, index: number, identityIndex = 0): string {
  return `m/9'/${network === 'mainnet' ? 5 : 1}'/5'/2'/${identityIndex}'/${index}`
}

/** An unfinished top-up: public facts only (no keys, no words). */
export interface TopUpJournal {
  readonly network: Network
  readonly identityId: string
  /** The DIP-13 top-up index this deposit uses. */
  readonly index: number
  readonly depositAddress: string
  readonly startedAt: number
  /** The Core tip when the address was first shown: the deposit watch starts there. */
  readonly startHeight?: number | null
  readonly lockTxid: string | null
  /** The signed asset-lock transaction, saved before it is broadcast (hex). */
  readonly lockRaw: string | null
  readonly lockedDuffs?: number | null
}

function journalKey(network: Network, identityId: string): string {
  return `top-up:${network}:${identityId}`
}

/** The next top-up index for an identity on this device (after the last finished one). */
function nextIndexKey(network: Network, identityId: string): string {
  return `top-up-next:${network}:${identityId}`
}

export function readTopUpJournal(network: Network, identityId: string): Promise<TopUpJournal | undefined> {
  return idbGet<TopUpJournal>('journal', journalKey(network, identityId))
}

/** Forget an unfinished top-up (the deposit, if any, stays at its address: the phrase recovers it). */
export function clearTopUpJournal(network: Network, identityId: string): Promise<void> {
  return idbDelete('journal', journalKey(network, identityId))
}

export type TopUpStage = 'waiting-deposit' | 'locking' | 'proving' | 'topping-up' | 'checking'

/**
 * Check that `mnemonic` is `identityId`'s recovery phrase (its master key controls key 0) and
 * return the deposit address this top-up uses: the unfinished one's, else the next index's.
 */
export async function prepareTopUp(
  sdk: EvoSDK,
  params: { readonly network: Network; readonly identityId: string; readonly mnemonic: string },
): Promise<{ address: string; index: number }> {
  const { network, identityId } = params
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const identity = await authSdk(sdk).identities.fetch(identityId)
  if (!identity) throw new Error(`Identity ${identityId} was not found on Platform. Try again in a moment.`)
  const master = await deriveMasterKey(mnemonic, network)
  const key0 = identity.publicKeys.find((k) => k.keyId === 0)
  if (!key0 || !controlsKey(key0, master.wif, network)) {
    throw new Error("These words are not this identity's recovery phrase (its master key does not match). Use the phrase you wrote down when the identity was made.")
  }
  const pending = await readTopUpJournal(network, identityId)
  const index = pending?.index ?? (await idbGet<number>('journal', nextIndexKey(network, identityId))) ?? 0
  const { address } = await deriveAt(mnemonic, topUpKeyPath(network, index), network)
  return { address, index }
}

/**
 * Run (or resume) a top-up: wait for the deposit at `prepareTopUp`'s address, lock it, prove the
 * lock and send the `IdentityTopUp`. Resolves with the identity's balance after it (credits). A
 * failure keeps the journal: running it again with the same phrase picks up where it stopped,
 * and never locks or credits one deposit twice (Platform refuses a used lock; the flow asks it
 * whether the lock was used before reporting a failure).
 */
export async function topUpIdentity(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly identityId: string
    readonly mnemonic: string
    readonly minDepositDuffs?: number
    readonly endpoints?: CoreEndpoints
    readonly signal?: AbortSignal
    readonly onStage?: (stage: TopUpStage, detail?: string) => void
    readonly onDeposit?: (duffs: number) => void
    /** Renews the connection's quorum keys before the top-up (see create-identity's L-06). */
    readonly freshen?: () => Promise<unknown>
  },
): Promise<{ balance: bigint | null }> {
  const { network, identityId } = params
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const ep = params.endpoints ?? coreEndpoints(network)
  const { address, index } = await prepareTopUp(sdk, { network, identityId, mnemonic })
  const lockKey = await deriveAt(mnemonic, topUpKeyPath(network, index), network)
  const existing = await readTopUpJournal(network, identityId)
  let journal: TopUpJournal = existing ?? { network, identityId, index, depositAddress: address, startedAt: Date.now(), lockTxid: null, lockRaw: null }
  const save = async (patch: Partial<TopUpJournal>): Promise<void> => {
    journal = { ...journal, ...patch }
    await idbPut('journal', journalKey(network, identityId), journal)
  }
  await save({})

  if (journal.lockTxid === null || journal.lockRaw === null) {
    if (existing === undefined) await save({ startHeight: await currentHeight(ep) })
    params.onStage?.('waiting-deposit')
    const utxos = await waitForDeposit(ep, lockKey.address, params.minDepositDuffs ?? MIN_TOP_UP_DUFFS, {
      signal: params.signal,
      onSeen: params.onDeposit,
      from: journal.startHeight ?? { startedAt: journal.startedAt },
    })
    params.onStage?.('locking')
    const priv = wifBytes(lockKey.wif)
    try {
      const lock = buildAssetLock(utxos, priv)
      await save({ lockTxid: lock.txid, lockRaw: bytesToHex(lock.raw), lockedDuffs: lock.lockedDuffs })
    } finally {
      priv.fill(0)
    }
  }
  const lockTxid = journal.lockTxid as string
  const lockRaw = hexToBytes(journal.lockRaw as string)
  // Idempotent: re-sending an accepted transaction is harmless.
  await broadcastTx(ep, bytesToHex(lockRaw), lockTxid)
  params.onStage?.('proving')
  const { AssetLockProof, OutPoint, PrivateKey } = await import('@dashevo/evo-sdk')
  const proof = await obtainLockProof(ep, { txid: lockTxid, raw: lockRaw }, () => platformClh(sdk), {
    signal: params.signal,
    onStatus: (s) => params.onStage?.('proving', s),
  })
  const assetLockProof =
    proof.type === 'instant'
      ? AssetLockProof.createInstantAssetLockProof(proof.islock, proof.raw, 0)
      : AssetLockProof.createChainAssetLockProof(proof.height, new OutPoint(proof.txid, 0))
  const outPoint = assetLockProof.outPoint?.toBytes()

  const finish = async (balance: bigint | null): Promise<{ balance: bigint | null }> => {
    await clearTopUpJournal(network, identityId)
    await idbPut('journal', nextIndexKey(network, identityId), journal.index + 1)
    return { balance }
  }
  // A resumed top-up whose lock Platform already used (the tab closed after it landed): done.
  if (existing !== undefined && outPoint !== undefined && (await assetLockUse(sdk, outPoint).catch(() => null))?.kind === 'fully') {
    return finish(await authSdk(sdk).identities.balance(identityId).catch(() => null) ?? null)
  }

  params.onStage?.('topping-up')
  const identity = await authSdk(sdk).identities.fetch(identityId)
  if (!identity) throw new Error(`Identity ${identityId} was not found on Platform. "Try again" resumes with the same deposit.`)
  const assetLockPrivateKey = PrivateKey.fromWIF(lockKey.wif)
  try {
    await (params.freshen ?? (() => evoSdkService.ensureFresh()))()
    params.signal?.throwIfAborted()
    const balance = await authSdk(sdk).identities.topUp({ identity, assetLockProof, assetLockPrivateKey })
    return await finish(balance)
  } catch (e) {
    if (isAbort(e) || outPoint === undefined) throw e
    // The answer may not have been checkable (a quorum rotation, a timeout): ask Platform
    // whether the lock was used before calling it a failure.
    params.onStage?.('checking')
    const use = await assetLockUse(sdk, outPoint).catch(() => null)
    if (use?.kind === 'fully') return finish(await authSdk(sdk).identities.balance(identityId).catch(() => null) ?? null)
    throw new Error(`The top-up did not go through (${errorMessage(e)}). Your deposit is locked and recorded on this device: "Try again" sends it again, and it is never credited twice.`)
  } finally {
    assetLockPrivateKey.free()
  }
}
