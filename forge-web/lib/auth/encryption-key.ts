/**
 * The identity's ENCRYPTION key in this browser (private repos, `docs/security/private-repos.md`
 * §5.1–§5.2; `ux-dx-spec.md` §2.3).
 *
 * - Which key counts: an identity's usable encryption key is enabled, purpose ENCRYPTION, type
 *   ECDSA_SECP256K1, and unbound or bound to forge-core. Writers wrap to the recipient's
 *   highest-id usable key and record its id ({@link usableEncryptionKey}).
 * - Getting it into the vault: from an identity file (its ENCRYPTION key, or derived from its
 *   mnemonic), a recovery phrase, or a pasted WIF/hex key. Every route checks that the public
 *   key matches an enabled ENCRYPTION key on the identity before anything is stored.
 * - Registering one (Settings → Keys → Enable private repos): an `IdentityUpdate` signed once by
 *   the master key, adding the next key id, derived from the recovery phrase at
 *   `m/9'/<coin>'/5'/0'/0'/<identityIndex>'/<keyId>'` (the CLI's path, so either client can
 *   re-derive it).
 * - Using it: {@link encryptionOps} returns operations only (unwrap a `repoKey`, seal a wrap).
 *   Each opens the key from the vault, hands it to the SDK and wipes it. The raw key never
 *   reaches React, storage outside the vault, a URL or a log.
 */

import type { DataContract, Document, EvoSDK, IdentityPublicKey, PrivateKey as WasmPrivateKey } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { bytesToHex, unwrapKey, unwrapKeyRaw, sealWrap, type EpochKeys, type WrapFacade } from '../private'
import { authSdk, sleep } from '../sdk/facade'
import { timed } from '../step-timing'
import { deriveAt, deriveMasterKey, identityKeyPath, isValidMnemonic, normalizeMnemonic, wasmNetwork } from './hd'
import { parsePrivateKey } from './wif'
import { VaultLockedError, storeEncryptionKey, storedEncryptionKeyId, unlockScope, unlockedSecret, withEncryptionKey } from './vault'

/** The step-timing flow of enabling private repos at sign-in (L-20). */
export const PRIVATE_REPOS_FLOW = 'enable-private-repos'

/** Purpose ENCRYPTION, key type ECDSA_SECP256K1 (DPP enums). */
const PURPOSE_ENCRYPTION = 1
const KEY_TYPE_ECDSA_SECP256K1 = 0

/** What the private-repo layer reads of an identity public key. */
export interface EncKeyLike {
  readonly keyId: number
  readonly purposeNumber: number
  readonly keyTypeNumber: number
  readonly disabledAt?: bigint
  readonly contractBounds?: { toJSON(): { $type: string; id: string } }
  /** Compressed public key, hex. */
  readonly data: string
}

/** Whether `k` is a usable ENCRYPTION key for forge-core `coreId` (enabled, secp256k1, unbound or bound there). */
export function isUsableEncryptionKey(k: EncKeyLike, coreId: string): boolean {
  if (k.purposeNumber !== PURPOSE_ENCRYPTION || k.keyTypeNumber !== KEY_TYPE_ECDSA_SECP256K1) return false
  if (k.disabledAt !== undefined) return false
  const bounds = k.contractBounds?.toJSON()
  return bounds === undefined || (bounds.$type !== 'contractGroup' && bounds.id === coreId)
}

/** The identity's highest-id usable ENCRYPTION key, or null (§5.2: writers use this one). */
export function usableEncryptionKey<K extends EncKeyLike>(keys: readonly K[], coreId: string): K | null {
  let best: K | null = null
  for (const k of keys) if (isUsableEncryptionKey(k, coreId) && (best === null || k.keyId > best.keyId)) best = k
  return best
}

/** The verbatim add-member message for an identity with no encryption key (`ux-dx-spec.md` §9). */
export function noEncryptionKeyMessage(name: string): string {
  return `${name} has no encryption key yet. Send them this: \`dg auth keys add --encryption\`, or Settings → Keys → Enable private repos (one master-key signature).`
}

/** The blast-radius sentence of `private-repos.md` §5.2, verbatim. */
export const ENCRYPTION_KEY_BLAST_RADIUS =
  "This key can read every private repo you're a member of, and every key you've handed out as a maintainer."

/** An identity's public keys, or null when the identity does not exist. */
export async function fetchIdentityKeys(sdk: EvoSDK, identityId: string): Promise<(EncKeyLike & IdentityPublicKey)[] | null> {
  const identity = await authSdk(sdk).identities.fetch(identityId)
  return identity ? (identity.publicKeys as unknown as (EncKeyLike & IdentityPublicKey)[]) : null
}

async function requireIdentityKeys(sdk: EvoSDK, identityId: string): Promise<(EncKeyLike & IdentityPublicKey)[]> {
  const keys = await fetchIdentityKeys(sdk, identityId)
  if (keys === null) throw new Error(`identity ${identityId} not found`)
  return keys
}

/** The compressed public key (hex) of a 32-byte secp256k1 private key, through the SDK. */
async function publicKeyHex(secret: Uint8Array, network: Network): Promise<string> {
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const pk = PrivateKey.fromBytes(secret, wasmNetwork(network))
  try {
    return bytesToHex(pk.getPublicKey().toBytes())
  } finally {
    pk.free()
  }
}

/**
 * Check `secret` against the identity's keys and seal it into the vault: it must be the private
 * half of an enabled ENCRYPTION key on the identity. Returns that key's id. `secret` is wiped.
 */
export async function adoptEncryptionKey(sdk: EvoSDK, network: Network, identityId: string, coreId: string, secret: Uint8Array): Promise<number> {
  try {
    if (secret.length !== 32) throw new Error('an encryption private key is 32 bytes')
    const pub = await publicKeyHex(secret, network)
    const keys = await timed(PRIVATE_REPOS_FLOW, 'read identity keys (adopt)', () => requireIdentityKeys(sdk, identityId))
    const match = keys.find(
      (k) => k.purposeNumber === PURPOSE_ENCRYPTION && k.keyTypeNumber === KEY_TYPE_ECDSA_SECP256K1 && k.disabledAt === undefined && k.data.toLowerCase() === pub,
    )
    if (match === undefined) throw new Error("that key is not an enabled encryption key of this identity")
    if (!isUsableEncryptionKey(match, coreId)) throw new Error('that encryption key is bound to another contract, so it cannot be used for Forge private repos')
    await timed(PRIVATE_REPOS_FLOW, 'seal into the vault', () => storeEncryptionKey(network, identityId, match.keyId, secret))
    return match.keyId
  } finally {
    secret.fill(0)
  }
}

/** A pasted WIF or 64-hex private key → the 32 bytes (the caller wipes them). */
export function parseEncryptionKeyInput(input: string): Uint8Array {
  return parsePrivateKey(input).privateKey
}

interface RawFileKey {
  id?: unknown
  purpose?: unknown
  keyType?: unknown
  privateKeyWif?: unknown
  privateKeyHex?: unknown
  privateKey?: unknown
  derivationPath?: unknown
}

/** What an identity file offers for the encryption key: its private keys by id, a mnemonic, the identity index. */
export interface EncryptionMaterial {
  readonly identityId: string
  /** ENCRYPTION private keys the file carries, by key id (wipe after use). */
  readonly keys: ReadonlyMap<number, Uint8Array>
  readonly mnemonic: string | null
  /** The DIP-13 identity index its keys' paths record (0 when none does). */
  readonly identityIndex: number
}

/** The identity index a DIP-13 identity key path records: `m/9'/c'/5'/0'/0'/<index>'/<key>'`. */
function identityIndexOf(path: unknown): number | null {
  if (typeof path !== 'string') return null
  const m = /^m\/9'\/\d+'\/5'\/0'\/0'\/(\d+)'\/\d+'$/.exec(path)
  return m === null ? null : Number(m[1])
}

/** Parse the encryption material an identity file holds (none of it leaves the caller). */
export function encryptionMaterialFromFile(text: string): EncryptionMaterial {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Never forward the parser's message: it quotes the input, which holds private keys.
    throw new Error('identity file is not valid JSON')
  }
  if (json === null || typeof json !== 'object') throw new Error('identity file must be a JSON object')
  const obj = json as Record<string, unknown>
  const identityId = typeof obj['identityId'] === 'string' ? obj['identityId'] : typeof obj['id'] === 'string' ? obj['id'] : ''
  if (identityId === '') throw new Error('identity file is missing "identityId"')
  const rawKeys = Array.isArray(obj['identityKeys']) ? (obj['identityKeys'] as RawFileKey[]) : Array.isArray(obj['keys']) ? (obj['keys'] as RawFileKey[]) : []
  const keys = new Map<number, Uint8Array>()
  let identityIndex: number | null = null
  for (const k of rawKeys) {
    identityIndex ??= identityIndexOf(k.derivationPath)
    if (String(k.purpose ?? '').toUpperCase() !== 'ENCRYPTION') continue
    if (k.keyType !== undefined && String(k.keyType).toUpperCase() !== 'ECDSA_SECP256K1') continue
    if (typeof k.id !== 'number') continue
    const input = [k.privateKeyWif, k.privateKeyHex, k.privateKey].find((v): v is string => typeof v === 'string' && v.length > 0)
    if (input === undefined) continue
    try {
      keys.set(k.id, parsePrivateKey(input).privateKey)
    } catch {
      /* not a key we can use */
    }
  }
  const mnemonic = typeof obj['mnemonic'] === 'string' && obj['mnemonic'].trim() !== '' ? obj['mnemonic'] : null
  return { identityId, keys, mnemonic, identityIndex: identityIndex ?? 0 }
}

/** Wipe every key an {@link EncryptionMaterial} holds. */
export function wipeMaterial(m: EncryptionMaterial): void {
  for (const k of m.keys.values()) k.fill(0)
}

/** The 32-byte private key at a DIP-13 path, from a mnemonic (the caller wipes it). */
async function deriveSecret(mnemonic: string, network: Network, keyId: number, identityIndex: number): Promise<Uint8Array> {
  const d = await deriveAt(mnemonic, identityKeyPath(network, keyId, identityIndex), network)
  return parsePrivateKey(d.wif).privateKey
}

/**
 * Import the identity's encryption key from `material` (an identity file) or a recovery phrase:
 * the file's own ENCRYPTION keys first, else each usable ENCRYPTION key id derived from the
 * mnemonic. Stores the first that matches the identity. Returns its key id, or null when the
 * identity has no usable ENCRYPTION key the material can open.
 */
export async function importEncryptionKey(
  sdk: EvoSDK,
  network: Network,
  identityId: string,
  coreId: string,
  source: EncryptionMaterial | { readonly mnemonic: string; readonly identityIndex?: number },
): Promise<number | null> {
  const candidates = (await timed(PRIVATE_REPOS_FLOW, 'read identity keys', () => requireIdentityKeys(sdk, identityId)))
    .filter((k) => isUsableEncryptionKey(k, coreId))
    .sort((a, b) => b.keyId - a.keyId)
  if (candidates.length === 0) return null
  const fileKeys = 'keys' in source ? source.keys : new Map<number, Uint8Array>()
  for (const k of candidates) {
    const fromFile = fileKeys.get(k.keyId)
    if (fromFile !== undefined && (await publicKeyHex(fromFile, network)) === k.data.toLowerCase()) {
      return adoptEncryptionKey(sdk, network, identityId, coreId, new Uint8Array(fromFile))
    }
  }
  const mnemonic = source.mnemonic
  if (mnemonic === null) return null
  if (!(await isValidMnemonic(mnemonic))) throw new Error('those words are not a valid recovery phrase')
  for (const k of candidates) {
    const secret = await timed(PRIVATE_REPOS_FLOW, `derive key ${k.keyId} from the phrase`, () => deriveSecret(normalizeMnemonic(mnemonic), network, k.keyId, source.identityIndex ?? 0))
    if ((await publicKeyHex(secret, network)) === k.data.toLowerCase()) return adoptEncryptionKey(sdk, network, identityId, coreId, secret)
    secret.fill(0)
  }
  return null
}

/** The identity already has a usable encryption key this browser could not get from the phrase. */
export class EncryptionKeyExistsError extends Error {
  constructor(readonly keyId: number) {
    super(
      `This identity already has a usable encryption key (key ${keyId}). Add that key here from your identity file or by pasting it: a new key would lock you out of the private repos whose keys went to key ${keyId} until a maintainer repairs them.`,
    )
    this.name = 'EncryptionKeyExistsError'
  }
}

/**
 * Enable private repos from a recovery phrase (Settings → Keys → Enable private repos): when the
 * identity already has a usable ENCRYPTION key the phrase derives, that key is stored (nothing
 * is registered); when it has one the phrase does not derive, this refuses
 * ({@link EncryptionKeyExistsError}: registering another would strand the wraps to the old one,
 * which is `private-repos.md` §5.2's rekey without its rotations). Otherwise it registers the
 * next key id, derived from the phrase, with one `IdentityUpdate` the master key (from the same
 * phrase) signs, and stores it. Neither private key is retained beyond the call.
 */
export async function registerEncryptionKey(
  sdk: EvoSDK,
  network: Network,
  identityId: string,
  coreId: string,
  source: { readonly mnemonic: string; readonly identityIndex?: number },
): Promise<{ readonly keyId: number; readonly registered: boolean }> {
  if (!(await isValidMnemonic(source.mnemonic))) throw new Error('those words are not a valid recovery phrase')
  // The new key must land in the vault: never pay for a key this browser cannot keep.
  if (unlockedSecret(network, identityId) === null) throw new VaultLockedError('unlock this browser first')
  // A reloaded tab holds the signing key only: the new key could not be stored with the vault.
  if (unlockScope(network, identityId) === 'signing') throw new VaultLockedError('unlock this tab first: a new encryption key is stored with the rest of the vault')
  const existing = usableEncryptionKey(await requireIdentityKeys(sdk, identityId), coreId)
  if (existing !== null) {
    const imported = await importEncryptionKey(sdk, network, identityId, coreId, source)
    if (imported !== null) return { keyId: imported, registered: false }
    throw new EncryptionKeyExistsError(existing.keyId)
  }
  const mnemonic = normalizeMnemonic(source.mnemonic)
  const identityIndex = source.identityIndex ?? 0
  const { IdentityPublicKeyInCreation, IdentitySigner, PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(identityId)
  if (!identity) throw new Error(`identity ${identityId} not found`)
  const masterWif = identityIndex === 0 ? (await deriveMasterKey(mnemonic, network)).wif : (await deriveAt(mnemonic, identityKeyPath(network, 0, identityIndex), network)).wif
  const master = PrivateKey.fromWIF(masterWif)
  const masterBytes = master.toBytes()
  const isMaster = identity.publicKeys.some((k) => k.securityLevelNumber === 0 && k.disabledAt === undefined && safeValidate(k, masterBytes, network))
  masterBytes.fill(0)
  if (!isMaster) {
    master.free()
    throw new Error("that recovery phrase does not hold this identity's master key")
  }
  const keyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1
  const secret = await deriveSecret(mnemonic, network, keyId, identityIndex)
  const fresh = PrivateKey.fromBytes(secret, wasmNetwork(network))
  const signer = new IdentitySigner()
  try {
    signer.addKey(master)
    signer.addKey(fresh)
    const key = new IdentityPublicKeyInCreation({
      keyId,
      purpose: 'encryption',
      securityLevel: 'medium',
      keyType: 'ecdsa_secp256k1',
      data: fresh.getPublicKey().toBytes(),
    })
    try {
      await authSdk(sdk).identities.update({ identity, addPublicKeys: [key], signer })
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
  // A node a block behind does not show the key yet: re-read until it does.
  try {
    for (let i = 0; ; i++) {
      try {
        return { keyId: await adoptEncryptionKey(sdk, network, identityId, coreId, new Uint8Array(secret)), registered: true }
      } catch (e) {
        if (i >= 6 || e instanceof VaultLockedError) throw e
        await sleep(1500)
      }
    }
  } finally {
    secret.fill(0)
  }
}

function safeValidate(k: { validatePrivateKey(b: Uint8Array, n: string): boolean }, bytes: Uint8Array, network: Network): boolean {
  try {
    return k.validatePrivateKey(bytes, network)
  } catch {
    return false
  }
}

/** What a private-repo read or write may do with the vault's encryption key. */
export interface EncryptionOps {
  /** The key id of the stored encryption key on this identity. */
  readonly keyId: number
  /**
   * Decrypt a `repoKey` (the reader's own, or one it sent) and check its version and `KCV_e`.
   * `counterpartyKey` is the other side's ENCRYPTION public key: the sender's for a wrap to
   * this identity (its own key for a self-wrap), the recipient's for a wrap it sent.
   */
  unwrap(p: UnwrapInput): Promise<EpochKeys>
  /** {@link unwrap}, also returning the raw epoch key (wipe it after use). */
  unwrapRaw(p: UnwrapInput): Promise<{ keys: EpochKeys; raw: Uint8Array }>
  /**
   * The `repoKey` properties (`wrapped`, `recipientKeyId`, `senderKeyId`) wrapping the epoch key
   * `raw` (subkeys `keys`) to `recipientKey`, sent from this identity's stored key `senderKey`.
   */
  wrap(p: { keys: EpochKeys; raw: Uint8Array; senderKey: IdentityPublicKey; recipientKey: IdentityPublicKey }): Promise<Record<string, unknown>>
}

export interface UnwrapInput {
  /** The `repoKey` document as a query returns it (the `toJSON` form). */
  readonly document: Record<string, unknown>
  readonly counterpartyKey: IdentityPublicKey
  readonly repoId: Uint8Array
  readonly epoch: number
}

/**
 * The encryption operations of (network, identity), or null when this browser holds no
 * encryption key for it. `repoKeyContractId` is the contract holding `repoKey` (forge-collab since
 * RC1): its `encryptedFor` declaration is what a wrap is sealed and opened by. Each call opens the
 * key from the unlocked vault and wipes it after; a locked vault makes the call throw.
 */
export async function encryptionOps(sdk: EvoSDK, network: Network, identityId: string, repoKeyContractId: string): Promise<EncryptionOps | null> {
  const keyId = await storedEncryptionKeyId(network, identityId)
  if (keyId === null) return null
  const facade = (sdk as unknown as { encryptedFor: WrapFacade }).encryptedFor
  const { Document, PrivateKey } = await import('@dashevo/evo-sdk')
  const contract = (await authSdk(sdk).contracts.fetch(repoKeyContractId)) as DataContract | undefined
  if (contract === undefined) throw new Error('forge-collab could not be read')
  const version = (sdk as unknown as { version(): number }).version()
  const net = wasmNetwork(network)
  const withPrivate = <T>(use: (pk: WasmPrivateKey) => Promise<T>): Promise<T> =>
    withEncryptionKey(network, identityId, async (heldId, secret) => {
      // The stored key was replaced since these ops were made: their key id no longer matches.
      if (heldId !== keyId) throw new VaultLockedError('the encryption key in this browser changed; reload')
      const pk = PrivateKey.fromBytes(secret, net)
      try {
        return await use(pk)
      } finally {
        pk.free()
      }
    })
  const params = (p: UnwrapInput, pk: WasmPrivateKey) => ({
    dataContract: contract,
    document: Document.fromJSON(p.document as Parameters<typeof Document.fromJSON>[0], version) as Document,
    readerPrivateKey: pk,
    counterpartyKey: p.counterpartyKey,
    repoId: p.repoId,
    epoch: p.epoch,
  })
  return {
    keyId,
    unwrap: (p) => withPrivate((pk) => unwrapKey(facade, params(p, pk))),
    unwrapRaw: (p) => withPrivate((pk) => unwrapKeyRaw(facade, params(p, pk))),
    wrap: (p) =>
      withPrivate((pk) =>
        sealWrap(facade, p.keys, p.raw, { dataContract: contract, senderKey: p.senderKey, senderPrivateKey: pk, recipientKey: p.recipientKey }),
      ),
  }
}

/** Why a webhook's secret cannot be sealed from this browser (QW-071), or the sealer. */
export type WebhookSealer =
  | { readonly kind: 'ready'; readonly seal: (plaintext: Uint8Array, recipientIdentityId: string) => Promise<Record<string, unknown>> }
  | { readonly kind: 'no-key' }
  | { readonly kind: 'wrong-contract' }
  | { readonly kind: 'unusable' }

/**
 * The sealer of a forge-community `webhook.secret` (`encryptedFor`: the relay's ENCRYPTION key,
 * from the writer's): it seals from this browser's stored encryption key, which must be usable
 * for forge-community (unbound, or bound to it), to the recipient identity's highest-id usable
 * key there (forge-core `select_recipient_key`). `no-key`: this browser holds none;
 * `wrong-contract`: the one it holds is bound to another contract; `unusable`: it is no longer
 * an enabled ENCRYPTION key of the identity (disabled, or replaced). Each seal opens the key from
 * the vault and wipes it; a locked vault makes the call throw.
 */
export async function webhookSealer(sdk: EvoSDK, network: Network, identityId: string, communityId: string): Promise<WebhookSealer> {
  const keyId = await storedEncryptionKeyId(network, identityId)
  if (keyId === null) return { kind: 'no-key' }
  const mine = await requireIdentityKeys(sdk, identityId)
  const senderKey = mine.find((k) => k.keyId === keyId)
  if (senderKey === undefined || senderKey.disabledAt !== undefined || senderKey.purposeNumber !== PURPOSE_ENCRYPTION) return { kind: 'unusable' }
  if (!isUsableEncryptionKey(senderKey, communityId)) return { kind: 'wrong-contract' }
  const facade = (sdk as unknown as { encryptedFor: WrapFacade }).encryptedFor
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const net = wasmNetwork(network)
  const seal = async (plaintext: Uint8Array, recipientIdentityId: string): Promise<Record<string, unknown>> => {
    const theirs = await fetchIdentityKeys(sdk, recipientIdentityId)
    if (theirs === null) throw new Error(`relay ${recipientIdentityId} is not an identity on this network`)
    const recipientKey = usableEncryptionKey(theirs, communityId)
    if (recipientKey === null) throw new Error(`relay ${recipientIdentityId} has no enabled ECDSA_SECP256K1 ENCRYPTION key to encrypt the secret to`)
    const contract = (await authSdk(sdk).contracts.fetch(communityId)) as DataContract | undefined
    if (contract === undefined) throw new Error('forge-community could not be read')
    return withEncryptionKey(network, identityId, async (heldId, secret) => {
      if (heldId !== keyId) throw new VaultLockedError('the encryption key in this browser changed; reload')
      const pk = PrivateKey.fromBytes(secret, net)
      try {
        return await facade.encrypt({
          dataContract: contract,
          documentTypeName: 'webhook',
          property: 'secret',
          plaintext,
          senderKey,
          senderPrivateKey: pk,
          recipientKey,
        })
      } finally {
        pk.free()
      }
    })
  }
  return { kind: 'ready', seal }
}
