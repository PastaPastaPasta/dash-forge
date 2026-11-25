/**
 * forge-user sync crypto (docs/design/identity-synced-state.md §4). The normative definitions are
 * `tools/user-sync-vectors/gen.py` and `forge-contracts/fixtures/user-sync/vectors.json`; the test
 * reproduces every value there. AES-256-GCM and HKDF-SHA256 are WebCrypto, ECDH is secp256k1 (the
 * x coordinate), compression is raw DEFLATE.
 */

import * as secp from '@noble/secp256k1'
import { concatBytes as concat } from '@noble/hashes/utils.js'
import { deflateSync } from 'fflate'
import { Inflate } from 'pako'

export const FORMAT_VERSION = 1
/** The size of one `d<i>` piece. */
export const PIECE_BYTES = 5000
/** `state` holds `d0`..`d2`, `share` `d0`..`d1`. */
export const STATE_PIECES = 3
export const SHARE_PIECES = 2
export const NONCE_BYTES = 12
export const WRAPPED_BYTES = 60
/** The most a decrypted document may inflate to. */
export const MAX_PLAINTEXT_BYTES = 1 << 20

const te = new TextEncoder()

function u32(x: number): Uint8Array {
  if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new Error(`not a u32: ${x}`)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, x, false)
  return out
}

function lp(s: string): Uint8Array {
  const b = te.encode(s)
  if (b.length > 255) throw new Error('length-prefixed string over 255 bytes')
  return concat(Uint8Array.of(b.length), b)
}

function id32(id: Uint8Array): Uint8Array {
  if (id.length !== 32) throw new Error('an id is 32 bytes')
  return id
}

function ab(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b)
}

export async function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) }, key, 256)
  return new Uint8Array(bits)
}

async function aes(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('an AES-256 key is 32 bytes')
  return crypto.subtle.importKey('raw', ab(key), { name: 'AES-GCM' }, false, [usage])
}

export async function sealGcm(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== NONCE_BYTES) throw new Error('a nonce is 12 bytes')
  const k = await aes(key, 'encrypt')
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, k, ab(plain)))
}

/** Thrown for any ciphertext that does not open (wrong key, AAD, or tampered). */
export class SyncDecryptError extends Error {
  constructor(what: string) {
    super(`${what} does not open with this key`)
    this.name = 'SyncDecryptError'
  }
}

export async function openGcm(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: Uint8Array, what = 'the synced settings'): Promise<Uint8Array> {
  const k = await aes(key, 'decrypt')
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, k, ab(ct)))
  } catch {
    throw new SyncDecryptError(what)
  }
}

export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
}

/** JSON with object keys sorted at every level and no whitespace (gen.py's `sort_keys=True`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function deflateRaw(bytes: Uint8Array): Uint8Array {
  return deflateSync(bytes, { level: 9 })
}

/** Raw-DEFLATE inflate that stops past `max` bytes (a bomb costs at most that). */
export function inflateRaw(bytes: Uint8Array, max = MAX_PLAINTEXT_BYTES): Uint8Array {
  const chunks: Uint8Array[] = []
  let got = 0
  const inflater = new Inflate({ raw: true, chunkSize: 16 * 1024 })
  inflater.onData = (chunk: Uint8Array) => {
    got += chunk.length
    if (got > max) throw new Error('the synced settings inflate past the size limit')
    chunks.push(chunk)
  }
  inflater.onEnd = () => {}
  inflater.push(bytes, true)
  if (inflater.err !== 0 || !(inflater as unknown as { ended?: boolean }).ended) throw new Error('the synced settings are not valid DEFLATE')
  return concat(...chunks)
}

export function encodePlain(value: unknown): Uint8Array {
  return deflateRaw(te.encode(canonicalJson(value)))
}

export function decodePlain(compressed: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inflateRaw(compressed))) as unknown
}

/** Ciphertext split into `PIECE_BYTES` pieces; throws when it needs more than `max`. */
export function splitPieces(ct: Uint8Array, max: number): Uint8Array[] {
  if (ct.length > PIECE_BYTES * max) throw new SyncTooLargeError(ct.length, PIECE_BYTES * max)
  const out: Uint8Array[] = []
  for (let at = 0; at < ct.length; at += PIECE_BYTES) out.push(ct.slice(at, at + PIECE_BYTES))
  return out
}

export class SyncTooLargeError extends Error {
  constructor(readonly bytes: number, readonly max: number) {
    super(`the synced settings take ${bytes} bytes encrypted, over the ${max}-byte limit`)
    this.name = 'SyncTooLargeError'
  }
}

// --- state ---------------------------------------------------------------------------------

export function stateKey(E: Uint8Array, identityId: Uint8Array, network: string, slot: string): Promise<Uint8Array> {
  return hkdf32(E, id32(identityId), te.encode(`forge-user/v1/state/${network}/${slot}`))
}

export function stateAad(network: string, identityId: Uint8Array, slot: string, v: number, keyId: number): Uint8Array {
  return concat(te.encode('forge-user/v1'), lp(network), id32(identityId), lp(slot), Uint8Array.of(v), u32(keyId))
}

/** The encrypted fields of a `state` document. */
export interface StateFields {
  readonly slot: string
  readonly v: number
  readonly keyId: number
  readonly n: Uint8Array
  readonly d0: Uint8Array
  readonly d1?: Uint8Array
  readonly d2?: Uint8Array
}

export interface StateContext {
  readonly E: Uint8Array
  readonly keyId: number
  readonly identityId: Uint8Array
  readonly network: string
}

export async function sealStateBytes(ctx: StateContext, slot: string, compressed: Uint8Array, nonce: Uint8Array = randomNonce()): Promise<StateFields> {
  const key = await stateKey(ctx.E, ctx.identityId, ctx.network, slot)
  try {
    const ct = await sealGcm(key, nonce, compressed, stateAad(ctx.network, ctx.identityId, slot, FORMAT_VERSION, ctx.keyId))
    const [d0, d1, d2] = splitPieces(ct, STATE_PIECES)
    return { slot, v: FORMAT_VERSION, keyId: ctx.keyId, n: nonce, d0: d0!, ...(d1 ? { d1 } : {}), ...(d2 ? { d2 } : {}) }
  } finally {
    key.fill(0)
  }
}

export function sealState(ctx: StateContext, slot: string, value: unknown, nonce?: Uint8Array): Promise<StateFields> {
  return sealStateBytes(ctx, slot, encodePlain(value), nonce)
}

/** The compressed plaintext of a `state` document; its `keyId` must be `ctx.keyId`. */
export async function openStateBytes(ctx: StateContext, doc: StateFields): Promise<Uint8Array> {
  if (doc.v !== FORMAT_VERSION) throw new Error(`synced settings format ${doc.v} is newer than this app`)
  if (doc.keyId !== ctx.keyId) throw new SyncDecryptError('the synced settings (written with another key)')
  const key = await stateKey(ctx.E, ctx.identityId, ctx.network, doc.slot)
  try {
    const ct = concat(...[doc.d0, doc.d1, doc.d2].filter((d) => d !== undefined))
    return await openGcm(key, doc.n, ct, stateAad(ctx.network, ctx.identityId, doc.slot, doc.v, doc.keyId))
  } finally {
    key.fill(0)
  }
}

export async function openState(ctx: StateContext, doc: StateFields): Promise<unknown> {
  return decodePlain(await openStateBytes(ctx, doc))
}

// --- repo storage key, share ------------------------------------------------------------------

export function repoStorageKey(E: Uint8Array, repoId: Uint8Array, network: string, epoch: number): Promise<Uint8Array> {
  return hkdf32(E, id32(repoId), concat(te.encode(`forge-user/v1/repo-storage/${network}/`), u32(epoch)))
}

export function shareAad(network: string, repoId: Uint8Array, epoch: number, keyId: number): Uint8Array {
  return concat(te.encode('forge-user/v1/share'), lp(network), id32(repoId), u32(epoch), u32(keyId))
}

export interface ShareFields {
  readonly epoch: number
  readonly keyId: number
  readonly n: Uint8Array
  readonly d0: Uint8Array
  readonly d1?: Uint8Array
}

export interface ShareParams {
  readonly network: string
  readonly repoId: Uint8Array
  readonly epoch: number
  readonly keyId: number
}

export async function sealShareBytes(
  rsk: Uint8Array,
  p: ShareParams,
  compressed: Uint8Array,
  nonce: Uint8Array = randomNonce(),
): Promise<ShareFields> {
  const ct = await sealGcm(rsk, nonce, compressed, shareAad(p.network, p.repoId, p.epoch, p.keyId))
  const [d0, d1] = splitPieces(ct, SHARE_PIECES)
  return { epoch: p.epoch, keyId: p.keyId, n: nonce, d0: d0!, ...(d1 ? { d1 } : {}) }
}

export function sealShare(rsk: Uint8Array, p: ShareParams, value: unknown, nonce?: Uint8Array): Promise<ShareFields> {
  return sealShareBytes(rsk, p, encodePlain(value), nonce)
}

export async function openShareBytes(rsk: Uint8Array, p: { readonly network: string; readonly repoId: Uint8Array }, doc: ShareFields): Promise<Uint8Array> {
  const ct = concat(...[doc.d0, doc.d1].filter((d) => d !== undefined))
  return openGcm(rsk, doc.n, ct, shareAad(p.network, p.repoId, doc.epoch, doc.keyId), "the repository's shared storage")
}

export async function openShare(rsk: Uint8Array, p: { readonly network: string; readonly repoId: Uint8Array }, doc: ShareFields): Promise<unknown> {
  return decodePlain(await openShareBytes(rsk, p, doc))
}

// --- grant ------------------------------------------------------------------------------------

/** secp256k1 ECDH: the x coordinate of `priv · pub`. */
export function ecdhX(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return secp.getSharedSecret(priv, pub, true).slice(1)
}

export interface GrantParams {
  readonly network: string
  readonly ownerId: Uint8Array
  readonly repoId: Uint8Array
  readonly memberId: Uint8Array
  readonly epoch: number
  readonly senderKeyId: number
  readonly recipientKeyId: number
}

export function grantWrapKey(shared: Uint8Array, p: GrantParams): Promise<Uint8Array> {
  return hkdf32(
    shared,
    id32(p.repoId),
    concat(te.encode('forge-user/v1/grant/'), lp(p.network), id32(p.memberId), u32(p.epoch), u32(p.senderKeyId), u32(p.recipientKeyId)),
  )
}

/** `nonce ‖ AES-GCM(W, rsk, AAD = ownerId)`, 60 bytes; `E_owner` with the member's public key. */
export async function wrapGrant(ownerE: Uint8Array, memberPub: Uint8Array, p: GrantParams, rsk: Uint8Array, nonce: Uint8Array = randomNonce()): Promise<Uint8Array> {
  const shared = ecdhX(ownerE, memberPub)
  const w = await grantWrapKey(shared, p)
  try {
    return concat(nonce, await sealGcm(w, nonce, rsk, id32(p.ownerId)))
  } finally {
    shared.fill(0)
    w.fill(0)
  }
}

/** The repo storage key a grant wraps; `E_member` with the owner's public key. */
export async function unwrapGrant(memberE: Uint8Array, ownerPub: Uint8Array, p: GrantParams, wrapped: Uint8Array): Promise<Uint8Array> {
  if (wrapped.length !== WRAPPED_BYTES) throw new SyncDecryptError('the storage grant')
  const shared = ecdhX(memberE, ownerPub)
  const w = await grantWrapKey(shared, p)
  try {
    const rsk = await openGcm(w, wrapped.subarray(0, NONCE_BYTES), wrapped.subarray(NONCE_BYTES), id32(p.ownerId), 'the storage grant')
    if (rsk.length !== 32) throw new SyncDecryptError('the storage grant')
    return rsk
  } finally {
    shared.fill(0)
    w.fill(0)
  }
}
