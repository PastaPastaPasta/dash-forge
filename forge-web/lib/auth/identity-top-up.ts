/**
 * Top up an identity's credits from the browser (QA wave bonsia, QW-012): a deposit address,
 * a watch for the payment, an asset lock, and one `IdentityTopUp`. It is the identity-creation
 * flow's funding half (`./create-identity.ts`), for an identity that already exists, and needs
 * nothing an ordinary Dash wallet (or a devnet faucet, which pays Core addresses only) cannot do:
 * send DASH to an address.
 *
 * The deposit key comes from the identity's recovery phrase, at DIP-13's identity-bound top-up
 * funding path (`topUpKeyPath`), so:
 * - the phrase must be this identity's (its master key is checked against key 0 before any
 *   address is shown), so a deposit cannot end up under someone else's words;
 * - it never shares an address with the wallet's ordinary receiving addresses (BIP-44), so a
 *   top-up only ever locks what was sent for it;
 * - a deposit is never stranded: the journal (the address, and the Core height the watch starts
 *   from) is saved before the address is shown, typing the phrase again resumes it, and a top-up
 *   moves on to the next index only once its address is seen empty. Anything paid to an address
 *   after its lock was built (a second payment) is swept by the next top-up, which reuses that
 *   address and watches from the same height.
 *
 * The journal keeps public facts only. One run per identity at a time (a Web Lock), so two tabs
 * never build two conflicting locks from one deposit. Platform refuses a used lock, and the flow
 * asks Platform whether the lock was used before sending it (a resumed run) and before calling a
 * failure a failure, so one deposit is never credited twice.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import { idbDelete, idbGet, idbPut } from '../idb'
import { authSdk, isAbort } from '../sdk/facade'
import { evoSdkService } from '../sdk/service'
import { errorMessage } from '../utils'
import { broadcastTx, buildAssetLock, coreEndpoints, currentHeight, depositHeld, obtainLockProof, waitForDeposit, wifBytes, type CoreEndpoints } from './asset-lock'
import { assetLockUse, platformClh } from './create-identity'
import { deriveAt, deriveMasterKey, normalizeMnemonic, topUpKeyPath } from './hd'
import { controlsKey } from './wif'

export { topUpKeyPath }

/** The least a top-up deposit may be (DASH × 1e8): the lock fee and the top-up's own fee come out of it. */
export const MIN_TOP_UP_DUFFS = 1_000_000

/** An unfinished top-up: public facts only (no keys, no words). */
export interface TopUpJournal {
  readonly network: Network
  readonly identityId: string
  /** The DIP-13 top-up index this deposit uses. */
  readonly index: number
  readonly depositAddress: string
  readonly startedAt: number
  /** The Core height the deposit watch starts from (recorded before the address was shown). */
  readonly startHeight?: number | null
  readonly lockTxid: string | null
  /** The signed asset-lock transaction, saved before it is broadcast (hex). */
  readonly lockRaw: string | null
  readonly lockedDuffs?: number | null
}

/** Where the next top-up starts: its index, and (reusing an address) the height to watch from. */
interface NextTopUp {
  readonly index: number
  readonly fromHeight?: number | null
  readonly fromTime?: number
}

function journalKey(network: Network, identityId: string): string {
  return `top-up:${network}:${identityId}`
}

function nextKey(network: Network, identityId: string): string {
  return `top-up-next:${network}:${identityId}`
}

export function readTopUpJournal(network: Network, identityId: string): Promise<TopUpJournal | undefined> {
  return idbGet<TopUpJournal>('journal', journalKey(network, identityId))
}

/**
 * Give up an unfinished top-up that cannot finish (its lock was never mined, or Platform keeps
 * refusing it). The next top-up reuses the same address and watches from the same height, so a
 * deposit still unspent there is swept into it, not stranded.
 */
export async function discardTopUp(network: Network, identityId: string): Promise<void> {
  const j = await readTopUpJournal(network, identityId)
  if (j === undefined) return
  await idbPut<NextTopUp>('journal', nextKey(network, identityId), { index: j.index, fromHeight: j.startHeight ?? null, fromTime: j.startedAt })
  await idbDelete('journal', journalKey(network, identityId))
}

export type TopUpStage = 'waiting-deposit' | 'locking' | 'proving' | 'topping-up' | 'checking'

/** One top-up run per identity across tabs; a second one is told, never queued behind a deposit watch. */
async function exclusive<T>(network: Network, identityId: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks === undefined) return run()
  return locks.request(`forge:top-up:${network}:${identityId}`, { ifAvailable: true }, async (held) => {
    if (held === null) throw new Error('A top-up of this identity is already running in another tab or window. Finish it there.')
    return run()
  })
}

/**
 * Run (or resume) a top-up: check the phrase, record the journal and show the address
 * (`onAddress`), wait for the deposit, lock it, prove the lock and send the `IdentityTopUp`.
 * Resolves with the identity's balance after it (credits; null when it could not be read). A
 * failure keeps the journal: running it again with the same phrase picks up where it stopped.
 */
export async function topUpIdentity(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly identityId: string
    readonly mnemonic: string
    /** The deposit address, once the journal holds it; `locked`: the deposit is already locked (pay nothing more). */
    readonly onAddress?: (address: string, locked: boolean) => void
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
  return exclusive(network, identityId, () => runTopUp(sdk, params))
}

async function runTopUp(
  sdk: EvoSDK,
  params: Parameters<typeof topUpIdentity>[1],
): Promise<{ balance: bigint | null }> {
  const { network, identityId } = params
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const ep = params.endpoints ?? coreEndpoints(network)
  const ids = authSdk(sdk).identities

  // 1. The words are this identity's: its master key controls key 0.
  const identity = await ids.fetch(identityId)
  if (!identity) throw new Error(`Identity ${identityId} was not found on Platform. Try again in a moment.`)
  const master = await deriveMasterKey(mnemonic, network)
  const key0 = identity.publicKeys.find((k) => k.keyId === 0)
  if (!key0 || !controlsKey(key0, master.wif, network)) {
    throw new Error("These words are not this identity's recovery phrase (its master key does not match). Use the phrase you wrote down when the identity was made.")
  }

  // 2. The journal, saved (with the watch's start) before the address is shown.
  const existing = await readTopUpJournal(network, identityId)
  const next = existing === undefined ? await idbGet<NextTopUp>('journal', nextKey(network, identityId)) : undefined
  const index = existing?.index ?? next?.index ?? 0
  const lockKey = await deriveAt(mnemonic, topUpKeyPath(network, index), network)
  if (existing !== undefined && existing.depositAddress !== lockKey.address) {
    throw new Error('The unfinished top-up on this device does not match these words. Use the phrase it was started with.')
  }
  let journal: TopUpJournal = existing ?? {
    network,
    identityId,
    index,
    depositAddress: lockKey.address,
    // Reusing an address (its earlier deposit was not all locked): watch from where it started.
    startedAt: next?.fromTime ?? Date.now(),
    startHeight: next?.fromHeight ?? (await currentHeight(ep)),
    lockTxid: null,
    lockRaw: null,
  }
  const save = async (patch: Partial<TopUpJournal>): Promise<void> => {
    journal = { ...journal, ...patch }
    await idbPut('journal', journalKey(network, identityId), journal)
  }
  await save({})
  params.onAddress?.(journal.depositAddress, journal.lockTxid !== null)

  const { AssetLockProof, OutPoint, PrivateKey } = await import('@dashevo/evo-sdk')
  const finish = async (balance: bigint | null): Promise<{ balance: bigint | null }> => {
    // The next index only once this address is seen empty (else the next top-up sweeps what is
    // left there). Saved before the journal goes, so a crash in between never reuses a finished
    // index with a fresh start height.
    const left = await depositHeld(ep, journal.depositAddress, journal.startHeight ?? { startedAt: journal.startedAt }).catch(() => null)
    const upcoming: NextTopUp = left === 0 ? { index: journal.index + 1 } : { index: journal.index, fromHeight: journal.startHeight ?? null, fromTime: journal.startedAt }
    await idbPut<NextTopUp>('journal', nextKey(network, identityId), upcoming)
    await idbDelete('journal', journalKey(network, identityId))
    return { balance }
  }
  const balanceNow = (): Promise<bigint | null> => ids.balance(identityId).then((b) => b ?? null, () => null)
  const used = async (txid: string): Promise<boolean> => {
    const op = new OutPoint(txid, 0)
    try {
      return (await assetLockUse(sdk, op.toBytes()).catch(() => null))?.kind === 'fully'
    } finally {
      op.free?.()
    }
  }

  // 3. A resumed run whose lock Platform already used (the tab closed after it landed): done,
  // without sending or proving anything again.
  if (journal.lockTxid !== null && (await used(journal.lockTxid))) return finish(await balanceNow())

  // 4. Deposit → lock (saved before it is broadcast) → proof.
  if (journal.lockTxid === null || journal.lockRaw === null) {
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
  const proof = await obtainLockProof(ep, { txid: lockTxid, raw: lockRaw }, () => platformClh(sdk), {
    signal: params.signal,
    onStatus: (s) => params.onStage?.('proving', s),
  })
  const assetLockProof =
    proof.type === 'instant'
      ? AssetLockProof.createInstantAssetLockProof(proof.islock, proof.raw, 0)
      : AssetLockProof.createChainAssetLockProof(proof.height, new OutPoint(proof.txid, 0))

  // 5. The top-up.
  params.onStage?.('topping-up')
  const fresh = await ids.fetch(identityId)
  if (!fresh) throw new Error(`Identity ${identityId} was not found on Platform. "Try again" resumes with the same deposit.`)
  const assetLockPrivateKey = PrivateKey.fromWIF(lockKey.wif)
  try {
    await (params.freshen ?? (() => evoSdkService.ensureFresh()))()
    params.signal?.throwIfAborted()
    return await finish(await ids.topUp({ identity: fresh, assetLockProof, assetLockPrivateKey }))
  } catch (e) {
    if (isAbort(e)) throw e
    // The answer may not have been checkable (a quorum rotation, a timeout): ask Platform
    // whether the lock was used before calling it a failure.
    params.onStage?.('checking')
    if (await used(lockTxid)) return finish(await balanceNow())
    throw new Error(`The top-up did not go through (${errorMessage(e)}). Your deposit is locked and recorded on this device: "Try again" sends it again, and it is never credited twice.`)
  } finally {
    assetLockPrivateKey.free()
  }
}
