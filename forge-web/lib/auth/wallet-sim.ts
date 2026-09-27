/**
 * A simulated Dash wallet, for tests: parses a `dash-key:` / `dash-st:` URI exactly as the
 * shipped wallets do (a line-by-line port of Dash Wallet Android `DashConnectUri.kt` plus the
 * iOS `DashConnectUri.swift` length ceiling), derives the login key the way they do
 * (`LoginKeyDerivation`), and seals a response (`KeyExchangeCrypto.encryptLoginKey`). A test
 * that passes here passes the wallets' own parsers byte for byte.
 */

import * as secp from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { base58Decode } from './base58'
import { envelopeKey } from './wallet-protocol'

const enc = new TextEncoder()

export class DashConnectUriException extends Error {}

export interface ParsedKeyRequest {
  readonly appEphemeralPubKey: Uint8Array
  readonly contractId: Uint8Array
  readonly label: string
  readonly network: 'm' | 't' | 'd'
}

const MIN_KEY_PAYLOAD_LENGTH = 1 + 33 + 32 + 1
const MAX_LABEL_LENGTH = 64
/** iOS: the payload can be no longer than the format allows (67 + 64). */
const MAX_KEY_PAYLOAD_LENGTH = MIN_KEY_PAYLOAD_LENGTH + MAX_LABEL_LENGTH

function parseEnvelope(uri: string, scheme: string): { body: string; network: 'm' | 't' | 'd' } {
  if (!uri.startsWith(scheme)) throw new DashConnectUriException(`expected scheme ${scheme}`)
  const after = uri.slice(scheme.length)
  if (after.startsWith('//')) throw new DashConnectUriException('scheme must not be followed by //')
  const q = after.indexOf('?')
  if (q < 0) throw new DashConnectUriException('missing query component')
  const body = after.slice(0, q)
  if (body === '') throw new DashConnectUriException('missing payload')
  const params = new Map<string, string>()
  for (const pair of after.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq >= 0) params.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const v = params.get('v')
  if (v === undefined) throw new DashConnectUriException('missing v param')
  if (Number.parseInt(v, 10) !== 1 || String(Number.parseInt(v, 10)) !== v) throw new DashConnectUriException(`unsupported version: ${v}`)
  const n = params.get('n')
  if (n === undefined) throw new DashConnectUriException('missing n param')
  if (n !== 'm' && n !== 't' && n !== 'd') throw new DashConnectUriException(`unknown network: ${n}`)
  return { body, network: n }
}

/** `DashConnectUri.parseKeyRequest` (Android), plus the iOS length ceiling. */
export function parseKeyRequest(uri: string): ParsedKeyRequest {
  const { body, network } = parseEnvelope(uri, 'dash-key:')
  let payload: Uint8Array
  try {
    payload = base58Decode(body)
  } catch (e) {
    throw new DashConnectUriException(`invalid Base58 payload: ${String(e)}`)
  }
  if (payload.length < MIN_KEY_PAYLOAD_LENGTH) throw new DashConnectUriException(`dash-key payload too short: ${payload.length}`)
  if (payload.length > MAX_KEY_PAYLOAD_LENGTH) throw new DashConnectUriException('bodyTooLong (iOS)')
  let offset = 0
  if (payload[offset++] !== 0x01) throw new DashConnectUriException('unsupported dash-key payload version')
  const appEphemeralPubKey = payload.slice(offset, offset + 33)
  offset += 33
  const contractId = payload.slice(offset, offset + 32)
  offset += 32
  const labelLen = payload[offset++] as number
  if (labelLen > MAX_LABEL_LENGTH) throw new DashConnectUriException(`label length ${labelLen} exceeds max`)
  if (offset + labelLen > payload.length) throw new DashConnectUriException('label length overruns payload')
  let label: string
  try {
    label = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(offset, offset + labelLen))
  } catch {
    throw new DashConnectUriException('invalidKeyLabelEncoding (iOS)')
  }
  try {
    secp.Point.fromBytes(appEphemeralPubKey)
  } catch {
    throw new DashConnectUriException('appEphemeralPubKey is not a valid compressed secp256k1 point')
  }
  return { appEphemeralPubKey, contractId, label, network }
}

/** `DashConnectUri.parseStRequest`: the raw transition bytes. */
export function parseStRequest(uri: string): { transitionBytes: Uint8Array; network: string } {
  const { body, network } = parseEnvelope(uri, 'dash-st:')
  const transitionBytes = base58Decode(body)
  if (transitionBytes.length === 0) throw new DashConnectUriException('dash-st transition bytes are empty')
  if (transitionBytes.length > 4096) throw new DashConnectUriException('bodyTooLong (iOS)')
  return { transitionBytes, network }
}

/** `LoginKeyDerivation.deriveLoginKey`: HKDF(chainKey, identityId, "dash:login-key:v1" ‖ contractId). */
export function deriveLoginKey(chainKey: Uint8Array, identityId: Uint8Array, contractId: Uint8Array): Uint8Array {
  return hkdf(sha256, chainKey, identityId, new Uint8Array([...enc.encode('dash:login-key:v1'), ...contractId]), 32)
}

/** `KeyExchangeCrypto.encryptLoginKeyWithNonce`: nonce ‖ AES-256-GCM(loginKeys) (60 bytes for one key). */
export async function sealLoginKeys(loginKeys: readonly Uint8Array[], walletPriv: Uint8Array, appPub: Uint8Array, nonce = crypto.getRandomValues(new Uint8Array(12))): Promise<Uint8Array> {
  const raw = envelopeKey(walletPriv, appPub)
  const k = await crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt'])
  const plain = new Uint8Array(loginKeys.length * 32)
  loginKeys.forEach((l, i) => plain.set(l, i * 32))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonce) }, k, plain))
  return new Uint8Array([...nonce, ...ct])
}
