/**
 * "Use my Dash wallet" (`ux-dx-spec.md` §2.2 tile 1): App Connect login, protocol 14.
 *
 * The app draws an ephemeral secp256k1 key and shows a `dash-key:` request (QR / deep link)
 * naming the forge-core contract and the grant it wants. A wallet that approves registers a
 * limited key on its identity and publishes a `loginKeyResponse` in the App Connect system
 * contract, under its identity, keyed by `hash160(appEphemeralPub)`. The app polls for it,
 * derives the shared secret (ECDH x → HKDF-SHA256, salt "dash:key-exchange:v1"), decrypts the
 * 32-byte login key (AES-256-GCM), derives the auth key (HKDF(loginKey, identityId, "auth")),
 * and then **verifies on chain** that a live key on the responder's identity is that key, with
 * AUTHENTICATION/HIGH, the dash-forge group bound, and a budget and expiry — the response
 * alone proves nothing about who answered (`app-connect.md`, "Approval and re-login" step 3).
 *
 * The crypto is the Yappr key-exchange envelope the Dash wallets already speak.
 */

import * as secp from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { Network } from '../constants'
import { base58Decode, base58Encode } from './base58'
import { hash160 } from './asset-lock'
import { encodeWif } from './wif'
import { verifyLimitedKey } from './limited-key'
import type { KeyLimits } from '../view/funds'
import { authSdk, sleep } from '../sdk/facade'

/** The App Connect system contract (the same id on every network, protocol 14). */
export const APP_CONNECT_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ'

const enc = new TextEncoder()

export interface AppConnectRequest {
  /** The `dash-key:` URI to show as a QR and a deep link. */
  readonly uri: string
  /** Six digits the wallet shows too (pairing check). */
  readonly pairingCode: string
  readonly appEphemeralPubKeyHash: Uint8Array
  /** Held only in memory; zeroed by {@link disposeRequest}. */
  readonly appEphemeralPriv: Uint8Array
}

function networkTag(network: Network): string {
  return network === 'mainnet' ? 'm' : network === 'testnet' ? 't' : 'd'
}

/**
 * A fresh request for `contractId` (forge-core). The payload is the key-exchange request:
 * version(1) ‖ appEphemeralPub(33) ‖ contractId(32) ‖ keyIndex(u32 LE) ‖ labelLen(1) ‖ label.
 */
export function newRequest(network: Network, contractId: string, label = 'Sign in to Dash Forge'): AppConnectRequest {
  const priv = secp.utils.randomSecretKey()
  const pub = secp.getPublicKey(priv, true)
  const labelBytes = enc.encode(label).slice(0, 64)
  const body = new Uint8Array(1 + 33 + 32 + 4 + 1 + labelBytes.length)
  body[0] = 1
  body.set(pub, 1)
  body.set(base58Decode(contractId), 34)
  body[70] = labelBytes.length
  body.set(labelBytes, 71)
  const pubHash = hash160(pub)
  const digest = pubHash.slice(0, 4)
  const code = (((digest[0] as number) << 24) | ((digest[1] as number) << 16) | ((digest[2] as number) << 8) | (digest[3] as number)) >>> 0
  return {
    uri: `dash-key:${base58Encode(body)}?n=${networkTag(network)}&v=1`,
    pairingCode: String(code % 1_000_000).padStart(6, '0'),
    appEphemeralPubKeyHash: pubHash,
    appEphemeralPriv: priv,
  }
}

export function disposeRequest(req: AppConnectRequest): void {
  req.appEphemeralPriv.fill(0)
}

/** Decrypt a wallet response's payload into the 32-byte login key. */
export async function openResponse(req: AppConnectRequest, walletEphemeralPub: Uint8Array, encryptedPayload: Uint8Array): Promise<Uint8Array> {
  const shared = secp.getSharedSecret(req.appEphemeralPriv, walletEphemeralPub, true).slice(1, 33)
  const key = hkdf(sha256, shared, enc.encode('dash:key-exchange:v1'), new Uint8Array(0), 32)
  shared.fill(0)
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'AES-GCM' }, false, ['decrypt'])
  key.fill(0)
  const nonce = encryptedPayload.slice(0, 12)
  const ct = encryptedPayload.slice(12)
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct))
  if (plain.length < 32) throw new Error('the wallet response is malformed')
  return plain.slice(0, 32)
}

/** The auth private key a login key stands for: HKDF(loginKey, identityId, "auth"). */
export function authKeyFromLogin(loginKey: Uint8Array, identityId: string): Uint8Array {
  return hkdf(sha256, loginKey, base58Decode(identityId), enc.encode('auth'), 32)
}

interface RawResponse {
  toJSON(): { $ownerId: string; walletEphemeralPubKey: string; encryptedPayload: string }
}

/** Why a response was skipped: not for us (never retry), or not verifiable yet (retry). */
class NotOurs extends Error {}

function b64(s: string): Uint8Array {
  const bin = atob(s)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Whether the App Connect contract exists on this network (hide the tile otherwise). */
export async function appConnectAvailable(sdk: import('@dashevo/evo-sdk').EvoSDK): Promise<boolean> {
  try {
    const c = await authSdk(sdk).contracts.fetch(APP_CONNECT_CONTRACT_ID)
    return c !== undefined && c !== null
  } catch {
    return false
  }
}

/** The result of a completed wallet login. */
export interface WalletLogin {
  readonly identityId: string
  readonly keyId: number
  readonly wif: string
  readonly limits: KeyLimits
}

/**
 * Poll for responses to `req` until one decrypts to a key that is live on its responder's
 * identity with the Forge bounds (then resolve), or the signal aborts. Responses that do not
 * decrypt, or whose key is not verifiably a Forge browser key, are skipped.
 */
export async function awaitWalletLogin(
  sdk: import('@dashevo/evo-sdk').EvoSDK,
  req: AppConnectRequest,
  params: { network: Network; group: string; signal?: AbortSignal; intervalMs?: number },
): Promise<WalletLogin> {
  // Owners whose response does not decrypt with our key are not answering us: skip them for
  // good. A response that decrypts but whose key is not verifiable yet (the wallet published
  // before its key update was visible, or a read failed) is retried on the next poll.
  const notOurs = new Set<string>()
  for (;;) {
    if (params.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    let rows: Map<string, unknown> = new Map()
    try {
      rows = await authSdk(sdk).documents.query({
        dataContractId: APP_CONNECT_CONTRACT_ID,
        documentTypeName: 'loginKeyResponse',
        where: [['appEphemeralPubKeyHash', '==', btoa(String.fromCharCode(...req.appEphemeralPubKeyHash))]],
        orderBy: [['appEphemeralPubKeyHash', 'asc']],
        limit: 10,
      })
    } catch {
      /* transient: poll again */
    }
    for (const raw of rows.values()) {
      if (!raw) continue
      const j = (raw as RawResponse).toJSON()
      if (notOurs.has(j.$ownerId)) continue
      try {
        const wif = await decryptGrant(req, j, params.network)
        const keyId = await findKeyId(sdk, j.$ownerId, wif, params.network)
        if (keyId === null) continue
        const limits = await verifyLimitedKey(sdk, j.$ownerId, keyId, params.group, params.network, wif)
        disposeRequest(req)
        return { identityId: j.$ownerId, keyId, wif, limits }
      } catch (e) {
        if (e instanceof NotOurs) notOurs.add(j.$ownerId)
      }
    }
    await sleep(params.intervalMs ?? 3000, params.signal)
  }
}

async function decryptGrant(req: AppConnectRequest, j: ReturnType<RawResponse['toJSON']>, network: Network): Promise<string> {
  let login: Uint8Array
  try {
    login = await openResponse(req, b64(j.walletEphemeralPubKey), b64(j.encryptedPayload))
  } catch {
    throw new NotOurs()
  }
  const auth = authKeyFromLogin(login, j.$ownerId)
  login.fill(0)
  const wif = encodeWif(auth, network)
  auth.fill(0)
  return wif
}

/** Which key on `identityId` the WIF controls (the wallet may register it as HASH160). */
async function findKeyId(sdk: import('@dashevo/evo-sdk').EvoSDK, identityId: string, wif: string, network: Network): Promise<number | null> {
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(identityId)
  const pk = PrivateKey.fromWIF(wif)
  const bytes = pk.toBytes()
  pk.free()
  try {
    for (const k of identity?.publicKeys ?? []) {
      try {
        if (k.validatePrivateKey(bytes, network)) return k.keyId
      } catch {
        /* other key types */
      }
    }
    return null
  } finally {
    bytes.fill(0)
  }
}
