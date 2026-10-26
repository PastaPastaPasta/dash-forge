// A vault profile: the labels and formats that make one app's entries its own. Changing any field orphans every stored entry, so an
// app defines its profile once, pins it with test vectors, and never edits it (a new layout is a new codec id or a new profile).
import type { BundleCodec } from './codecs'
import { need } from './errors'

export interface VaultProfile<B = unknown> {
  /** PRF `first` input = UTF8(prfLabel) ‖ contractId. */
  readonly prfLabel: string
  /** HPKE info = UTF8(infoLabel) ‖ 0x00 ‖ contractId ‖ ownerId. */
  readonly infoLabel: string
  /** AAD = UTF8(aadDocType) ‖ 0x00 ‖ u8 version ‖ u8 len(credentialId) ‖ credentialId ‖ recipientKey ‖ u32be authKeyId. */
  readonly aadDocType: string
  readonly entryVersion: 1
  /** The formats the vault seals and opens; ids must be unique. */
  readonly formats: readonly BundleCodec<B>[]
  /**
   * Every format pads to one length, so every entry has the same sealed size whatever it holds, and opening refuses any other
   * length before the passkey check (govhub, Forge). When false, formats may have different lengths (Yappr: 80 and 160); opening
   * still refuses a length that is no format's before decrypting.
   */
  readonly strictSealedLength: boolean
}

/** AEAD tag length (ChaCha20-Poly1305). */
export const TAG_LENGTH = 16

const printableAscii = (s: string) => s.length > 0 && s.length <= 128 && /^[\x21-\x7e]+$/.test(s)

/** Checks a profile's invariants and freezes it. Throws on a profile that could never open its own entries. */
export function defineProfile<B>(p: VaultProfile<B>): VaultProfile<B> {
  need(printableAscii(p.prfLabel) && printableAscii(p.infoLabel) && printableAscii(p.aadDocType), 'profile labels must be printable ASCII without spaces')
  need(p.prfLabel !== p.infoLabel, 'the PRF and HPKE labels must differ')
  need(p.entryVersion === 1, 'only entry version 1 exists')
  need(p.formats.length >= 1, 'a profile needs at least one format')
  need(new Set(p.formats.map((c) => c.id)).size === p.formats.length, 'format ids must be unique')
  if (p.strictSealedLength) need(new Set(p.formats.map((c) => c.length)).size === 1, 'a strict profile pads every format to one length')
  return Object.freeze({ ...p, formats: Object.freeze([...p.formats]) })
}

/** The sealed lengths a profile accepts. */
export const sealedLengths = (p: VaultProfile<unknown>): number[] => [...new Set(p.formats.map((c) => c.length + TAG_LENGTH))]
