/**
 * Getting a limited key from `dg` without typing the recovery phrase into a web page (trust and
 * safety TS-06; `docs/contracts/forge-v2.md` "Key handoff"). The Rust side is
 * `crates/forge-core/src/browser_key.rs`; both run the `key_handoff_*` conformance vectors.
 *
 * 1. This tab draws a one-time secp256k1 key pair and shows its public half as a request,
 *    `dfkr1:<network>:<base64url(compressed public key)>`, inside a `dg` command.
 * 2. `dg auth keys add --for-browser <request>` registers a limited key, signed by the master key
 *    on the terminal, and prints a reply sealed to that public key:
 *    `dfkh1:<network>:<base64url(ephemeral public key (33) ‖ nonce (12) ‖ AES-256-GCM ciphertext)>`.
 * 3. This tab opens the reply with its one-time private key, checks the key on chain and keeps it
 *    in the vault. The one-time private key never leaves memory and is wiped once used.
 *
 * AES key: HKDF-SHA256(ikm = x(ECDH), salt = ephemeral public ‖ request public,
 * info = "dash-forge/key-handoff/1"). Associated data: "dfkh1:" ‖ network.
 */

import * as secp from '@noble/secp256k1'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'

export const REQUEST_PREFIX = 'dfkr1:'
export const REPLY_PREFIX = 'dfkh1:'
const INFO = new TextEncoder().encode('dash-forge/key-handoff/1')

/**
 * The fixed warning shown before every recovery-phrase prompt, in the web app and in `dg`
 * (vector `copy__recovery_phrase_warning`; Rust `browser_key::RECOVERY_PHRASE_WARNING`).
 */
export const RECOVERY_PHRASE_WARNING =
  "Your recovery phrase controls your identity. Forge asks for it only after you start a key action yourself, never because a message, an email or a pop-up says so. If you didn't start this, stop here."

/** Why a reply does not open. */
export type HandoffOpenError = 'malformed' | 'network' | 'unreadable'

export class HandoffError extends Error {
  constructor(
    readonly kind: HandoffOpenError | 'payload',
    message: string,
  ) {
    super(message)
    this.name = 'HandoffError'
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6))
    for (let j = 0; j < chars; j++) out += B64[(n >> (18 - 6 * j)) & 63]
  }
  return out
}

/**
 * Strict base64url without padding, as Rust's `URL_SAFE_NO_PAD` decodes: no `=`, no characters
 * outside the alphabet, no impossible length, no stray bits in the last character. Null if not.
 */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 6) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (const c of text) {
    const v = B64.indexOf(c)
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
    acc &= (1 << bits) - 1
  }
  return acc === 0 ? out : null
}

function validNetwork(n: string): boolean {
  return n.length > 0 && n.length <= 32 && /^[A-Za-z0-9-]+$/.test(n)
}

/** A one-time request: its text, and the private key that opens the reply (wipe with {@link HandoffRequest.wipe}). */
export interface HandoffRequest {
  readonly network: string
  readonly text: string
  readonly secret: Uint8Array
  wipe(): void
}

/** A request for `network` from `secret` (fixed in the vectors; random otherwise). */
export function handoffRequest(network: string, secret: Uint8Array = secp.utils.randomSecretKey()): HandoffRequest {
  if (!validNetwork(network)) throw new Error(`not a network name: ${network}`)
  const pub = secp.getPublicKey(secret, true)
  return {
    network,
    text: `${REQUEST_PREFIX}${network}:${base64urlEncode(pub)}`,
    secret,
    wipe: () => secret.fill(0),
  }
}

/** The AES key of a reply between `ephemeralPub` (dg's) and `requestPub` (this tab's) keys. */
function replyKey(shared: Uint8Array, ephemeralPub: Uint8Array, requestPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephemeralPub, requestPub), INFO, 32)
}

/**
 * Open a `dfkh1:` reply with the request's one-time `secret`: the plaintext bytes (the caller
 * wipes them). Throws {@link HandoffError} with the vectors' error kinds.
 */
export async function openHandoffReply(reply: string, network: string, secret: Uint8Array): Promise<Uint8Array> {
  const bad = (kind: HandoffOpenError): HandoffError => new HandoffError(kind, OPEN_ERROR_TEXT[kind])
  const trimmed = reply.trim()
  if (!trimmed.startsWith(REPLY_PREFIX)) throw bad('malformed')
  const rest = trimmed.slice(REPLY_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon < 0) throw bad('malformed')
  const net = rest.slice(0, colon)
  if (!validNetwork(net)) throw bad('malformed')
  if (net !== network) throw new HandoffError('network', `This key was made for ${net}, but this site is on ${network}. Run the command with --network ${network}.`)
  const bytes = base64urlDecode(rest.slice(colon + 1))
  if (bytes === null || bytes.length < 33 + 12 + 16) throw bad('malformed')
  const ephemeralPub = bytes.slice(0, 33)
  let shared: Uint8Array
  try {
    shared = secp.getSharedSecret(secret, ephemeralPub, true).slice(1, 33)
  } catch {
    throw bad('malformed')
  }
  const raw = replyKey(shared, ephemeralPub, secp.getPublicKey(secret, true))
  shared.fill(0)
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['decrypt'])
  } finally {
    raw.fill(0)
  }
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(33, 45),
        additionalData: new TextEncoder().encode(`${REPLY_PREFIX}${net}`),
      },
      key,
      bytes.slice(45),
    )
    return new Uint8Array(plain)
  } catch {
    throw bad('unreadable')
  }
}

const OPEN_ERROR_TEXT: Readonly<Record<HandoffOpenError, string>> = {
  malformed: "That isn't the key dg printed. Copy the whole line that starts with dfkh1: and paste it here.",
  network: 'This key was made for another network.',
  unreadable: 'This key was made for another request, or it was changed on the way. Run the command shown here again; each request works once.',
}

/** What a reply carries (Rust `browser_key::Payload`). */
export interface HandoffPayload {
  readonly network: string
  readonly identityId: string
  readonly keyId: number
  readonly wif: string
  readonly replacedKeyId?: number
  readonly encryptionKey?: {
    readonly keyId: number
    readonly privateKeyHex: string
  }
}

const KEY_ID = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff

/** Parse a reply's plaintext (wiped here); refuses anything but a version-1 payload for `network`. */
export function parseHandoffPayload(plain: Uint8Array, network: string): HandoffPayload {
  const refuse = (): HandoffError => new HandoffError('payload', "dg sent a key this version of Forge can't read. Update dg and try again.")
  let p: Record<string, unknown>
  try {
    p = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>
  } catch {
    throw refuse()
  } finally {
    plain.fill(0)
  }
  if (typeof p !== 'object' || p === null || p.v !== 1) throw refuse()
  const allowed = new Set(['v', 'network', 'identityId', 'keyId', 'wif', 'replacedKeyId', 'encryptionKey'])
  if (Object.keys(p).some((k) => !allowed.has(k))) throw refuse()
  if (p.network !== network || typeof p.identityId !== 'string' || !KEY_ID(p.keyId) || typeof p.wif !== 'string') throw refuse()
  if (p.replacedKeyId !== undefined && !KEY_ID(p.replacedKeyId)) throw refuse()
  let encryptionKey: HandoffPayload['encryptionKey']
  if (p.encryptionKey !== undefined) {
    const e = p.encryptionKey as Record<string, unknown> | null
    if (typeof e !== 'object' || e === null || !KEY_ID(e.keyId) || typeof e.privateKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(e.privateKeyHex)) throw refuse()
    if (Object.keys(e).some((k) => k !== 'keyId' && k !== 'privateKeyHex')) throw refuse()
    encryptionKey = { keyId: e.keyId, privateKeyHex: e.privateKeyHex }
  }
  return {
    network,
    identityId: p.identityId,
    keyId: p.keyId,
    wif: p.wif,
    ...(p.replacedKeyId !== undefined ? { replacedKeyId: p.replacedKeyId as number } : {}),
    ...(encryptionKey ? { encryptionKey } : {}),
  }
}

/** What the `dg` command asks for: its network, limits, the key it replaces, whether to bring the encryption key. */
export interface HandoffOptions {
  readonly replaceKeyId?: number
  readonly days: number
  readonly budgetDash: number
  readonly withEncryptionKey: boolean
}

/** The `dg` flag that selects a network key (`testnet`, `mainnet`, `devnet-<name>`). */
export function networkFlag(network: string): string {
  return network.startsWith('devnet-') ? `--devnet-name ${network.slice('devnet-'.length)}` : `--network ${network}`
}

/** The `dg` command that answers `request`. */
export function handoffCommand(request: HandoffRequest, o: HandoffOptions): string {
  return [
    'dg auth keys add',
    networkFlag(request.network),
    `--for-browser ${request.text}`,
    `--budget ${o.budgetDash}`,
    `--expires ${o.days}d`,
    ...(o.replaceKeyId !== undefined ? [`--replace ${o.replaceKeyId}`] : []),
    ...(o.withEncryptionKey ? ['--with-encryption-key'] : []),
  ].join(' ')
}
