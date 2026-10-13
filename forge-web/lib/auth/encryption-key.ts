/**
 * The identity's ENCRYPTION key in this browser (private repos, `docs/security/private-repos.md`
 * §5.1–§5.2; `ux-dx-spec.md` §2.3).
 *
 * - Which key counts: an identity's usable encryption key is enabled, purpose ENCRYPTION, type
 *   ECDSA_SECP256K1, and unbound or bound to forge-core. Writers wrap to the recipient's
 *   highest-id usable key and record its id ({@link usableEncryptionKey}).
 * - Getting it into the vault: from an identity file (its ENCRYPTION key, or derived from its
 *   mnemonic), a recovery phrase, a pasted WIF/hex key, or a wallet login (the key its login
 *   key stands for, {@link adoptWalletEncryptionKey}). Every route checks that the public key
 *   matches an enabled ENCRYPTION key on the identity before anything is stored.
 * - Registering one (Settings → Members-only and private content): an `IdentityUpdate` signed once by
 *   the master key, adding the next key id, derived from the recovery phrase at
 *   `m/9'/<coin>'/5'/0'/0'/<identityIndex>'/<keyId>'` (the CLI's path, so either client can
 *   re-derive it).
 * - Using it: {@link encryptionOps} returns operations only (unwrap a `repoKey`, seal a wrap);
 *   {@link sealLetterAs} and {@link openLetterAs} seal and open a specific-people letter.
 *   Each opens the key from the vault, hands it to the SDK or `lib/private/named` and wipes it.
 *   The raw key never reaches React, storage outside the vault, a URL or a log.
 */

import * as secp from '@noble/secp256k1'
import type { DataContract, Document, EvoSDK, IdentityPublicKey, PrivateKey as WasmPrivateKey } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import {
  WrapError,
  bytesToHex,
  openLetter,
  privateId,
  sealLetter,
  unwrapKey,
  unwrapKeyRaw,
  sealWrap,
  type DocFields,
  type EpochKeys,
  type LetterOpenResult,
  type LetterReader,
  type LetterRecipient,
  type OwnerKey,
  type PrivateDoc,
  type StoredPrivateDoc,
  type WrapFacade,
} from '../private'
import { authSdk, sleep } from '../sdk/facade'
import { timed } from '../step-timing'
import { deriveAt, deriveMasterKey, identityKeyPath, isValidMnemonic, invalidMnemonicMessage, normalizeMnemonic, wasmNetwork } from './hd'
import { parsePrivateKey } from './wif'
import { WrongMasterKeyError, assertMasterKeyOf, sendIdentityUpdate } from './limited-key'
import { shortId } from '../utils'
import {
  EncryptionKeyNotHeldError,
  VaultLockedError,
  storeEncryptionKey,
  storedEncryptionKeyId,
  storedEncryptionKeyIds,
  unlockScope,
  unlockedSecret,
  withEncryptionKey,
  withEncryptionKeys,
} from './vault'

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
  return `${name} has no encryption key yet. Send them this: \`dg auth keys add --encryption\`, or Settings → Members-only and private content (one master-key signature).`
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

/**
 * The identity's usable encryption key (the one writers wrap to) is not one this browser holds,
 * and no approval of the wallet registered it (a key from `dg`, say). Shown at sign-in.
 */
export const ENCRYPTION_KEY_ELSEWHERE = 'Your encryption key is held elsewhere. Import it under Settings → Members-only and private content.'

/**
 * A repo was wrapped only to keys this browser does not hold, and the one it was wrapped to last
 * came with another of the wallet's approvals: each first approval for another Forge contract
 * registers its own (QR #2 adds exactly an auth and an encryption key). Approving that contract
 * here again brings it. Shown on the repo.
 */
export const ENCRYPTION_KEY_OTHER_APPROVAL =
  "Your encryption key came with another approval in your wallet. Approve it again under Settings → This browser's key to read private repos."

/** AUTHENTICATION, and ECDSA_HASH160: the auth key a wallet registers (DPP enums). */
const PURPOSE_AUTHENTICATION = 0
const KEY_TYPE_ECDSA_HASH160 = 2

/**
 * Whether encryption key `keyId` of an identity is one a wallet registered: a wallet adds its
 * encryption key right after its HASH160 auth key, in one update.
 */
export function walletRegistered(keys: readonly Pick<EncKeyLike, 'keyId' | 'purposeNumber' | 'keyTypeNumber'>[], keyId: number): boolean {
  return keys.some((k) => k.keyId === keyId - 1 && k.purposeNumber === PURPOSE_AUTHENTICATION && k.keyTypeNumber === KEY_TYPE_ECDSA_HASH160)
}

/** What became of the encryption keys a wallet answer stands for ({@link adoptWalletEncryptionKey}). */
export interface WalletEncryptionOutcome {
  /** The key ids of the wallet's keys now sealed in the vault (each a usable ENCRYPTION key of the identity). */
  readonly stored: readonly number[]
  /**
   * The identity's usable key (the one writers wrap to) when this browser holds none by that id
   * (null: held, or the identity has none). `otherApproval`: an approval of the wallet registered it.
   */
  readonly missing: { readonly keyId: number; readonly otherApproval: boolean } | null
}

/**
 * Keep the encryption keys a wallet answer stands for (DESIGN D27): the wallet derives
 * `HKDF(loginKey, identityId, "encryption")` for each login key and registers it beside the auth
 * key the first time it approves a contract; a returning login derives the same one. `candidates`
 * are those private keys. Each whose public key is an enabled, usable ENCRYPTION key of the
 * identity is ADDED to the vault's keys (beside the wallet key, under the same protection); no key
 * already there is replaced, so wraps made to an older key still open. Anything else is a key no
 * wrap could be sealed to, and is not stored. `attempts` re-reads the identity while none of the
 * candidates is on it yet (a node a block behind the wallet's registration). Copies are taken:
 * the caller still wipes `candidates`.
 */
export async function adoptWalletEncryptionKey(
  sdk: EvoSDK,
  network: Network,
  identityId: string,
  coreId: string,
  candidates: readonly Uint8Array[],
  options: { readonly attempts?: number; readonly intervalMs?: number } = {},
): Promise<WalletEncryptionOutcome> {
  const secrets = candidates.filter((c) => c.length === 32).map((c) => new Uint8Array(c))
  try {
    const pubs = secrets.map((s) => bytesToHex(secp.getPublicKey(s, true)))
    for (let attempt = 1; ; attempt++) {
      const keys = await timed(PRIVATE_REPOS_FLOW, 'read identity keys (wallet)', () => requireIdentityKeys(sdk, identityId))
      const onChain = keys.some((k) => k.purposeNumber === PURPOSE_ENCRYPTION && pubs.includes(k.data.toLowerCase()))
      if (!onChain && attempt < (options.attempts ?? 1)) {
        await sleep(options.intervalMs ?? 1500)
        continue
      }
      const stored: number[] = []
      for (const k of keys) {
        const at = pubs.indexOf(k.data.toLowerCase())
        if (at < 0 || !isUsableEncryptionKey(k, coreId)) continue
        await timed(PRIVATE_REPOS_FLOW, 'seal into the vault', () => storeEncryptionKey(network, identityId, k.keyId, secrets[at] as Uint8Array))
        stored.push(k.keyId)
      }
      const usable = usableEncryptionKey(keys, coreId)
      const held = usable === null || (await storedEncryptionKeyIds(network, identityId)).includes(usable.keyId)
      return { stored, missing: held ? null : { keyId: usable.keyId, otherApproval: walletRegistered(keys, usable.keyId) } }
    }
  } finally {
    for (const s of secrets) s.fill(0)
  }
}

/**
 * Whether this tab can use the encryption key of (network, identity) now: `open` (unlocked),
 * `locked` (stored, but this tab must unlock first: one passkey or passphrase gesture opens it
 * for every repo in the tab), or `none` (this browser holds none). Readable while locked.
 */
export async function encryptionKeyState(network: Network, identityId: string): Promise<'open' | 'locked' | 'none'> {
  if ((await storedEncryptionKeyId(network, identityId)) === null) return 'none'
  return unlockScope(network, identityId) === 'full' ? 'open' : 'locked'
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
  if (!(await isValidMnemonic(mnemonic))) throw new Error(await invalidMnemonicMessage(mnemonic))
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
      `This identity already has an encryption key (key ${keyId}). Add it from your identity file or paste it. A new key would lock you out of your private repos until a maintainer repairs them.`,
    )
    this.name = 'EncryptionKeyExistsError'
  }
}

/**
 * Store the encryption key from a recovery phrase (Settings → Members-only and private content): when the
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
  if (!(await isValidMnemonic(source.mnemonic))) throw new Error(await invalidMnemonicMessage(source.mnemonic))
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
  await assertMasterKeyOf(identity, identityId, masterWif, network).catch((e: unknown) => {
    throw e instanceof WrongMasterKeyError ? new WrongMasterKeyError(identityId, `This recovery phrase doesn't belong to identity ${shortId(identityId)} (the one signed in here). Check the phrase.`) : e
  })
  const master = PrivateKey.fromWIF(masterWif)
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
      await sendIdentityUpdate(sdk, identityId, () => authSdk(sdk).identities.update({ identity, addPublicKeys: [key], signer }))
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

/** "encryption key 6" / "encryption keys 6 and 8" (held key ids, in any order). */
export function heldKeysText(held: readonly number[]): string {
  const ids = [...held].sort((a, b) => a - b)
  return ids.length === 1 ? `encryption key ${ids[0]}` : `encryption keys ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/** What a private-repo read or write may do with the vault's encryption key. */
export interface EncryptionOps {
  /**
   * The highest key id this browser holds for the identity. Not necessarily still enabled: a
   * writer sends from the newest USABLE key among {@link keyIds} (`usableEncryptionKey` over the
   * identity's keys filtered to them).
   */
  readonly keyId: number
  /** Every key id this browser holds for the identity, highest first ({@link keyId} among them). */
  readonly keyIds: readonly number[]
  /**
   * Decrypt a `repoKey` (the reader's own, or one it sent) and check its version and `KCV_e`.
   * `counterpartyKey` is the other side's ENCRYPTION public key: the sender's for a wrap to
   * this identity (its own key for a self-wrap), the recipient's for a wrap it sent. The private
   * key is the held one the document names (`recipientKeyId`, else `senderKeyId`); a document
   * naming neither is tried with each held key in turn.
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

/** A key id a `repoKey` document names (`recipientKeyId` / `senderKeyId`), when it is one. */
function namedKeyId(doc: Record<string, unknown>, field: string): number | null {
  const v = doc[field]
  const n = typeof v === 'bigint' ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * Which held keys may open `doc`, in order: the held ones it names (the reader's own key is the
 * recipient of a wrap to it and the sender of one it sent), else, naming none, every held key.
 */
export function keysToTry(doc: Record<string, unknown>, held: readonly number[]): number[] {
  const named = [namedKeyId(doc, 'recipientKeyId'), namedKeyId(doc, 'senderKeyId')].filter((n): n is number => n !== null)
  if (named.length === 0) return [...held]
  return [...new Set(named)].filter((n) => held.includes(n))
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
  const keyIds = await storedEncryptionKeyIds(network, identityId)
  const keyId = keyIds[0]
  if (keyId === undefined) return null
  const facade = (sdk as unknown as { encryptedFor: WrapFacade }).encryptedFor
  const { Document, PrivateKey } = await import('@dashevo/evo-sdk')
  const contract = (await authSdk(sdk).contracts.fetch(repoKeyContractId)) as DataContract | undefined
  if (contract === undefined) throw new Error('forge-collab could not be read')
  const version = (sdk as unknown as { version(): number }).version()
  const net = wasmNetwork(network)
  const withPrivate = <T>(id: number, use: (pk: WasmPrivateKey) => Promise<T>): Promise<T> =>
    withEncryptionKey(
      network,
      identityId,
      async (_heldId, secret) => {
        const pk = PrivateKey.fromBytes(secret, net)
        try {
          return await use(pk)
        } finally {
          pk.free()
        }
      },
      id,
    ).catch((e: unknown) => {
      // The stored keys changed since these ops were made (removed here or in another tab).
      throw e instanceof EncryptionKeyNotHeldError ? new VaultLockedError('the encryption keys in this browser changed; reload') : e
    })
  /** Open `p` with each held key it may be wrapped to, in turn: the first that opens it wins. */
  const withReader = async <T>(p: UnwrapInput, open: (pk: WasmPrivateKey) => Promise<T>): Promise<T> => {
    const ids = keysToTry(p.document, keyIds)
    if (ids.length === 0) throw new WrapError('wrapUnreadable')
    let last: unknown
    for (const id of ids) {
      try {
        return await withPrivate(id, open)
      } catch (e) {
        if (!(e instanceof WrapError)) throw e
        last = e
      }
    }
    throw last
  }
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
    keyIds,
    unwrap: (p) => withReader(p, (pk) => unwrapKey(facade, params(p, pk))),
    unwrapRaw: (p) => withReader(p, (pk) => unwrapKeyRaw(facade, params(p, pk))),
    // Sent from the held key the caller named as the sender (the identity's newest usable one).
    wrap: (p) =>
      withPrivate(p.senderKey.keyId, (pk) =>
        sealWrap(facade, p.keys, p.raw, { dataContract: contract, senderKey: p.senderKey, senderPrivateKey: pk, recipientKey: p.recipientKey }),
      ),
  }
}

/**
 * Seal a specific-people letter (`enc` v0x04, `lib/private/named`) from this browser's stored
 * encryption key for (network, identity): the sender's slot is `recipients[0]`, which must be
 * this identity, and the held key whose public key it names sends it (this browser may hold
 * several, DESIGN D27). The keys are opened from the vault for the call and wiped after; a locked
 * vault makes the call throw, and so does a sender key this browser does not hold.
 */
export function sealLetterAs(
  network: Network,
  identityId: string,
  p: { readonly repoId: Uint8Array; readonly doc: PrivateDoc; readonly fields: DocFields; readonly recipients: readonly LetterRecipient[] },
): Promise<Uint8Array> {
  const senderPub = p.recipients[0] === undefined ? '' : bytesToHex(p.recipients[0].publicKey)
  return withEncryptionKeys(network, identityId, async (keys) => {
    const sender = keys.find((k) => bytesToHex(secp.getPublicKey(k.secret, true)) === senderPub)
    if (sender === undefined) throw new VaultLockedError("this browser does not hold the encryption key the letter's sender slot names")
    return sealLetter(p.repoId, sender.secret, sender.keyId, p.doc, p.fields, p.recipients)
  })
}

/**
 * Open a specific-people letter as (network, identity) with every encryption key this browser
 * holds for it (a letter does not say which of the reader's keys it was sealed to); `ownerKeys`
 * are the document owner's identity keys, where the sender key is looked up. The keys are wiped
 * after the call; a locked vault makes the call throw.
 */
export function openLetterAs(
  network: Network,
  identityId: string,
  p: { readonly repoId: Uint8Array; readonly doc: StoredPrivateDoc; readonly ownerKeys: readonly OwnerKey[] },
): Promise<LetterOpenResult> {
  return withEncryptionKeys(network, identityId, (keys) =>
    openLetter(p.repoId, p.doc, p.ownerKeys, { identityId: privateId(identityId), secrets: keys.map((k) => k.secret) }),
  )
}

/**
 * Run `use` as (network, identity) holding every encryption key this browser stores for it, for
 * a reader that opens artifacts addressed to specific people (an environment for Maintainers).
 * The keys are wiped after the call; a locked vault makes the call throw.
 */
export function withLetterReader<T>(network: Network, identityId: string, use: (reader: LetterReader) => Promise<T>): Promise<T> {
  return withEncryptionKeys(network, identityId, (keys) => use({ identityId: privateId(identityId), secrets: keys.map((k) => k.secret) }))
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
  const held = await storedEncryptionKeyIds(network, identityId)
  if (held.length === 0) return { kind: 'no-key' }
  const mine = await requireIdentityKeys(sdk, identityId)
  // The highest held key that is still an enabled ENCRYPTION key of the identity, usable here.
  const live = held.map((id) => mine.find((k) => k.keyId === id)).filter((k): k is NonNullable<typeof k> => k !== undefined && k.disabledAt === undefined && k.purposeNumber === PURPOSE_ENCRYPTION)
  if (live.length === 0) return { kind: 'unusable' }
  const senderKey = live.find((k) => isUsableEncryptionKey(k, communityId))
  if (senderKey === undefined) return { kind: 'wrong-contract' }
  const keyId = senderKey.keyId
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
    return withEncryptionKey(
      network,
      identityId,
      async (_heldId, secret) => {
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
      },
      keyId,
    ).catch((e: unknown) => {
      throw e instanceof EncryptionKeyNotHeldError ? new VaultLockedError('the encryption keys in this browser changed; reload') : e
    })
  }
  return { kind: 'ready', seal }
}
