/**
 * The `repoKey` wrap (`docs/security/private-repos.md` §5.1): the 47-byte plaintext
 * `0x01 ‖ KCV_e(14) ‖ K_e(32)`, encrypted with the contract's `encryptedFor` declaration
 * through the evo-sdk helper. The facade is a parameter, so this module has no runtime SDK
 * import.
 */

import type {
  DataContract,
  Document,
  EncryptedForFacade,
  IdentityPublicKey,
  PrivateKey,
} from '@dashevo/evo-sdk'

import { concat, constantTimeEqual, type Bytes } from './bytes'
import { EpochKeys } from './keys'

export const WRAP_VERSION = 0x01
export const WRAP_PLAINTEXT_LEN = 47
/** The `repoKey` property declaring `encryptedFor`. */
export const WRAP_PROPERTY = 'wrapped'
export const REPO_KEY_DOC = 'repoKey'

export type WrapFacade = Pick<EncryptedForFacade, 'encrypt' | 'decrypt'>

export type WrapErrorCode = 'wrapUnreadable' | 'keyMismatch'

export class WrapError extends Error {
  constructor(readonly code: WrapErrorCode) {
    super(`repoKey: ${code}`)
    this.name = 'WrapError'
  }
}

/**
 * `0x01 ‖ KCV_e ‖ K_e` for the epoch key `raw` (whose subkeys are `keys`). Throws `RangeError`
 * when `raw` is not the key behind `keys`.
 */
export async function buildWrapPlaintext(keys: EpochKeys, raw: Uint8Array): Promise<Bytes> {
  if (raw.length !== 32) throw new RangeError('an epoch key is 32 bytes')
  // `raw` must be the key behind `keys`: a wrap of any other key would carry `keys`' KCV and
  // pass the reader's KCV check only to fail its anchor check (§5.4). Re-derive and compare.
  const check = await EpochKeys.import(keys.repoId, keys.epoch, raw)
  if (!constantTimeEqual(check.commit, keys.commit)) throw new RangeError('the epoch key does not match its subkeys')
  return concat(new Uint8Array([WRAP_VERSION]), keys.kcv, raw)
}

/**
 * Check an unwrapped plaintext's version and `KCV_e` (§5.4 check 4) and import the recovered
 * key; else `wrapUnreadable`. `plaintext` is wiped. The result still has to match the epoch's
 * anchor (check 5: {@link parseWrapPlaintext}, or `resolveEpochs` on the alerting path).
 */
export async function checkWrapPlaintext(repoId: Uint8Array, epoch: number, plaintext: Uint8Array): Promise<EpochKeys> {
  try {
    if (plaintext.length !== WRAP_PLAINTEXT_LEN || plaintext[0] !== WRAP_VERSION) {
      throw new WrapError('wrapUnreadable')
    }
    const keys = await EpochKeys.import(repoId, epoch, plaintext.subarray(15, 47))
    if (!constantTimeEqual(keys.kcv, plaintext.subarray(1, 15))) throw new WrapError('wrapUnreadable')
    return keys
  } finally {
    plaintext.fill(0)
  }
}

/**
 * {@link checkWrapPlaintext}, then `COMMIT_e` of the recovered key against the epoch anchor's
 * commitment (§5.4 check 5; else `keyMismatch`).
 */
export async function parseWrapPlaintext(
  repoId: Uint8Array,
  epoch: number,
  plaintext: Uint8Array,
  anchorCommit: Uint8Array,
): Promise<EpochKeys> {
  const keys = await checkWrapPlaintext(repoId, epoch, plaintext)
  if (!constantTimeEqual(keys.commit, anchorCommit)) throw new WrapError('keyMismatch')
  return keys
}

/** A wrap to seal: the sender's ENCRYPTION key pair and the recipient's ENCRYPTION key. */
export interface WrapSealParams {
  readonly dataContract: DataContract
  readonly senderKey: IdentityPublicKey
  readonly senderPrivateKey: PrivateKey
  readonly recipientKey: IdentityPublicKey
}

/**
 * Wrap the epoch key `raw` (subkeys `keys`) for a recipient; throws `RangeError` when `raw` is
 * not the key behind `keys`. Returns the properties to set on
 * the `repoKey` document (`wrapped`, `recipientKeyId`, `senderKeyId`); the caller sets
 * `repoId`, `memberId` and `epoch`.
 */
export async function sealWrap(
  facade: WrapFacade,
  keys: EpochKeys,
  raw: Uint8Array,
  params: WrapSealParams,
): Promise<Record<string, unknown>> {
  const plaintext = await buildWrapPlaintext(keys, raw)
  try {
    return await facade.encrypt({
      dataContract: params.dataContract,
      documentTypeName: REPO_KEY_DOC,
      property: WRAP_PROPERTY,
      plaintext,
      senderKey: params.senderKey,
      senderPrivateKey: params.senderPrivateKey,
      recipientKey: params.recipientKey,
    })
  } finally {
    plaintext.fill(0)
  }
}

/** A wrap to open: the `repoKey` document, the reader's private key and the counterparty's key. */
export interface UnwrapParams {
  readonly dataContract: DataContract
  readonly document: Document
  /** The reader's ENCRYPTION private key (the recipient's, or the sender's reading back). */
  readonly readerPrivateKey: PrivateKey
  /** The other side's ENCRYPTION public key. */
  readonly counterpartyKey: IdentityPublicKey
  readonly repoId: Uint8Array
  /** The wrap's `epoch`. */
  readonly epoch: number
}

export interface WrapOpenParams extends UnwrapParams {
  /** The `COMMIT_e` the epoch's anchor carries (`enc[1..33]`). */
  readonly anchorCommit: Uint8Array
}

/**
 * Decrypt a `repoKey` and check its version and `KCV_e`: the key a `WrapRow` carries into
 * `resolveEpochs`, which checks it against the anchor and raises `keyMismatch`. Throws
 * {@link WrapError}: an SDK decrypt failure (a padding error) is `wrapUnreadable`.
 */
export async function unwrapKey(facade: WrapFacade, params: UnwrapParams): Promise<EpochKeys> {
  return checkWrapPlaintext(params.repoId, params.epoch, await decryptWrap(facade, params))
}

/** The SDK decrypt of a wrap; any failure (a padding error) is `wrapUnreadable`. */
async function decryptWrap(facade: WrapFacade, params: UnwrapParams): Promise<Uint8Array> {
  try {
    return await facade.decrypt({
      dataContract: params.dataContract,
      document: params.document,
      property: WRAP_PROPERTY,
      recipientPrivateKey: params.readerPrivateKey,
      senderKey: params.counterpartyKey,
    })
  } catch {
    throw new WrapError('wrapUnreadable')
  }
}

/**
 * {@link unwrapKey}, also returning the raw 32-byte epoch key. Only a maintainer needs it:
 * to wrap the epoch for a new member (§5.5 add member), to carry it as the next anchor's
 * `prevEpochKey`, or to resume a rotation from its own self-wrap (§5.5, no key is ever stored).
 * The caller wipes `raw` as soon as it is done with it.
 */
export async function unwrapKeyRaw(facade: WrapFacade, params: UnwrapParams): Promise<{ keys: EpochKeys; raw: Bytes }> {
  const plaintext = await decryptWrap(facade, params)
  const raw = plaintext.length === WRAP_PLAINTEXT_LEN ? plaintext.slice(15, 47) : new Uint8Array(32)
  try {
    return { keys: await checkWrapPlaintext(params.repoId, params.epoch, plaintext), raw }
  } catch (e) {
    raw.fill(0)
    throw e
  }
}

/** {@link unwrapKey}, then the anchor check (§5.4 check 5): `keyMismatch` when it fails. */
export async function openWrap(facade: WrapFacade, params: WrapOpenParams): Promise<EpochKeys> {
  const keys = await unwrapKey(facade, params)
  if (!constantTimeEqual(keys.commit, params.anchorCommit)) throw new WrapError('keyMismatch')
  return keys
}
