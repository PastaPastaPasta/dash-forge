/**
 * Create a Platform identity in the browser (`ux-dx-spec.md` §2.2 tile 2).
 *
 * The flow, journaled in IndexedDB so a closed tab resumes rather than stranding the deposit:
 *   1. a fresh 12-word mnemonic; the user proves they wrote it down (three words);
 *   2. the deposit address (the mnemonic's BIP-44 asset-lock key) and QR; funds arrive from
 *      any wallet (or the faucet on dev networks);
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
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Network } from '../constants'
import { idbDelete, idbGet, idbPut } from '../idb'
import { authSdk } from '../sdk/facade'
import {
  broadcastTx,
  buildAssetLock,
  coreEndpoints,
  getUtxos,
  obtainLockProof,
  waitForDeposit,
  wifBytes,
  type CoreEndpoints,
  type LockProof,
} from './asset-lock'
import { CANONICAL_KEYS, assetLockKeyPath, deriveAt, deriveMasterKey, identityKeyPath, normalizeMnemonic } from './hd'
import { assertGroupHolds, defaultLimits, registerLimitedKey, verifyLimitedKey, type LimitedKey, type LimitedKeyRequest } from './limited-key'

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

/** What an unfinished creation's deposit address holds (duffs), to warn before discarding. */
export async function depositBalance(network: Network, address: string, endpoints = coreEndpoints(network)): Promise<number> {
  const utxos = await getUtxos(endpoints, address)
  return utxos.reduce((s, u) => s + u.satoshis, 0)
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
    /** forge-core and forge-collab: the group must hold them on chain before a key binds to it. */
    readonly contracts: readonly string[]
    readonly persistKey: (identityId: string, key: { keyId: number; wif: string }) => Promise<void>
    readonly minDepositDuffs?: number
    readonly limits?: LimitedKeyRequest
    readonly endpoints?: CoreEndpoints
    readonly signal?: AbortSignal
    readonly onStage?: (stage: CreateStage, detail?: string) => void
    readonly onDeposit?: (duffs: number) => void
  },
): Promise<{ identityId: string; key: LimitedKey }> {
  const { network, group } = params
  await assertGroupHolds(sdk, group, params.contracts)
  const mnemonic = normalizeMnemonic(params.mnemonic)
  const ep = params.endpoints ?? coreEndpoints(network)
  const { AssetLockProof, OutPoint, Identity, IdentityPublicKey, IdentitySigner, PrivateKey, ContractBounds } = await import('@dashevo/evo-sdk')

  const lockKey = await deriveAt(mnemonic, assetLockKeyPath(network), network)
  let journal: CreationJournal = (await readCreationJournal(network)) ?? {
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
    params.onStage?.('waiting-deposit')
    const utxos = await waitForDeposit(ep, lockKey.address, params.minDepositDuffs ?? MIN_DEPOSIT_DUFFS, {
      signal: params.signal,
      onSeen: params.onDeposit,
    })
    params.onStage?.('locking')
    const priv = wifBytes(lockKey.wif)
    const lock = buildAssetLock(utxos, priv)
    priv.fill(0)
    await save({ lockTxid: lock.txid, lockRaw: bytesToHex(lock.raw) })
  }
  const lockTxid = journal.lockTxid as string
  const lockRaw = hexToBytes(journal.lockRaw as string)
  // Idempotent: re-sending an accepted transaction is a no-op the explorer tolerates.
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
  const exists = (await authSdk(sdk).identities.balance(identityId).catch(() => undefined)) !== undefined
  if (exists) {
    // Created by an earlier run whose browser key was lost: the master key renews it.
    params.onStage?.('registering', 'The identity exists; registering a key for this browser…')
    const master = await deriveMasterKey(mnemonic, network)
    // The earlier run's key 5 may be live (its vault copy is locked or gone): disable it in
    // the same update, so no key nobody holds stays live.
    const key = await registerLimitedKey(sdk, { network, identityId, masterWif: master.wif, group, request: limits, replaceKeyId: BROWSER_KEY_ID })
    await params.persistKey(identityId, key)
    return { identityId, key }
  }

  // 4: the browser key goes to the vault first, then IdentityCreate registers it.
  params.onStage?.('registering')
  const browserKey = PrivateKey.fromBytes(crypto.getRandomValues(new Uint8Array(32)), network === 'mainnet' ? 'mainnet' : 'testnet')
  const wif = browserKey.toWIF()
  await params.persistKey(identityId, { keyId: BROWSER_KEY_ID, wif })
  const identity = new Identity(identityId)
  const signer = new IdentitySigner()
  const assetLockPrivateKey = PrivateKey.fromWIF(lockKey.wif)
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
    await authSdk(sdk).identities.create({ identity, assetLockProof, assetLockPrivateKey, signer })
  } finally {
    signer.free()
    assetLockPrivateKey.free()
    browserKey.free()
  }

  params.onStage?.('verifying')
  const verified = await verifyLimitedKey(sdk, identityId, BROWSER_KEY_ID, group, network, wif, limits)
  return { identityId, key: { keyId: BROWSER_KEY_ID, wif, limits: verified } }
}
