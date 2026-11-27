/**
 * The recovery-phrase side of moving settings sync to a new key (`lib/user-sync/move-key`): the
 * forge-user key at each rotation, as the Dash wallets derive it ({@link deriveAppEncryptionKey}),
 * and the one master-key IdentityUpdate that adds the next rotation, bound to forge-user, and
 * disables the current key. The phrase is held only for the call; every key is wiped after.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { authSdk } from '../sdk/facade'
import { decodeIdentifier } from './base58'
import { deriveAppEncryptionKey, deriveAt, identityKeyPath, invalidMnemonicMessage, isValidMnemonic, normalizeMnemonic, wasmNetwork } from './hd'
import { WrongMasterKeyError, assertMasterKeyOf, sendIdentityUpdate } from './limited-key'
import { VaultLockedError, storeSyncKey, unlockedSecret } from './vault'
import type { WriteAuth } from '../sdk/write'
import { addSyncKey, moveSyncKey, type DeriveSyncKey, type MoveOutcome, type ReplaceSyncKey } from '../user-sync/move-key'
import { forgeUserPort } from '../user-sync/platform'

/** Identity indexes whose master key a phrase is tried at (a wallet's first identities). */
const IDENTITY_INDEXES = 5

/** The forge-user key at each rotation from `mnemonic`, for `identityId` on `contractId`. */
export function phraseSyncKeys(mnemonic: string, network: Network, identityId: string, contractId: string): DeriveSyncKey {
  const id = decodeIdentifier(identityId)
  const contract = decodeIdentifier(contractId)
  return (rotation) => deriveAppEncryptionKey(mnemonic, network, id, contract, rotation)
}

/** Refuse a phrase that is not one, and a vault that cannot keep the new key, before anything is read. */
export async function checkPhraseAndVault(mnemonic: string, network: Network, identityId: string): Promise<string> {
  if (!(await isValidMnemonic(mnemonic))) throw new Error(await invalidMnemonicMessage(mnemonic))
  if (unlockedSecret(network, identityId) === null) throw new VaultLockedError('unlock this browser first')
  return normalizeMnemonic(mnemonic)
}

/** Keep `secret` as this browser's sync key, then wipe it. */
export async function keepSyncKey(network: Network, identityId: string, keyId: number, secret: Uint8Array): Promise<void> {
  try {
    await storeSyncKey(network, identityId, keyId, secret)
  } finally {
    secret.fill(0)
  }
}

/** The master key (WIF) `mnemonic` makes for `identity`, at the first identity index that matches. */
async function masterWifOf(identity: Parameters<typeof assertMasterKeyOf>[0], identityId: string, mnemonic: string, network: Network): Promise<string> {
  for (let index = 0; index < IDENTITY_INDEXES; index++) {
    const { wif } = await deriveAt(mnemonic, identityKeyPath(network, 0, index), network)
    try {
      await assertMasterKeyOf(identity, identityId, wif, network)
      return wif
    } catch (e) {
      if (!(e instanceof WrongMasterKeyError)) throw e
    }
  }
  throw new WrongMasterKeyError(identityId, "This recovery phrase doesn't make this identity's master key. Check the phrase.")
}

/**
 * The IdentityUpdate a move sends: add the new key (ECDSA_SECP256K1, ENCRYPTION, MEDIUM, bound to
 * forge-user alone, not read-only) at its key id and disable the current one, signed by the master
 * key the same phrase makes.
 */
export function phraseReplaceSyncKey(sdk: EvoSDK, network: Network, identityId: string, contractId: string, mnemonic: string): ReplaceSyncKey {
  return async (add, disable) => {
    const { ContractBounds, IdentityPublicKeyInCreation, IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
    const identity = await authSdk(sdk).identities.fetch(identityId)
    if (!identity) throw new Error(`identity ${identityId} not found`)
    const master = PrivateKey.fromWIF(await masterWifOf(identity, identityId, mnemonic, network))
    const fresh = PrivateKey.fromBytes(add.secret, wasmNetwork(network))
    const signer = new IdentitySigner()
    try {
      signer.addKey(master)
      signer.addKey(fresh)
      const key = new IdentityPublicKeyInCreation({
        keyId: add.keyId,
        purpose: 'encryption',
        securityLevel: 'medium',
        keyType: 'ecdsa_secp256k1',
        isReadOnly: false,
        data: fresh.getPublicKey().toBytes(),
        contractBounds: ContractBounds.SingleContract(contractId),
      })
      try {
        await sendIdentityUpdate(sdk, identityId, () => authSdk(sdk).identities.update({ identity, addPublicKeys: [key], disablePublicKeys: [disable], signer }))
      } catch (e) {
        if (/revision|duplicate|already exists|key id/i.test(String((e as { message?: unknown })?.message ?? e))) {
          throw new Error('another key was registered on this identity at the same moment; try again')
        }
        throw e
      }
    } finally {
      signer.free()
      fresh.free()
      master.free()
    }
  }
}

export interface PhraseSyncInput {
  readonly sdk: EvoSDK
  readonly network: Network
  /** Forge's network key (`testnet`, `devnet-<name>`). */
  readonly networkKey: string
  readonly identityId: string
  /** forge-user's contract id on this network. */
  readonly contractId: string
  readonly mnemonic: string
}

/** Add the identity's current sync key, made from the phrase, to this browser. Nothing is written to Platform. */
export async function addSyncKeyWithPhrase(p: PhraseSyncInput): Promise<number> {
  const mnemonic = await checkPhraseAndVault(p.mnemonic, p.network, p.identityId)
  const { keyId } = await addSyncKey({
    port: forgeUserPort(p.sdk, p.contractId, null),
    networkKey: p.networkKey,
    identityId: p.identityId,
    derive: phraseSyncKeys(mnemonic, p.network, p.identityId, p.contractId),
    store: (keyId, secret) => keepSyncKey(p.network, p.identityId, keyId, secret),
  })
  return keyId
}

/**
 * Move settings sync to a new key with the phrase (`lib/user-sync/move-key`). `auth` signs the
 * settings writes; `charged` runs the identity update through the spend ledger.
 */
export async function moveSyncKeyWithPhrase(p: PhraseSyncInput & { readonly auth: WriteAuth; readonly charged: (update: () => Promise<void>) => Promise<void> }): Promise<MoveOutcome> {
  const mnemonic = await checkPhraseAndVault(p.mnemonic, p.network, p.identityId)
  const replace = phraseReplaceSyncKey(p.sdk, p.network, p.identityId, p.contractId, mnemonic)
  return moveSyncKey({
    port: forgeUserPort(p.sdk, p.contractId, p.auth),
    networkKey: p.networkKey,
    identityId: p.identityId,
    derive: phraseSyncKeys(mnemonic, p.network, p.identityId, p.contractId),
    replace: (add, disable) => p.charged(() => replace(add, disable)),
    store: (keyId, secret) => keepSyncKey(p.network, p.identityId, keyId, secret),
  })
}
