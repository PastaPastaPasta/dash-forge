/**
 * The optional email and Web Push service (`services/forge-notify`, `docs/hosting/forge-notify.md`).
 *
 * Forge works the same without it: the in-browser inbox (`/notifications/`) reads the chain
 * itself. This module only talks to a service the build names in `NEXT_PUBLIC_NOTIFY_URL`; with
 * it unset, nothing here runs and the settings section is hidden.
 *
 * Every change is a signed request (`docs/design/service-auth.md`): the request JSON, signed
 * exactly as sent, with this browser's key over `SHA-256(SHA-256("DashForgeService/v1\n" ‖
 * request))`. The domain line means the signature can never be a state transition. The service
 * reads the key from Platform with proofs, so there is no account and no password.
 */

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { bytesToBase64 } from '../sdk/query'
import { decodeWif } from '../auth/wif'

export { NOTIFY_URL, normalizeUrl } from './config'

// @noble/secp256k1 v3 needs sync hashes wired for sign.
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m)

/** The domain line every signed request starts with (`auth::DOMAIN` in the service). */
export const DOMAIN = 'DashForgeService/v1\n'

/** The actions a signed request can name. */
export type NotifyAction =
  | 'account.get'
  | 'email.set'
  | 'email.remove'
  | 'prefs.set'
  | 'push.add'
  | 'push.remove'
  | 'test.send'
  | 'data.export'
  | 'data.delete'

/** What a subscriber hears about (`store::Prefs`). */
export interface NotifyPrefs {
  participating: boolean
  reviewRequested: boolean
  assigned: boolean
  mentioned: boolean
  watching: boolean
  ownRepos: boolean
  releases: boolean
  privateActivity: boolean
  delivery: 'instant' | 'daily'
  email: boolean
  push: boolean
  mutedRepos: string[]
}

/** `GET /v1/info`. */
export interface NotifyInfo {
  readonly service: string
  readonly version: string
  readonly operator: string
  readonly channels: { readonly email: boolean; readonly push: boolean }
  readonly vapidPublicKey: string | null
  readonly privacyUrl: string | null
  readonly contact: string | null
  readonly digestHourUtc: number
}

/** `account.get` (and `prefs.set`). */
export interface NotifyAccount {
  readonly identity: string
  readonly subscribed: boolean
  readonly prefs: NotifyPrefs
  readonly email?: { readonly address: string | null; readonly verified: boolean; readonly paused: boolean }
  readonly push?: readonly { readonly id: number; readonly label: string | null; readonly createdAt: number }[]
  readonly following?: { readonly repos: number; readonly private: number }
}

/** The key a request is signed with. */
export interface ServiceKey {
  readonly identityId: string
  readonly keyId: number
  readonly wif: string
}

/** A refusal from the service, with its message. */
export class NotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'NotifyError'
  }
}

/** `SHA-256(SHA-256(DOMAIN ‖ request))`. */
export function requestDigest(request: string): Uint8Array {
  return sha256(sha256(new TextEncoder().encode(DOMAIN + request)))
}

/** The base64 compact (r ‖ s, low-S, RFC 6979) signature of `request`. */
export function signRequest(request: string, privateKey: Uint8Array): string {
  return bytesToBase64(secp.sign(requestDigest(request), privateKey, { prehash: false, lowS: true, format: 'compact' }))
}

/** A fresh one-time value: 16 random bytes, base64url. */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return bytesToBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The request text, fields in the documented order. */
export function buildRequest(args: {
  readonly service: string
  readonly action: NotifyAction
  readonly identity: string
  readonly key: number
  readonly nonce: string
  readonly time: number
  readonly payload: unknown
}): string {
  return JSON.stringify({
    v: 1,
    service: args.service,
    action: args.action,
    identity: args.identity,
    key: args.key,
    nonce: args.nonce,
    time: args.time,
    payload: args.payload,
  })
}

async function readJson(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`
    throw new NotifyError(msg, res.status)
  }
  return body
}

/** `GET /v1/info`. */
export async function fetchInfo(base: string): Promise<NotifyInfo> {
  return (await readJson(await fetch(`${base}/v1/info`, { cache: 'no-store' }))) as NotifyInfo
}

/** Sign and send one request. The private key bytes are zeroed after signing. */
export async function call<T>(base: string, info: Pick<NotifyInfo, 'operator'>, key: ServiceKey, action: NotifyAction, payload: unknown = {}): Promise<T> {
  const request = buildRequest({
    service: info.operator,
    action,
    identity: key.identityId,
    key: key.keyId,
    nonce: newNonce(),
    time: Math.floor(Date.now() / 1000),
    payload,
  })
  const { privateKey } = decodeWif(key.wif)
  let signature: string
  try {
    signature = signRequest(request, privateKey)
  } finally {
    privateKey.fill(0)
  }
  const res = await fetch(`${base}/v1/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, signature }),
    cache: 'no-store',
  })
  return (await readJson(res)) as T
}

/** A VAPID key (base64url) as the bytes `pushManager.subscribe` wants. */
export function vapidKeyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Whether this browser can take Web Push at all. */
export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** The `push.add` payload for a browser subscription. */
export function pushPayload(sub: PushSubscription, label: string): { endpoint: string; p256dh: string; auth: string; label: string } {
  const json = sub.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!json.endpoint || !p256dh || !auth) throw new Error('this browser returned an incomplete push subscription')
  return { endpoint: json.endpoint, p256dh, auth, label }
}
