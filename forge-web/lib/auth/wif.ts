/**
 * WIF (Wallet Import Format) private-key parsing — pure JS, no WASM required.
 *
 * Lets the login form validate a pasted key and detect its network *before* the evo-sdk WASM
 * module has loaded. The actual signing uses the SDK's `PrivateKey.fromWIF`; this module only
 * decodes/normalizes for storage and network-scoping. Ported from yappr's `lib/crypto/wif.ts`.
 */

import { base58CheckDecode, base58CheckEncode } from './base58'
import type { Network } from '../constants'

/** Dash WIF version prefixes. */
export const TESTNET_WIF_PREFIX = 0xef
export const MAINNET_WIF_PREFIX = 0xcc

/** A decoded WIF: the 32-byte secret, its compression flag, and the version prefix byte. */
export interface DecodedWif {
  readonly privateKey: Uint8Array
  readonly compressed: boolean
  readonly prefix: number
}

/** Decode a WIF string to its private-key bytes + metadata. Throws on a malformed WIF. */
export function decodeWif(wif: string): DecodedWif {
  const decoded = base58CheckDecode(wif)
  const prefix = decoded[0] as number
  if (decoded.length === 34 && decoded[33] === 0x01) {
    return { privateKey: decoded.slice(1, 33), compressed: true, prefix }
  }
  if (decoded.length === 33) {
    return { privateKey: decoded.slice(1, 33), compressed: false, prefix }
  }
  throw new Error('invalid WIF length')
}

/** The network a WIF prefix belongs to, or null if it is not a known Dash prefix. */
export function networkOfWifPrefix(prefix: number): Network | null {
  if (prefix === MAINNET_WIF_PREFIX) return 'mainnet'
  if (prefix === TESTNET_WIF_PREFIX) return 'testnet'
  return null
}

/** Whether a WIF's prefix matches the given network. */
export function validateWifNetwork(prefix: number, network: Network): boolean {
  return networkOfWifPrefix(prefix) === network
}

/** Quick heuristic: does this string look like a Dash WIF (51–52 chars, valid checksum)? */
export function isLikelyWif(input: string): boolean {
  const s = input.trim()
  if (s.length < 50 || s.length > 53) return false
  if (!/^[cC9X7]/.test(s)) return false
  try {
    decodeWif(s)
    return true
  } catch {
    return false
  }
}

/** Whether the input looks like a 64-char hex private key (optional `0x` prefix). */
export function isLikelyHex(input: string): boolean {
  let hex = input.trim()
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
  return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex)
}

function hexToBytes(hex: string): Uint8Array {
  let clean = hex.trim()
  if (clean.startsWith('0x') || clean.startsWith('0X')) clean = clean.slice(2)
  if (clean.length % 2 !== 0) throw new Error('hex string must have even length')
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('invalid hex characters')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Encode 32 private-key bytes as a compressed WIF for the given network. */
export function encodeWif(privateKey: Uint8Array, network: Network, compressed = true): string {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes')
  const prefix = network === 'mainnet' ? MAINNET_WIF_PREFIX : TESTNET_WIF_PREFIX
  const payload = new Uint8Array(compressed ? 34 : 33)
  payload[0] = prefix
  payload.set(privateKey, 1)
  if (compressed) payload[33] = 0x01
  return base58CheckEncode(payload)
}

/** A parsed private key: bytes + detected format + (for WIF) its network. */
export interface ParsedPrivateKey {
  readonly privateKey: Uint8Array
  readonly format: 'wif' | 'hex'
  readonly network?: Network
}

/** Parse a WIF or hex private key, rejecting unknown WIF prefixes rather than guessing. */
export function parsePrivateKey(input: string): ParsedPrivateKey {
  const trimmed = input.trim()
  if (isLikelyWif(trimmed)) {
    const decoded = decodeWif(trimmed)
    const network = networkOfWifPrefix(decoded.prefix)
    if (network === null) {
      throw new Error(
        `unsupported WIF prefix 0x${decoded.prefix.toString(16)} — expected Dash mainnet (0xcc) or testnet (0xef)`,
      )
    }
    return { privateKey: decoded.privateKey, format: 'wif', network }
  }
  if (isLikelyHex(trimmed)) {
    return { privateKey: hexToBytes(trimmed), format: 'hex' }
  }
  throw new Error(
    'invalid private key — expected WIF (51–52 chars starting c/9/X/7) or 64-char hex',
  )
}

/**
 * Normalize any accepted key form to a compressed WIF for the given network. A WIF whose
 * network already matches is returned unchanged; hex (or a foreign-network WIF's raw bytes)
 * is re-encoded. This is the single storage form the keystore and signer consume.
 */
export function normalizeToWif(input: string, network: Network): string {
  const parsed = parsePrivateKey(input)
  if (parsed.format === 'wif' && parsed.network === network) return input.trim()
  return encodeWif(parsed.privateKey, network, true)
}
