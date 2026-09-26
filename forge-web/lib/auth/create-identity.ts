/**
 * Create a Platform identity in the browser (`ux-dx-spec.md` §2.2 tile 2).
 *
 * The flow, journaled in IndexedDB so a closed tab resumes rather than stranding the deposit:
 *   1. a fresh 12-word mnemonic; the user proves they wrote it down (three words);
 *   2. the deposit address (the mnemonic's BIP-44 asset-lock key) and QR; funds arrive from
 *      any wallet (or the faucet on dev networks);
 *   3. the asset lock is built, broadcast and proven (InstantSend or chain lock);
 *   4. one IdentityCreate registers the canonical key set (MASTER, HIGH, CRITICAL auth,
 *      CRITICAL transfer, MEDIUM encryption; DIP-13 from the mnemonic, so `dg` and the bridge
 *      open the same identity) **plus** this browser's limited key (key 5: HIGH, bound to the
 *      dash-forge contract group, budget + expiry), so no second signature is needed.
 *
 * The journal keeps only public facts between steps (the deposit address, the asset-lock
 * txid, the identity id): nothing secret. A resumed flow re-derives every key from the
 * mnemonic, which the user types again (they have it written down; step 1 made sure).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import { idbDelete, idbGet, idbPut } from '../idb'
import {
  broadcastTx,
  buildAssetLock,
  coreEndpoints,
  obtainLockProof,
  waitForDeposit,
  wifBytes,
  type CoreEndpoints,
  type LockProof,
} from './asset-lock'
import { CANONICAL_KEYS, assetLockKeyPath, deriveAt, identityKeyPath, normalizeMnemonic } from './hd'
import { defaultLimits, verifyLimitedKey, type LimitedKey, type LimitedKeyRequest } from './limited-key'

/** Minimum deposit (spec §2.2: 0.02 DASH; the asset-lock floor is 0.003). */
export const MIN_DEPOSIT_DUFFS = 2_000_000
export const DEFAULT_DEPOSIT_DUFFS = 5_000_000

/** A pending creation: public facts only (no keys, no mnemonic). */
export interface CreationJournal {
  readonly network: Network
  readonly depositAddress: string
  readonly identityId: string | null
  readonly lockTxid: string | null
  readonly startedAt: number
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

/** The deposit address a mnemonic funds (its BIP-44 asset-lock key). */
export async function depositAddressOf(mnemonic: string, network: Network): Promise<string> {
  return (await deriveAt(mnemonic, assetLockKeyPath(network), network)).address
}

interface StatusFacade {
  system: { status(): Promise<{ toJSON(): { chain?: { coreChainLockedHeight?: number } } }> }
}

async function platformClh(sdk: EvoSDK): Promise<number | null> {
  const s = await (sdk as unknown as StatusFacade).system.status()
  const h = s.toJSON()?.chain?.coreChainLockedHeight
  return typeof h === 'number' ? h : null
}

export type CreateStage = 'waiting-deposit' | 'locking' | 'proving' | 'registering' | 'verifying'

/**
 * Run (or resume) the creation from the funded deposit onward. Resolves with the new identity
 * id and this browser's limited key. `mnemonic` never leaves this function's scope except as
 * derived keys inside the WASM signer, which is freed before returning.
 */
export async function createIdentityFromMnemonic(
  sdk: EvoSDK,
  params: {
    readonly network: Network
    readonly mnemonic: string
    readonly group: string
    readonly minDepositDuffs?: number
    readonly limits?: LimitedKeyRequest
    readonly endpoints?: CoreEndpoints
    readonly signal?: AbortSignal
    readonly onStage?: (stage: CreateStage, detail?: string) => void
    readonly onDeposit?: (duffs: number) => void
  },
): Promise<{ identityId: string; key: LimitedKey }> {
  const { network, group } = params
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const ep = params.endpoints ?? coreEndpoints(network)
  const evo = await import('@dashevo/evo-sdk')
  const { AssetLockProof, OutPoint, Identity, IdentityPublicKey, IdentitySigner, PrivateKey, ContractBounds } = evo

  const lockKey = await deriveAt(mnemonic, assetLockKeyPath(network), network)
  const journal = (await readCreationJournal(network)) ?? {
    network,
    depositAddress: lockKey.address,
    identityId: null,
    lockTxid: null,
    startedAt: Date.now(),
  }
  if (journal.depositAddress !== lockKey.address) throw new Error('these words do not match the deposit in progress')
  await idbPut('journal', journalKey(network), journal)

  // 1-3: deposit → asset lock → proof (resumes from a broadcast lock).
  let lockTxid = journal.lockTxid
  let lockRaw: Uint8Array | null = null
  if (lockTxid === null) {
    params.onStage?.('waiting-deposit')
    const utxos = await waitForDeposit(ep, lockKey.address, params.minDepositDuffs ?? MIN_DEPOSIT_DUFFS, {
      signal: params.signal,
      onSeen: params.onDeposit,
    })
    params.onStage?.('locking')
    const priv = wifBytes(lockKey.wif)
    const lock = buildAssetLock(utxos, priv)
    priv.fill(0)
    await broadcastTx(ep, bytesToHex(lock.raw), lock.txid)
    lockTxid = lock.txid
    lockRaw = lock.raw
    await idbPut('journal', journalKey(network), { ...journal, lockTxid })
  }
  params.onStage?.('proving')
  if (lockRaw === null) lockRaw = await fetchRaw(ep, lockTxid)
  const proof: LockProof = await obtainLockProof(ep, { txid: lockTxid, raw: lockRaw }, () => platformClh(sdk), {
    signal: params.signal,
    onStatus: (s) => params.onStage?.('proving', s),
  })

  const assetLockProof =
    proof.type === 'instant'
      ? AssetLockProof.createInstantAssetLockProof(proof.islock, proof.raw, 0)
      : AssetLockProof.createChainAssetLockProof(proof.height, new OutPoint(proof.txid, 0))
  const identityId = assetLockProof.createIdentityId().toBase58()
  await idbPut('journal', journalKey(network), { ...journal, lockTxid, identityId })

  // 4: IdentityCreate with the canonical keys + this browser's limited key.
  params.onStage?.('registering')
  const limits = params.limits ?? defaultLimits()
  const identity = new Identity(identityId)
  const signer = new IdentitySigner()
  const browserKey = PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), network === 'mainnet' ? 'mainnet' : 'testnet')
  const assetLockPrivateKey = PrivateKey.fromWIF(lockKey.wif)
  const browserKeyId = CANONICAL_KEYS.length
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
        keyId: browserKeyId,
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
    const existing = await (sdk as unknown as { identities: { balance(id: string): Promise<bigint | undefined> } }).identities
      .balance(identityId)
      .catch(() => undefined)
    if (existing === undefined) {
      await (sdk as unknown as { identities: { create(o: unknown): Promise<void> } }).identities.create({
        identity,
        assetLockProof,
        assetLockPrivateKey,
        signer,
      })
    }
  } finally {
    signer.free()
    assetLockPrivateKey.free()
  }
  const wif = browserKey.toWIF()
  browserKey.free()

  params.onStage?.('verifying')
  const verified = await verifyLimitedKey(sdk, identityId, browserKeyId, group, network, wif)
  await clearCreationJournal(network)
  return { identityId, key: { keyId: browserKeyId, wif, limits: verified } }
}

async function fetchRaw(ep: CoreEndpoints, id: string): Promise<Uint8Array> {
  const res = await fetch(`${ep.insight}/rawtx/${id}`)
  if (!res.ok) throw new Error(`could not refetch asset lock ${id}`)
  return hexToBytes(((await res.json()) as { rawtx: string }).rawtx)
}
