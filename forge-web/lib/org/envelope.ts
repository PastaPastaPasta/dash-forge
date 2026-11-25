import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { assert, canonical, digest, hex, isHex, lengthPrefixed, unhex, utf8 } from './util'

export const PROTOCOL = 'dti/1'
const MAX_BODY = 256 * 1024

export interface Envelope {
  readonly v: 1
  readonly room: string
  readonly type: string
  readonly from: string
  readonly at: string
  readonly body: Record<string, unknown>
  readonly sig: string
}

export interface EnvelopeKeys {
  readonly authSecret: Uint8Array
  readonly authPub: string
}

const signingBytes = (unsigned: Omit<Envelope, 'sig'>): Uint8Array => utf8(`${PROTOCOL}|envelope|${canonical(unsigned)}`)

export function sealEnvelope(keys: EnvelopeKeys, room: string, type: string, body: Record<string, unknown>, at = new Date().toISOString()): Envelope {
  const unsigned = { v: 1 as const, room, type, from: keys.authPub, at, body }
  return { ...unsigned, sig: hex(ed25519.sign(signingBytes(unsigned), keys.authSecret)) }
}

export const envelopeId = (envelope: unknown): string => digest(envelope)

export function verifyEnvelope(envelope: unknown): envelope is Envelope {
  try {
    const { sig, ...unsigned } = envelope as Envelope
    if (unsigned.v !== 1 || typeof unsigned.type !== 'string' || typeof unsigned.room !== 'string') return false
    if (typeof unsigned.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(unsigned.at)) return false
    if (!isHex(unsigned.from, 32) || !isHex(sig, 64)) return false
    if (canonical(unsigned.body).length > MAX_BODY) return false
    return ed25519.verify(unhex(sig), signingBytes(unsigned), unhex(unsigned.from))
  } catch {
    return false
  }
}

export type BoxContext = readonly (string | number)[]

export function boxContext(c: { cid: string; slot: string; from: number; to: number; fromTransport: string; toTransport: string }): BoxContext {
  return ['dkg-share', c.cid, c.slot, c.from, c.to, c.fromTransport, c.toTransport]
}

export function decryptBox(mySecret: Uint8Array, theirPub: string, context: BoxContext, ciphertextHex: string): string {
  const shared = x25519.getSharedSecret(mySecret, unhex(theirPub))
  assert(shared.some((b) => b !== 0), 'x25519 produced the all-zero shared secret (low-order public key)')
  const okm = hkdf(sha256, shared, utf8(`${PROTOCOL}/box`), lengthPrefixed(...context), 44)
  const aad = lengthPrefixed('aad', ...context)
  return new TextDecoder().decode(chacha20poly1305(okm.slice(0, 32), okm.slice(32, 44), aad).decrypt(unhex(ciphertextHex)))
}
