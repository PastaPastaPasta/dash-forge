/**
 * TEST-ONLY deterministic seams for the §11 conformance vectors
 * (`docs/security/private-repos.md` §3.6: production seal APIs take no caller-supplied nonce
 * or `fileId`). Only tests import this module; `index.ts` does not re-export it, and no
 * production module may import it.
 */

import { concat, sha256, type Bytes } from './bytes'
import { prepareDocSeal, type PrivateDoc, type SealDocOptions } from './doc'
import { hedgeFileId, hedgeNonce, type EpochKeys } from './keys'
import { sealPackWith } from './pack'
import type { DocFields } from './tlv'

/** `sealDoc` with a fixed nonce; returns the AD and TLV too. */
export async function sealDocWithNonce(
  keys: EpochKeys,
  doc: PrivateDoc,
  fields: DocFields,
  nonce: Uint8Array,
  options: SealDocOptions = {},
): Promise<{ ad: Bytes; tlv: Bytes; enc: Bytes }> {
  if (nonce.length !== 12) throw new RangeError('a nonce is 12 bytes')
  const { ad, tlv, prefix } = await prepareDocSeal(keys, doc, fields, options)
  const iv = new Uint8Array(nonce)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, keys.docKey, tlv)
  return { ad, tlv, enc: concat(prefix, iv, new Uint8Array(ct)) }
}

/** `sealPack` with a fixed `fileId`. */
export function sealPackWithFileId(keys: EpochKeys, plain: Uint8Array, fileId: Uint8Array): Promise<Bytes> {
  return sealPackWith(keys, plain, fileId)
}

/** The hedged `fileId` for a given `rnd` (§3.6). */
export async function hedgedFileId(keys: EpochKeys, rnd: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  return hedgeFileId(keys, rnd, await sha256(plaintext))
}

/** The hedged document nonce for a given `rnd` (§3.6). */
export async function hedgedNonce(keys: EpochKeys, rnd: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  return hedgeNonce(keys, rnd, ad, await sha256(plaintext))
}
