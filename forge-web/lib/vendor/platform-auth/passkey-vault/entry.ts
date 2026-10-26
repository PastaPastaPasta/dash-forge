// Sealing and opening one vault entry (Yappr docs/PASSKEY_VAULT.md §3; govhub vault/bundle.ts), parameterised by a profile:
//
//   PRF input  UTF8(prfLabel) ‖ contractId
//   recipient  (skR, pkR) = HPKE DeriveKeyPair(prfOutput)        pkR is the entry's `recipientKey`
//   info       UTF8(infoLabel) ‖ 0x00 ‖ contractId ‖ ownerId
//   AAD        UTF8(aadDocType) ‖ 0x00 ‖ u8 version ‖ u8 len(credentialId) ‖ credentialId ‖ recipientKey ‖ u32be authKeyId
//
// HPKE has no sender authentication: anyone can seal to a public recipient key, and anyone who once held a live key of the owner
// can write an entry. An opened bundle proves nothing until the app checks it against the owner's keys read with proofs.
import { bytesEqual, concatBytes, isU32, u32be, wipe } from './bytes'
import type { BundleCodec } from './codecs'
import { need, VaultCryptoError } from './errors'
import { deriveKeyPair, openBase, sealBase, type HpkeKeyPair } from './hpke'
import { TAG_LENGTH, type VaultProfile } from './profile'

export const MIN_CREDENTIAL_ID_LENGTH = 16
export const MAX_CREDENTIAL_ID_LENGTH = 255

/** The fields of an entry the crypto binds, plus the HPKE output. Mirrors the on-chain document. */
export interface SealedVaultEntry {
  version: number
  credentialId: Uint8Array
  recipientKey: Uint8Array
  authKeyId: number
  enc: Uint8Array
  sealed: Uint8Array
}

export type EntryAadFields = Pick<SealedVaultEntry, 'version' | 'credentialId' | 'recipientKey' | 'authKeyId'>

const te = new TextEncoder()
const is32 = (b: Uint8Array) => b.length === 32

export const isCredentialIdLength = (length: number): boolean => length >= MIN_CREDENTIAL_ID_LENGTH && length <= MAX_CREDENTIAL_ID_LENGTH

export function prfInput(p: VaultProfile<unknown>, contractId: Uint8Array): Uint8Array {
  need(is32(contractId), 'the vault contract id must be 32 bytes')
  return concatBytes(te.encode(p.prfLabel), contractId)
}

export function recipientFromPrf(prfOutput: Uint8Array): HpkeKeyPair {
  need(is32(prfOutput), 'the PRF output must be 32 bytes')
  return deriveKeyPair(prfOutput)
}

export function hpkeInfo(p: VaultProfile<unknown>, contractId: Uint8Array, ownerId: Uint8Array): Uint8Array {
  need(is32(contractId) && is32(ownerId), 'the contract and owner ids must be 32 bytes')
  return concatBytes(te.encode(p.infoLabel), Uint8Array.of(0), contractId, ownerId)
}

export function entryAad(p: VaultProfile<unknown>, e: EntryAadFields): Uint8Array {
  need(Number.isInteger(e.version) && e.version >= 1 && e.version <= 255, 'the entry version is out of range')
  need(isCredentialIdLength(e.credentialId.length), 'the credential id must be 16 to 255 bytes')
  need(is32(e.recipientKey), 'the recipient key must be 32 bytes')
  need(isU32(e.authKeyId), 'the key id is out of range')
  return concatBytes(
    te.encode(p.aadDocType),
    Uint8Array.of(0, e.version, e.credentialId.length),
    e.credentialId,
    e.recipientKey,
    u32be(e.authKeyId),
  )
}

export interface SealEntryInput<B> {
  contractId: Uint8Array
  ownerId: Uint8Array
  credentialId: Uint8Array
  recipientKey: Uint8Array
  bundle: B
  /** One of the profile's formats. */
  codec: BundleCodec<B>
  /** Required when the codec has no `authKeyIdOf`; must agree with it when it has. */
  authKeyId?: number
  /** Test vectors only: fixes the HPKE ephemeral key. */
  ephemeralIkm?: Uint8Array
}

/** Seals `bundle` to a passkey's recipient key. Needs no passkey ceremony. Does not wipe the bundle (the caller owns it). */
export function sealEntry<B>(p: VaultProfile<unknown>, o: SealEntryInput<B>): SealedVaultEntry {
  need(p.formats.includes(o.codec), "the codec is not one of the profile's formats")
  const implied = o.codec.authKeyIdOf?.(o.bundle)
  const authKeyId = o.authKeyId ?? implied
  need(authKeyId !== undefined, 'the entry needs a key id')
  need(implied === undefined || implied === authKeyId, "slot 0 is not the entry's key")
  const fields: EntryAadFields = { version: p.entryVersion, credentialId: o.credentialId, recipientKey: o.recipientKey, authKeyId }
  const aad = entryAad(p, fields)
  const info = hpkeInfo(p, o.contractId, o.ownerId)
  const plaintext = o.codec.encode(o.bundle)
  try {
    need(plaintext.length === o.codec.length && plaintext[0] === o.codec.id, 'the codec wrote a bundle of the wrong shape')
    const { enc, ciphertext } = sealBase(o.recipientKey, info, aad, plaintext, o.ephemeralIkm)
    return { ...fields, credentialId: o.credentialId.slice(), recipientKey: o.recipientKey.slice(), enc, sealed: ciphertext }
  } finally {
    wipe(plaintext)
  }
}

export interface OpenEntryInput {
  contractId: Uint8Array
  ownerId: Uint8Array
  entry: SealedVaultEntry
  prfOutput: Uint8Array
}

export interface OpenedBundle<B> {
  codec: BundleCodec<B>
  bundle: B
}

/**
 * Opens an entry with its passkey's PRF output. In order: the version, the encapsulated key's and the ciphertext's lengths (a length
 * no format has is refused before any work), the passkey (its derived key must be the entry's `recipientKey`, before decrypting),
 * the tag, the format byte, then the codec's rules. Wipes the derived secret key and the plaintext. Does not wipe `prfOutput`.
 */
export function openEntry<B>(p: VaultProfile<B>, o: OpenEntryInput): OpenedBundle<B> {
  const e = o.entry
  need(e.version === p.entryVersion, 'unknown entry version', 'version')
  need(is32(e.enc), "the entry's encapsulated key must be 32 bytes", 'format')
  // fields read from the chain: malformed ones are the entry's fault, not the caller's
  need(
    isCredentialIdLength(e.credentialId.length) && is32(e.recipientKey) && isU32(e.authKeyId),
    "the entry's credential id, recipient key or key id is malformed",
    'format',
  )
  const candidates = p.formats.filter((c) => c.length + TAG_LENGTH === e.sealed.length)
  need(candidates.length > 0, "the entry's ciphertext has the wrong length", 'format')
  need(!p.strictSealedLength || candidates.length === p.formats.length, "the profile's formats do not share one length")
  const info = hpkeInfo(p, o.contractId, o.ownerId)
  const aad = entryAad(p, e)
  const recipient = recipientFromPrf(o.prfOutput)
  try {
    need(bytesEqual(recipient.publicKey, e.recipientKey), 'this passkey does not open this entry', 'wrong-passkey')
    let plaintext: Uint8Array
    try {
      plaintext = openBase(e.enc, recipient.privateKey, info, aad, e.sealed)
    } catch (error) {
      if (error instanceof VaultCryptoError) throw error
      throw new VaultCryptoError('the entry does not decrypt', 'decrypt')
    }
    try {
      const codec = candidates.find((c) => c.id === plaintext[0])
      need(codec !== undefined, 'unknown bundle format', 'format')
      return { codec, bundle: codec.decode(plaintext, e.authKeyId) }
    } finally {
      wipe(plaintext)
    }
  } finally {
    wipe(recipient.privateKey)
  }
}
