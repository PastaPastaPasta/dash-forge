/**
 * Check runs on members-only branches (`docs/security/private-repos.md` §19.9, mixed-visibility
 * DESIGN §4.3 "CI on a members branch").
 *
 * On a members-only branch a runner reports the commit's blind as `headOid`, an opaque check name
 * and its log sealed at `logUrl` (`logSha256` covers the sealed bytes):
 *
 *     K_name = HMAC-SHA256(salt, "dash-forge/v2/check-name")
 *     name'  = base32(HMAC-SHA256(K_name, 0x01 ‖ name))[0..16]         (RFC 4648, lower case)
 *     K_log  = HMAC-SHA256(K_name, 0x02 ‖ nonce)
 *     AD     = "DFCL" ‖ 0x01 ‖ u8(len(blind)) ‖ blind ‖ name'
 *     P      = u32(len(H)) ‖ H ‖ u64(len(log)) ‖ log ‖ 0x00 … (to a multiple of 4,096 bytes)
 *     H      = {"head":"<real commit hex>","name":"<check name>","v":1}   (exactly this form)
 *     sealed = "DFCL" ‖ 0x01 ‖ nonce(12) ‖ AES-256-GCM(K_log, nonce, P, AD)
 *
 * `salt` is the blind's salt (TLV 27), which members hold. A member resolves a run's name by
 * opening its log: the header's name must hash to the run's opaque name and its commit to the
 * run's blind. The Rust twin is `forge-core::private::members_check`; the `members_check`
 * vectors hold the two byte for byte (`members-check.conformance.test.ts`).
 */

import { blind as blindOf } from './blind'
import { bytes, bytesToHex, concat, constantTimeEqual, hexToBytes, randomBytes, u32, u64, utf8, type Bytes } from './bytes'

const MAGIC = utf8('DFCL')
const VERSION = 0x01
const PAD = 4096
const OVERHEAD = 4 + 1 + 12 + 16
const NAME_LABEL = utf8('dash-forge/v2/check-name')
/** `K_name`'s two uses, kept apart: an opaque name, a log key. */
const NAME_DOMAIN = new Uint8Array([0x01])
const LOG_DOMAIN = new Uint8Array([0x02])
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
/** The opaque name's length in base32 characters (80 bits). */
export const OPAQUE_NAME_LEN = 16

/** Why a sealed log does not open: `malformed`, or a later format (`unknownVersion`). */
export class CheckLogError extends Error {
  constructor(
    readonly kind: 'malformed' | 'unknownVersion',
    readonly version?: number,
  ) {
    super(kind === 'malformed' ? 'malformed check log' : `check log version ${version} is not one this client opens`)
  }
}

/** A sealed log, opened: the check's real name, the real commit (hex) and the log. */
export interface CheckLog {
  readonly name: string
  readonly head: string
  readonly log: Bytes
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(data)))
}

/** RFC 4648 base32, lower case, no padding. */
export function base32(data: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of data) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(acc >> bits) & 31]
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31]
  return out
}

/** Whether `name` has the shape of an opaque check name: 16 characters of `a`–`z` and `2`–`7`. */
export function isOpaqueName(name: string): boolean {
  return name.length === OPAQUE_NAME_LEN && [...name].every((c) => BASE32.includes(c))
}

function ad(blind: Uint8Array, opaque: string): Bytes {
  return concat(MAGIC, new Uint8Array([VERSION, blind.length]), blind, utf8(opaque))
}

async function aes(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** The keys of the check runs on one blinded commit, from the blind's salt. */
export class CheckKeys {
  private constructor(
    private readonly salt: Bytes,
    private readonly nameKey: Bytes,
  ) {}

  static async of(salt: Uint8Array): Promise<CheckKeys> {
    return new CheckKeys(bytes(new Uint8Array(salt)), await hmac(salt, NAME_LABEL))
  }

  /** `K_name`, for the conformance vectors. */
  nameKeyForVectors(): Bytes {
    return new Uint8Array(this.nameKey)
  }

  /** The opaque name of check `name` on this commit. */
  async opaqueName(name: string): Promise<string> {
    return base32((await hmac(this.nameKey, concat(NAME_DOMAIN, utf8(name)))).slice(0, 10))
  }

  private logKey(nonce: Uint8Array): Promise<Bytes> {
    return hmac(this.nameKey, concat(LOG_DOMAIN, nonce))
  }

  /** Seal `log` of check `name`, run on the real commit `head` reported as `blind`. */
  async sealLog(blind: Uint8Array, name: string, head: Uint8Array, log: Uint8Array, nonce: Uint8Array = randomBytes(12)): Promise<Bytes> {
    const expected = await blindOf(this.salt, head)
    if (expected === null || blind.length !== head.length || !constantTimeEqual(expected, blind)) {
      throw new CheckLogError('malformed')
    }
    const header = utf8(JSON.stringify({ head: bytesToHex(head), name, v: 1 }))
    const body = concat(u32(header.length), header, u64(log.length), log)
    const p = new Uint8Array(Math.ceil(body.length / PAD) * PAD)
    p.set(body)
    const opaque = await this.opaqueName(name)
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(nonce), additionalData: ad(blind, opaque) },
      await aes(await this.logKey(nonce)),
      p,
    )
    return concat(MAGIC, new Uint8Array([VERSION]), nonce, new Uint8Array(ct))
  }

  /**
   * Open the sealed log of the run named `opaque` on `blind`. Throws {@link CheckLogError}: `malformed`
   * when it does not open, its padding is not zeros, or its header names a check that does not hash
   * to `opaque` or a commit whose blind is not `blind`; `unknownVersion` for a later format.
   */
  async openLog(blind: Uint8Array, opaque: string, sealed: Uint8Array): Promise<CheckLog> {
    if (sealed.length < OVERHEAD || !constantTimeEqual(sealed.subarray(0, 4), MAGIC)) throw new CheckLogError('malformed')
    if (sealed[4] !== VERSION) throw new CheckLogError('unknownVersion', sealed[4])
    const nonce = sealed.slice(5, 17)
    let p: Bytes
    try {
      p = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: ad(blind, opaque) },
          await aes(await this.logKey(nonce)),
          bytes(sealed.slice(17)),
        ),
      )
    } catch {
      throw new CheckLogError('malformed')
    }
    if (p.length === 0 || p.length % PAD !== 0) throw new CheckLogError('malformed')
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
    const hlen = view.getUint32(0)
    const at = 4 + hlen
    if (at + 8 > p.length) throw new CheckLogError('malformed')
    const llen = view.getBigUint64(at)
    if (BigInt(at + 8) + llen > BigInt(p.length)) throw new CheckLogError('malformed')
    const end = at + 8 + Number(llen)
    const rest = p.subarray(end)
    if (rest.length >= PAD || rest.some((b) => b !== 0)) throw new CheckLogError('malformed')
    let raw: string
    let h: unknown
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(p.subarray(4, at))
      h = JSON.parse(raw)
    } catch {
      throw new CheckLogError('malformed')
    }
    const header = h as { head?: unknown; name?: unknown; v?: unknown }
    // the one canonical form: no duplicate key, other spacing, order, escape, number form or hex case
    if (
      typeof h !== 'object' ||
      h === null ||
      Array.isArray(h) ||
      typeof header.head !== 'string' ||
      typeof header.name !== 'string' ||
      header.v !== 1 ||
      JSON.stringify({ head: header.head, name: header.name, v: 1 }) !== raw ||
      !/^(?:[0-9a-f]{2})*$/.test(header.head)
    ) {
      throw new CheckLogError('malformed')
    }
    let head: Bytes
    try {
      head = hexToBytes(header.head)
    } catch {
      throw new CheckLogError('malformed')
    }
    const b = await blindOf(this.salt, head)
    if (b === null || !constantTimeEqual(b, blind) || (await this.opaqueName(header.name)) !== opaque) {
      throw new CheckLogError('malformed')
    }
    return { name: header.name, head: header.head, log: p.slice(at + 8, end) }
  }
}
