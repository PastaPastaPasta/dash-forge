/**
 * TEST-ONLY deterministic seams for the §11 conformance vectors
 * (`docs/security/private-repos.md` §3.6: production seal APIs take no caller-supplied nonce
 * or `fileId`). `index.ts` does not re-export this module, and ESLint's
 * `no-restricted-imports` bans importing it anywhere but `*.test.ts`.
 */

import { sha256, type Bytes } from './bytes'
import { __unsafeSealDocWithNonce, type PrivateDoc, type SealDocOptions } from './doc'
import { hedgeFileId, hedgeNonce, type EpochKeys } from './keys'
import { __unsafeSealPackWithFileId } from './pack'
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
