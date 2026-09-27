/**
 * The wallet key-exchange protocol the shipped Dash wallets speak ("DashConnect": Dash Wallet
 * Android `ui/more/connections/protocol/`, Dash Wallet iOS `Models/DashConnect/Protocol/`).
 * Yappr defined it; this is a port of `@pastapastapasta/platform-auth`
 * `src/key-exchange/yappr-protocol.ts` (MIT), checked against the wallets' own test vectors in
 * `wallet-protocol.test.ts`.
 *
 * Login request (QR #1, `dash-key:`), plain base58, no checksum:
 *
 *     version(1) = 0x01 ‖ appEphemeralPub(33) ‖ contractId(32) ‖ labelLen(1, ≤ 64) ‖ label(UTF-8)
 *
 * then `?n=<m|t|d>&v=1`. Nothing may follow the label: iOS refuses a payload longer than
 * 67 + 64 bytes, and both wallets read `labelLen` at byte 66. The wallet binds everything it
 * derives to `contractId`: the login key is HKDF(chainKey, identityId, "dash:login-key:v1" ‖
 * contractId), so one request = one contract.
 *
 * Response: the wallet encrypts 32-byte login keys to the app's ephemeral key. The AES key is
 * HKDF-SHA256(ECDH(x), salt "dash:key-exchange:v1", no info); the payload is
 * nonce(12) ‖ ciphertext ‖ tag(16), one 32-byte key (legacy, 60 bytes) or several (App Connect,
 * up to 572 bytes). Each login key stands for an auth key HKDF(loginKey, identityId, "auth")
 * and an encryption key HKDF(loginKey, identityId, "encryption").
 *
 * Key registration (QR #2, `dash-st:`): a tagless serialized IdentityUpdateTransition, same
 * query string (see `key-registration.ts`).
 */

import * as secp from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { Network } from '../constants'
import { hash160 } from './asset-lock'
import { base58Decode, base58Encode } from './base58'

const enc = new TextEncoder()

const PROTOCOL_VERSION = 1
const MAX_LABEL_BYTES = 64
/** The shortest request (empty label): what both wallets check first. */
const MIN_REQUEST_BYTES = 1 + 33 + 32 + 1
const ENVELOPE_BYTES = 12 + 16

/** The `?n=` code (the DApp's `YAPPR_NETWORK_IDS`; `DashConnectNetwork` in the wallets). */
function networkCode(network: Network): 'm' | 't' | 'd' {
  return network === 'mainnet' ? 'm' : network === 'testnet' ? 't' : 'd'
}

/** The request payload bytes, exactly as the wallets parse them. */
export function encodeKeyRequest(appEphemeralPub: Uint8Array, contractId: Uint8Array, label: string): Uint8Array {
  if (appEphemeralPub.length !== 33) throw new Error('the ephemeral public key must be 33 bytes (compressed)')
  if (contractId.length !== 32) throw new Error('the contract id must be 32 bytes')
  const labelBytes = enc.encode(label)
  if (labelBytes.length > MAX_LABEL_BYTES) throw new Error(`the label is longer than ${MAX_LABEL_BYTES} bytes`)
  const out = new Uint8Array(MIN_REQUEST_BYTES + labelBytes.length)
  out[0] = PROTOCOL_VERSION
  out.set(appEphemeralPub, 1)
  out.set(contractId, 34)
  out[66] = labelBytes.length
  out.set(labelBytes, 67)
  return out
}

/** `<scheme>:<base58>?n=<code>&v=1` — the envelope both URI kinds share. */
export function protocolUri(scheme: 'dash-key' | 'dash-st', payload: Uint8Array, network: Network): string {
  return `${scheme}:${base58Encode(payload)}?n=${networkCode(network)}&v=${PROTOCOL_VERSION}`
}

/**
 * Six digits derived from the request's ephemeral key: hash160(pub)[0..4] as a big-endian u32,
 * mod 10^6 (Platform's `BrowserLoginKeyProtocol.pairingCode`). A wallet that shows the same
 * code proves it scanned this request, not one an attacker put in front of the user. The
 * shipped Dash wallets do not show it yet (docs/upstream/).
 */
export function pairingCode(appEphemeralPub: Uint8Array): string {
  const d = hash160(appEphemeralPub)
  return String(new DataView(d.buffer, d.byteOffset, 4).getUint32(0) % 1_000_000).padStart(6, '0')
}

/** The AES-256-GCM key of a response: HKDF(ECDH x, "dash:key-exchange:v1"). */
export function envelopeKey(priv: Uint8Array, peerPub: Uint8Array): Uint8Array {
  const shared = secp.getSharedSecret(priv, peerPub, true).slice(1, 33)
  try {
    return hkdf(sha256, shared, enc.encode('dash:key-exchange:v1'), new Uint8Array(0), 32)
  } finally {
    shared.fill(0)
  }
}

/**
 * Decrypt a response payload into its 32-byte login keys (one for the legacy contract, one or
 * more for App Connect). Throws when the tag does not verify (not encrypted to this request)
 * or the framing is not 28 + 32·k bytes.
 */
export async function openEnvelope(appPriv: Uint8Array, walletEphemeralPub: Uint8Array, payload: Uint8Array): Promise<Uint8Array[]> {
  if (payload.length < ENVELOPE_BYTES + 32 || (payload.length - ENVELOPE_BYTES) % 32 !== 0) {
    throw new Error('the wallet response is malformed')
  }
  const raw = envelopeKey(appPriv, walletEphemeralPub)
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['decrypt'])
  } finally {
    raw.fill(0)
  }
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, key, payload.slice(12)))
  const keys: Uint8Array[] = []
  for (let i = 0; i < plain.length; i += 32) keys.push(plain.slice(i, i + 32))
  plain.fill(0)
  return keys
}

/** The auth private key a login key stands for: HKDF(loginKey, identityId, "auth"). */
export function authKeyFromLogin(loginKey: Uint8Array, identityId: string): Uint8Array {
  return hkdf(sha256, loginKey, base58Decode(identityId), enc.encode('auth'), 32)
}

/** The encryption private key a login key stands for: HKDF(loginKey, identityId, "encryption"). */
export function encryptionKeyFromLogin(loginKey: Uint8Array, identityId: string): Uint8Array {
  return hkdf(sha256, loginKey, base58Decode(identityId), enc.encode('encryption'), 32)
}
