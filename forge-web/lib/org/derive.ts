import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

import { bytesToScalar, mod } from './bls'
import { assert, hex, lengthPrefixed, sha256hex, utf8 } from './util'

const SALT = utf8('dash-threshold-identity/v1')

export function normalizePhrase(mnemonic: string): string {
  return String(mnemonic).trim().toLowerCase().split(/\s+/).join(' ')
}

export function seedFromMnemonic(mnemonic: string, passphrase = ''): Uint8Array {
  const words = normalizePhrase(mnemonic).normalize('NFKD')
  return pbkdf2(sha512, utf8(words), utf8(`mnemonic${passphrase}`.normalize('NFKD')), { c: 2048, dkLen: 64 })
}

export function kdf(seed: Uint8Array, label: string, parts: readonly (string | number | Uint8Array)[] = [], length = 32): Uint8Array {
  assert(seed.length >= 32, 'seed must be at least 32 bytes')
  return hkdf(sha256, seed, SALT, lengthPrefixed(label, ...parts), length)
}

export function kdfScalar(seed: Uint8Array, label: string, parts: readonly (string | number)[] = []): bigint {
  for (let counter = 0; ; counter++) {
    const x = mod(bytesToScalar(kdf(seed, label, [...parts, counter], 64)))
    if (x !== 0n) return x
  }
}

export interface MemberKeys {
  readonly authSecret: Uint8Array
  readonly authPub: string
  readonly transportSecret: Uint8Array
  readonly transportPub: string
}

export function participantKeys(seed: Uint8Array): MemberKeys {
  const authSecret = kdf(seed, 'auth/ed25519')
  const transportSecret = kdf(seed, 'transport/x25519')
  return { authSecret, authPub: hex(ed25519.getPublicKey(authSecret)), transportSecret, transportPub: hex(x25519.getPublicKey(transportSecret)) }
}

export function fingerprint(authPub: string, transportPub: string): string {
  const h = sha256hex(`dti-fingerprint|${authPub}|${transportPub}`).slice(0, 32).toUpperCase()
  return (h.match(/.{4}/g) as string[]).join('-')
}

export function dkgCoefficients(seed: Uint8Array, cid: string, slot: string, threshold: number): bigint[] {
  return Array.from({ length: threshold }, (_, k) => kdfScalar(seed, 'dkg/coefficient', [cid, slot, k]))
}
