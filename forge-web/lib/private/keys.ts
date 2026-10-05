/**
 * The key hierarchy of a private repository, `docs/security/private-repos.md` §2.
 *
 * `K_e` is imported once as a non-extractable WebCrypto HKDF key with `salt = repoId`, which
 * makes WebCrypto's HKDF (Extract then Expand) equal to the spec's
 * `HKDF-Expand(PRK_e = HMAC(repoId, K_e), info)`. Every subkey is derived from it with
 * `deriveKey` as a non-extractable AES-GCM or HMAC key; only `KCV_e` and `COMMIT_e`, which are
 * compared as bytes, go through `deriveBits`.
 */

import { bytes, concat, isU32, randomBytes, sha256, utf8, u32, wipe, type Bytes } from './bytes'

/** `"dash-forge/v2/" ‖ label ‖ 0x00 ‖ u32(e) ‖ x`. */
export function subkeyInfo(label: string, epoch: number, x: Uint8Array = new Uint8Array(0)): Bytes {
  return concat(utf8(`dash-forge/v2/${label}`), new Uint8Array([0]), u32(epoch), x)
}

/** The pack header version, part of the pack key's domain string (§3.3). */
export const PACK_VERSION = 0x01

const HMAC_256 = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const
const AES_256 = { name: 'AES-GCM', length: 256 } as const

/** The subkeys of one epoch key of one repository. Nothing here is extractable. */
export class EpochKeys {
  private constructor(
    readonly repoId: Bytes,
    readonly epoch: number,
    private readonly base: CryptoKey,
    /** `K_doc,e`: AES-256-GCM for document `enc` fields (§4). */
    readonly docKey: CryptoKey,
    /** `K_ref,e`: HMAC-SHA256 for ref-name hashes (§4.5). */
    readonly refKey: CryptoKey,
    /** `K_tag,e`: HMAC-SHA256 for sealed release `tagName`s (§16.1). */
    readonly tagKey: CryptoKey,
    /** `K_hedge,e`: HMAC-SHA256 hedging the RNG for nonces and file ids (§3.6). */
    readonly hedgeKey: CryptoKey,
    /** `KCV_e`, 14 bytes: error detection for wraps (§5.1). */
    readonly kcv: Bytes,
    /** `COMMIT_e`, 32 bytes: the key commitment anchors carry (§4.2). */
    readonly commit: Bytes,
  ) {}

  /**
   * Import the 32-byte epoch key `raw` of `repoId`'s epoch `epoch`. The caller keeps `raw`;
   * {@link importEpochKeyAndWipe} erases it after the import.
   */
  static async import(repoId: Uint8Array, epoch: number, raw: Uint8Array): Promise<EpochKeys> {
    if (repoId.length !== 32) throw new RangeError('repoId must be 32 bytes')
    if (raw.length !== 32) throw new RangeError('an epoch key is 32 bytes')
    if (!isU32(epoch)) throw new RangeError('epoch must be a u32')
    const salt = new Uint8Array(repoId)
    const base = await crypto.subtle.importKey('raw', bytes(raw), 'HKDF', false, [
      'deriveKey',
      'deriveBits',
    ])
    const params = (label: string): HkdfParams => ({
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: subkeyInfo(label, epoch),
    })
    const [docKey, refKey, tagKey, hedgeKey, kcvBits, commitBits] = await Promise.all([
      crypto.subtle.deriveKey(params('doc'), base, AES_256, false, ['encrypt', 'decrypt']),
      crypto.subtle.deriveKey(params('ref'), base, HMAC_256, false, ['sign']),
      crypto.subtle.deriveKey(params('tag'), base, HMAC_256, false, ['sign']),
      crypto.subtle.deriveKey(params('hedge'), base, HMAC_256, false, ['sign']),
      crypto.subtle.deriveBits(params('kcv'), base, 256),
      crypto.subtle.deriveBits(params('commit'), base, 256),
    ])
    return new EpochKeys(
      salt,
      epoch,
      base,
      docKey,
      refKey,
      tagKey,
      hedgeKey,
      new Uint8Array(kcvBits, 0, 14).slice(),
      new Uint8Array(commitBits),
    )
  }

  /**
   * `K_obj = HKDF-Expand(PRK_e, "dash-forge/v2/obj" ‖ 0x00 ‖ u32(e) ‖ nonce ‖ SHA-256(AD), 32)`:
   * the raw per-object key of a members (`enc` v0x03) document, bound to its nonce and AD (§4.1).
   * Raw because the next step re-imports it ({@link objKeys}); the caller wipes it.
   */
  async objKey(nonce: Uint8Array, ad: Uint8Array): Promise<Bytes> {
    if (nonce.length !== 12) throw new RangeError('a nonce is 12 bytes')
    const info = subkeyInfo('obj', this.epoch, concat(nonce, await sha256(ad)))
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: this.repoId, info }, this.base, 256)
    return new Uint8Array(bits)
  }

  /** `K_pack,e,fileId`: the AES-256-GCM key of one sealed artifact (§3.3). */
  packKey(fileId: Uint8Array): Promise<CryptoKey> {
    if (fileId.length !== 16) throw new RangeError('fileId must be 16 bytes')
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: this.repoId,
        info: subkeyInfo('pack', this.epoch, concat(new Uint8Array([PACK_VERSION]), fileId)),
      },
      this.base,
      AES_256,
      false,
      ['encrypt', 'decrypt'],
    )
  }
}

/** The keys a per-object key yields (§4.1): `K_doc,obj` (non-extractable AES-GCM) and `COMMIT_obj`. */
export interface ObjKeys {
  readonly docKey: CryptoKey
  readonly commit: Bytes
  /**
   * `K_pack,obj,fileId = HKDF-Expand(PRK_obj, "dash-forge/v2/obj-pack" ‖ 0x00 ‖ 0x02 ‖ fileId)`:
   * the key of a sealed artifact under a specific-people header (DFPK version 0x02, §3.2).
   */
  packKey(fileId: Uint8Array): Promise<CryptoKey>
}

/**
 * `PRK_obj = HKDF-Extract(repoId, K_obj)`; `K_doc,obj = HKDF-Expand(PRK_obj, "dash-forge/v2/obj-doc" ‖ 0x00)`;
 * `COMMIT_obj = HKDF-Expand(PRK_obj, "dash-forge/v2/obj-commit" ‖ 0x00)` (§4.1). `KCV_obj` is
 * `commit[0..14]`.
 */
export async function objKeys(repoId: Uint8Array, kObj: Uint8Array): Promise<ObjKeys> {
  if (repoId.length !== 32 || kObj.length !== 32) throw new RangeError('repoId and K_obj are 32 bytes')
  const base = await crypto.subtle.importKey('raw', bytes(kObj), 'HKDF', false, ['deriveKey', 'deriveBits'])
  const params = (label: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(repoId),
    info: concat(utf8(`dash-forge/v2/${label}`), new Uint8Array([0])),
  })
  const [docKey, commit] = await Promise.all([
    crypto.subtle.deriveKey(params('obj-doc'), base, AES_256, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveBits(params('obj-commit'), base, 256),
  ])
  const packKey = (fileId: Uint8Array): Promise<CryptoKey> => {
    if (fileId.length !== 16) throw new RangeError('fileId must be 16 bytes')
    const info = concat(utf8('dash-forge/v2/obj-pack'), new Uint8Array([0, 0x02]), fileId)
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(repoId), info }, base, AES_256, false, ['encrypt', 'decrypt'])
  }
  return { docKey, commit: new Uint8Array(commit), packKey }
}

/** {@link EpochKeys.import}, then erase `raw` (best effort; the caller must not reuse it). */
export async function importEpochKeyAndWipe(
  repoId: Uint8Array,
  epoch: number,
  raw: Uint8Array,
): Promise<EpochKeys> {
  try {
    return await EpochKeys.import(repoId, epoch, raw)
  } finally {
    wipe(raw)
  }
}

/** A fresh epoch key from the CSPRNG (§2.1). The caller journals it, wraps it, then wipes it. */
export function generateEpochKey(): Bytes {
  return randomBytes(32)
}

/** Readable epochs and their keys. */
export type EpochKeyring = ReadonlyMap<number, EpochKeys>

async function hmac(key: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(data)))
}

/** `refNameHash = HMAC-SHA256(K_ref,e, refName)` (§4.5). */
export function refNameHash(keys: EpochKeys, refName: string): Promise<Bytes> {
  return hmac(keys.refKey, utf8(refName))
}

/** `HMAC-SHA256(K_tag,e, tag)`: the 32 bytes behind a sealed release's `tagName` (§16.1). */
export function releaseTagHash(keys: EpochKeys, tag: string): Promise<Bytes> {
  return hmac(keys.tagKey, utf8(tag))
}

/** A sealed release's plaintext `tagName`: unpadded base64url of {@link releaseTagHash}, 43 characters (§16.1). */
export async function releaseTagName(keys: EpochKeys, tag: string): Promise<string> {
  return base64url(await releaseTagHash(keys, tag))
}

/** RFC 4648 §5 base64url, unpadded. */
function base64url(b: Uint8Array): string {
  let bin = ''
  for (const x of b) bin += String.fromCharCode(x)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** `fileId = HMAC-SHA256(K_hedge,e, 0x01 ‖ rnd ‖ SHA-256(plaintext))[0..16]` (§3.6). */
export async function hedgeFileId(keys: EpochKeys, rnd: Uint8Array, plaintextSha256: Uint8Array): Promise<Bytes> {
  const mac = await hmac(keys.hedgeKey, concat(new Uint8Array([0x01]), rnd, plaintextSha256))
  return mac.slice(0, 16)
}

/** `nonce = HMAC-SHA256(K_hedge,e, 0x02 ‖ rnd ‖ AD ‖ SHA-256(plaintext))[0..12]` (§3.6). */
export async function hedgeNonce(
  keys: EpochKeys,
  rnd: Uint8Array,
  ad: Uint8Array,
  plaintextSha256: Uint8Array,
): Promise<Bytes> {
  const mac = await hmac(keys.hedgeKey, concat(new Uint8Array([0x02]), rnd, ad, plaintextSha256))
  return mac.slice(0, 12)
}
