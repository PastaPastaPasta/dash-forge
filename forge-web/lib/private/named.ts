/**
 * Specific-people letters: `enc` v0x04 (`docs/security/private-repos.md` §4.1), a document sealed
 * to a list of identities chosen by its writer, members or not. The Rust twin is
 * `crates/forge-core/src/private/named.rs`; the `named_envelope__*` vectors hold the two equal.
 *
 * ```text
 * enc  = 0x04 ‖ n(u8, 1..16) ‖ senderKeyId(u32) ‖ COMMIT_obj(32) ‖ n × slot(64)
 *        ‖ nonce(12) ‖ AES-256-GCM(K_doc,obj, nonce, TLV, AD') ‖ tag(16)
 * slot = IV(16) ‖ AES-256-CBC-PKCS7(S, IV, 0x02 ‖ KCV_obj(14) ‖ K_obj(32))
 * S    = SHA-256 of the 33-byte compressed ECDH point senderEncPriv · recipientEncPub
 * H    = enc[1 .. 38 + 64·n];   AD' = AD(enc[0] = 0x04, epoch = 0) ‖ SHA-256(H)
 * TLV  = content ‖ tag 25 (recipient identity id) × n, in slot order ‖ padding
 * ```
 *
 * `S` hashes the **whole** compressed point, parity byte included (the `encryptedFor` scheme,
 * Platform's `derive_shared_key_ecdh`), never the x-only slice `lib/auth/wallet-protocol.ts`
 * feeds its own HKDF. ECDH is `@noble/secp256k1` (already in the app path); AES-CBC, AES-GCM,
 * HKDF and SHA-256 are WebCrypto.
 *
 * Reader rule: the sender key is the document owner's key `senderKeyId`, which must be an
 * `ECDSA_SECP256K1` key of purpose `ENCRYPTION` (disabled is fine for reading); one ECDH per key
 * the reader holds, every slot tried; a slot counts only when its padding, version byte,
 * `KCV_obj` prefix and the full `COMMIT_obj` match; then GCM; then `count(tag 25) = n` and the
 * reader's own id at its slot index. The recipient list is "as listed by the sender".
 */

import { getPublicKey, getSharedSecret } from '@noble/secp256k1'

import { bytes, concat, constantTimeEqual, randomBytes, sha256, u32, utf8, type Bytes } from './bytes'
import {
  LETTER_SLOT_LEN,
  MAX_LETTER_RECIPIENTS,
  TooLargeError,
  V4,
  docAdWithoutKeys,
  letterFramed,
  maxLetterPlaintext,
  padded,
  type PrivateDoc,
  type StoredPrivateDoc,
} from './doc'
import { bytesEqual } from './ids'
import { objKeys, type ObjKeys } from './keys'
import { MalformedError, buildTlv, encodeRecipients, letterKind, parseLetterTlv, type DocFields } from './tlv'

/** The slot plaintext's version byte: a specific-people slot (a `repoKey` wrap is `0x01`). */
export const SLOT_VERSION = 0x02
/** Platform's purpose number of an `ENCRYPTION` key. */
export const PURPOSE_ENCRYPTION = 1
/** Platform's key type number of an `ECDSA_SECP256K1` key. */
export const KEY_TYPE_ECDSA_SECP256K1 = 0

/** `0x04 ‖ n ‖ senderKeyId ‖ COMMIT_obj`. */
const HEAD_LEN = 38
const NONCE_LEN = 12
const SLOT_PLAINTEXT_LEN = 47

/** One recipient: an identity and the ENCRYPTION public key (33-byte compressed) its slot is sealed to. */
export interface LetterRecipient {
  readonly identityId: Uint8Array
  readonly publicKey: Uint8Array
}

/** A key of the document owner's identity, as the reader fetched it. */
export interface OwnerKey {
  readonly id: number
  /** Platform's purpose number ({@link PURPOSE_ENCRYPTION} for a sender key). */
  readonly purpose: number
  /** Platform's key type number ({@link KEY_TYPE_ECDSA_SECP256K1} for a sender key). */
  readonly keyType: number
  /** The public key bytes. */
  readonly data: Uint8Array
}

/** Who is reading: an identity and its ENCRYPTION private keys (usually one; more after a rekey). */
export interface LetterReader {
  readonly identityId: Uint8Array
  readonly secrets: readonly Uint8Array[]
}

export type LetterOpenResult =
  | { readonly status: 'readable'; readonly fields: DocFields; readonly recipients: readonly Uint8Array[]; readonly slot: number }
  | { readonly status: 'unreadable'; readonly reason: 'notARecipient' | 'badTag' }
  | { readonly status: 'malformed' }

const MALFORMED: LetterOpenResult = { status: 'malformed' }

/** The scheme's shared key of `secret` and `publicKey`: SHA-256 of the compressed ECDH point. */
export async function letterSharedKey(secret: Uint8Array, publicKey: Uint8Array): Promise<Bytes> {
  const point = getSharedSecret(secret, publicKey, true)
  try {
    return await sha256(point)
  } finally {
    point.fill(0)
  }
}

function cbcKey(shared: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(shared), 'AES-CBC', false, [usage])
}

/** `IV ‖ AES-256-CBC-PKCS7(shared, IV, plaintext)`: one `encryptedFor` ciphertext. */
async function cbcSeal(shared: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: bytes(iv) }, await cbcKey(shared, 'encrypt'), bytes(plaintext))
  return concat(iv, new Uint8Array(ct))
}

/** A letter's PR names its branches by their public `sha256`: each present hash names its branch. */
async function publicRefNamesMatch(doc: PrivateDoc, fields: DocFields): Promise<boolean> {
  for (const [hash, name] of [
    [doc.baseRefNameHash, fields.baseRefName],
    [doc.sourceRefNameHash, fields.sourceRefName],
  ] as const) {
    if (hash === undefined) continue
    if (name === undefined || !constantTimeEqual(await sha256(utf8(name)), hash)) return false
  }
  return true
}

/** Seals one slot plaintext to one recipient. */
type SlotSealer = (recipient: LetterRecipient, index: number, plaintext: Bytes) => Promise<Bytes>

/** Every intermediate of a seal; production keeps only `enc`. */
interface LetterSealed {
  readonly commit: Bytes
  readonly head: Bytes
  readonly ad: Bytes
  readonly tlv: Bytes
  readonly enc: Bytes
}

async function sealWith(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  doc: PrivateDoc,
  fields: DocFields,
  recipients: readonly LetterRecipient[],
  kObj: Uint8Array,
  nonce: Uint8Array,
  sealSlot: SlotSealer,
): Promise<LetterSealed> {
  const n = recipients.length
  if (doc.epoch !== 0 || !letterKind(doc.type)) throw new MalformedError('a letter is an issue, PR, comment, review or event under epoch 0')
  if (n < 1 || n > MAX_LETTER_RECIPIENTS) throw new MalformedError(`a letter has 1 to ${MAX_LETTER_RECIPIENTS} recipients`)
  const first = recipients[0] as LetterRecipient
  if (!bytesEqual(first.identityId, doc.ownerId) || !constantTimeEqual(first.publicKey, getPublicKey(senderSecret, true))) {
    throw new MalformedError('the sender is the first recipient')
  }
  for (let i = 1; i < n; i++) {
    if (recipients.slice(0, i).some((r) => bytesEqual(r.identityId, (recipients[i] as LetterRecipient).identityId))) {
      throw new MalformedError('a recipient is listed twice')
    }
  }
  if (nonce.length !== NONCE_LEN) throw new RangeError('a nonce is 12 bytes')
  const records = buildTlv(fields, { type: doc.type, epoch: 0 })
  if (!(await publicRefNamesMatch(doc, fields))) throw new MalformedError('a ref name does not match its hash')
  const body = concat(records, encodeRecipients(recipients.map((r) => r.identityId)))
  records.fill(0)
  const room = maxLetterPlaintext(doc.type, n)
  if (body.length > room) throw new TooLargeError(room)
  const tlv = padded(doc.type, body, room)
  body.fill(0)
  const obj = await objKeys(repoId, kObj)
  const slotPlaintext = concat(new Uint8Array([SLOT_VERSION]), obj.commit.subarray(0, 14), kObj)
  const slots: Bytes[] = []
  try {
    for (const [i, r] of recipients.entries()) {
      const slot = await sealSlot(r, i, slotPlaintext)
      if (slot.length !== LETTER_SLOT_LEN) throw new RangeError('a slot is 64 bytes')
      slots.push(slot)
    }
  } finally {
    slotPlaintext.fill(0)
  }
  const head = concat(new Uint8Array([n]), u32(senderKeyId), obj.commit, ...slots)
  const ad = concat(docAdWithoutKeys(doc, repoId, V4), await sha256(head))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(nonce), additionalData: ad }, obj.docKey, tlv)
  return { commit: obj.commit, head, ad, tlv, enc: concat(new Uint8Array([V4]), head, nonce, new Uint8Array(ct)) }
}

/**
 * Seal `fields` as a specific-people letter from this identity's ENCRYPTION key `senderSecret`
 * (key id `senderKeyId`) in the repository `repoId`. `recipients` is the slot order: the first is
 * the sender itself (identity `doc.ownerId`, `senderSecret`'s public key) and no identity appears
 * twice; each other key is that identity's highest-id usable ENCRYPTION key
 * (`usableEncryptionKey`). Draws a fresh `K_obj`, a random nonce and a random IV per slot.
 * `doc.epoch` must be 0 (D20). Throws {@link MalformedError} and {@link TooLargeError}.
 */
export async function sealLetter(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  doc: PrivateDoc,
  fields: DocFields,
  recipients: readonly LetterRecipient[],
): Promise<Bytes> {
  const kObj = randomBytes(32)
  try {
    const sealed = await sealWith(repoId, senderSecret, senderKeyId, doc, fields, recipients, kObj, randomBytes(NONCE_LEN), async (r, _i, pt) => {
      const shared = await letterSharedKey(senderSecret, r.publicKey)
      try {
        return await cbcSeal(shared, randomBytes(16), pt)
      } finally {
        shared.fill(0)
      }
    })
    sealed.tlv.fill(0)
    return sealed.enc
  } finally {
    kObj.fill(0)
  }
}

/**
 * INTERNAL, TEST-ONLY: {@link sealLetter} with a caller-chosen `K_obj`, nonce and slot IVs, for
 * the `named_envelope__*` vectors. Only `lib/private/testing.ts` may import it.
 */
export function __unsafeSealLetterWith(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  doc: PrivateDoc,
  fields: DocFields,
  recipients: readonly LetterRecipient[],
  kObj: Uint8Array,
  nonce: Uint8Array,
  ivs: readonly Uint8Array[],
): Promise<LetterSealed> {
  if (ivs.length !== recipients.length) throw new RangeError('one IV per recipient')
  return sealWith(repoId, senderSecret, senderKeyId, doc, fields, recipients, kObj, nonce, async (r, i, pt) =>
    cbcSeal(await letterSharedKey(senderSecret, r.publicKey), ivs[i] as Uint8Array, pt),
  )
}

/** The sender's public key under the reader rule, or undefined (malformed). */
function senderKey(ownerKeys: readonly OwnerKey[], senderKeyId: number): Uint8Array | undefined {
  const k = ownerKeys.find((o) => o.id === senderKeyId)
  return k !== undefined && k.purpose === PURPOSE_ENCRYPTION && k.keyType === KEY_TYPE_ECDSA_SECP256K1 ? k.data : undefined
}

/**
 * The slot of the block `n ‖ senderKeyId ‖ COMMIT_obj ‖ slots` that opens under one of
 * `secrets` with `senderPublic`, with its keys; `null` when none does; `undefined` when the
 * sender key is not a valid point (malformed).
 */
async function findSlot(
  repoId: Uint8Array,
  block: Uint8Array,
  n: number,
  senderPublic: Uint8Array,
  secrets: readonly Uint8Array[],
): Promise<{ slot: number; obj: ObjKeys } | null | undefined> {
  const commit = block.subarray(5, 37)
  for (const secret of secrets) {
    let shared: Bytes
    try {
      shared = await letterSharedKey(secret, senderPublic)
    } catch {
      return undefined
    }
    const key = await cbcKey(shared, 'decrypt')
    shared.fill(0)
    for (let i = 0; i < n; i++) {
      const slot = block.subarray(37 + LETTER_SLOT_LEN * i, 37 + LETTER_SLOT_LEN * (i + 1))
      let pt: Uint8Array
      try {
        pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: bytes(slot.slice(0, 16)) }, key, bytes(slot.slice(16))))
      } catch {
        continue // a padding failure: not this slot
      }
      try {
        if (pt.length !== SLOT_PLAINTEXT_LEN || pt[0] !== SLOT_VERSION || !constantTimeEqual(pt.subarray(1, 15), commit.subarray(0, 14))) continue
        const obj = await objKeys(repoId, pt.subarray(15))
        if (constantTimeEqual(obj.commit, commit)) return { slot: i, obj }
      } finally {
        pt.fill(0)
      }
    }
  }
  return null
}

/**
 * Open the letter `doc.enc` in the repository `repoId` as `reader`, with the document owner's
 * keys `ownerKeys` (the reader rule in the module docs).
 */
export async function openLetter(
  repoId: Uint8Array,
  doc: StoredPrivateDoc,
  ownerKeys: readonly OwnerKey[],
  reader: LetterReader,
): Promise<LetterOpenResult> {
  const enc = doc.enc
  if (!letterFramed(doc, enc)) return MALFORMED
  const n = enc[1] as number
  const senderPublic = senderKey(ownerKeys, new DataView(enc.buffer, enc.byteOffset).getUint32(2))
  if (senderPublic === undefined) return MALFORMED
  const headEnd = HEAD_LEN + LETTER_SLOT_LEN * n
  const head = enc.subarray(1, headEnd)
  const found = await findSlot(repoId, head, n, senderPublic, reader.secrets)
  if (found === undefined) return MALFORMED
  if (found === null) return { status: 'unreadable', reason: 'notARecipient' }
  let ad: Bytes
  try {
    ad = concat(docAdWithoutKeys(doc, repoId, V4), await sha256(head))
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  }
  let pt: Uint8Array
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(enc.slice(headEnd, headEnd + NONCE_LEN)), additionalData: ad },
        found.obj.docKey,
        bytes(enc.slice(headEnd + NONCE_LEN)),
      ),
    )
  } catch {
    return { status: 'unreadable', reason: 'badTag' }
  }
  let parsed: { fields: DocFields; recipients: Uint8Array[] }
  try {
    parsed = parseLetterTlv(pt, doc.type)
  } catch (e) {
    if (e instanceof MalformedError) return MALFORMED
    throw e
  } finally {
    pt.fill(0)
  }
  const mine = parsed.recipients[found.slot]
  if (parsed.recipients.length !== n || mine === undefined || !bytesEqual(mine, reader.identityId)) return MALFORMED
  if (!(await publicRefNamesMatch(doc, parsed.fields))) return MALFORMED
  return { status: 'readable', fields: parsed.fields, recipients: parsed.recipients, slot: found.slot }
}
