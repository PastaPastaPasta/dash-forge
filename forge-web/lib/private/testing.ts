/**
 * TEST-ONLY deterministic seams for the §11 and §16.7 conformance vectors
 * (`docs/security/private-repos.md` §3.6: production seal APIs take no caller-supplied nonce
 * or `fileId`). `index.ts` does not re-export this module, and ESLint's
 * `no-restricted-imports` bans importing it anywhere but `*.test.ts`.
 */

import { sha256, utf8, type Bytes } from './bytes'
import { __unsafeSealDocWithNonce, __unsafeSealMembersDocWithNonce, type PrivateDoc, type SealDocOptions } from './doc'
import { hedgeFileId, hedgeNonce, type EpochKeys } from './keys'
import { __unsafeSealLetterArtifactWith, __unsafeSealLetterWith, type LetterRecipient } from './named'
import { __unsafeSealPackWithFileId } from './pack'
import { __unsafeSealReleaseWithNonce, encodeReleaseManifest, type ReleaseFields, type ReleaseManifest } from './release'
import type { DocFields } from './tlv'

/** `sealDoc` with a fixed nonce; returns the AD and TLV too. */
export function sealDocWithNonce(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  nonce: Uint8Array,
  options: SealDocOptions = {},
): Promise<{ ad: Bytes; tlv: Bytes; enc: Bytes }> {
  return __unsafeSealDocWithNonce(keys, doc, fields, nonce, options)
}

/** `sealMembersDoc` with a fixed nonce; returns the AD, raw `K_obj`, `COMMIT_obj` and padded TLV too. */
export function sealMembersDocWithNonce(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  nonce: Uint8Array,
): Promise<{ ad: Bytes; kObj: Bytes; commit: Bytes; tlv: Bytes; enc: Bytes }> {
  return __unsafeSealMembersDocWithNonce(keys, doc, fields, nonce)
}

/** `sealLetter` with a fixed `K_obj`, nonce and slot IVs; returns the commitment, H, AD' and TLV too. */
export function sealLetterWith(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  doc: PrivateDoc,
  fields: DocFields,
  recipients: readonly LetterRecipient[],
  kObj: Uint8Array,
  nonce: Uint8Array,
  ivs: readonly Uint8Array[],
): Promise<{ commit: Bytes; head: Bytes; ad: Bytes; tlv: Bytes; enc: Bytes }> {
  return __unsafeSealLetterWith(repoId, senderSecret, senderKeyId, doc, fields, recipients, kObj, nonce, ivs)
}

/** `sealLetterArtifact` with a fixed `K_obj`, `fileId` and slot IVs. */
export function sealLetterArtifactWith(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  ownerId: Uint8Array,
  recipients: readonly LetterRecipient[],
  plaintext: Uint8Array,
  kObj: Uint8Array,
  fileId: Uint8Array,
  ivs: readonly Uint8Array[],
): Promise<Bytes> {
  return __unsafeSealLetterArtifactWith(repoId, senderSecret, senderKeyId, ownerId, recipients, plaintext, kObj, fileId, ivs)
}

/** `sealPack` with a fixed `fileId`. */
export function sealPackWithFileId(keys: EpochKeys, plain: Uint8Array, fileId: Uint8Array): Promise<Bytes> {
  return __unsafeSealPackWithFileId(keys, plain, fileId)
}

/** The hedged `fileId` for a given `rnd` (§3.6). */
export async function hedgedFileId(keys: EpochKeys, rnd: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  return hedgeFileId(keys, rnd, await sha256(plaintext))
}

/** The hedged document nonce for a given `rnd` (§3.6). */
export async function hedgedNonce(keys: EpochKeys, rnd: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  return hedgeNonce(keys, rnd, ad, await sha256(plaintext))
}

/** `sealRelease` with a fixed nonce; returns the tag hash, AD and padded TLV too. */
export function sealReleaseWithNonce(
  keys: EpochKeys,
  ownerId: Uint8Array,
  fields: ReleaseFields,
  nonce: Uint8Array,
): Promise<{ tagName: string; tagHash: Bytes; ad: Bytes; tlv: Bytes; enc: Bytes }> {
  return __unsafeSealReleaseWithNonce(keys, ownerId, fields, nonce)
}

/** `sealReleaseManifest` with a fixed `fileId`. */
export async function sealReleaseManifestWithFileId(
  keys: EpochKeys,
  manifest: ReleaseManifest,
  fileId: Uint8Array,
): Promise<{ canonical: string; sealed: Bytes }> {
  const canonical = encodeReleaseManifest(manifest)
  return { canonical, sealed: await __unsafeSealPackWithFileId(keys, utf8(canonical), fileId) }
}
