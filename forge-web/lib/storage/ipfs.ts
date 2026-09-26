/**
 * IPFS from the browser: kubo's RPC API (`add` with Forge's pinned import parameters, `pin/ls`,
 * `pin/rm`, `id`) and the IPFS Pinning Service API (`POST /pins`, `GET /pins/<id>`). Port of
 * forge-core `backends/ipfs.rs`: the CID kubo returns must equal the local re-derivation
 * (`./cid`), and the node must report it pinned, before any URI is recorded.
 *
 * kubo's RPC API refuses cross-origin calls unless `API.HTTPHeaders.Access-Control-Allow-Origin`
 * lists this origin (it answers 403 otherwise); the wizard prints the `ipfs config` lines.
 */

import { cidV1RawLeaves, isCid } from './cid'
import type { ProfilePublic, ProfileSecrets } from './profiles'

export type IpfsSettings = Extract<ProfilePublic, { kind: 'ipfs-kubo' | 'ipfs-pinning-service' }>

/** The kubo `add` query pinning every import parameter the local CID derivation assumes. */
export const ADD_PARAMS =
  'cid-version=1&raw-leaves=true&chunker=size-262144&hash=sha2-256&trickle=false&max-file-links=174&pin=true&quieter=true'

const RPC_TIMEOUT_MS = 60_000
const PIN_TIMEOUT_MS = 120_000
const PIN_POLL_MS = 2_000

export class IpfsError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(message)
    this.name = 'IpfsError'
  }
}

async function rpc(s: IpfsSettings, secrets: ProfileSecrets, op: string, pathAndQuery: string, body?: FormData): Promise<string> {
  const headers = new Headers()
  if (secrets.apiAuth) headers.set('authorization', secrets.apiAuth)
  const url = `${s.api.replace(/\/+$/, '')}/api/v0/${pathAndQuery}`
  let resp: Response
  try {
    resp = await fetch(url, { method: 'POST', headers, ...(body ? { body } : {}), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  } catch (e) {
    throw new IpfsError(op, `${op}: the kubo API at ${new URL(url).host} is unreachable or refused this origin (CORS)${e instanceof Error ? ` (${e.message})` : ''}`)
  }
  const text = await resp.text()
  if (!resp.ok) {
    const msg = /"Message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1] ?? text.slice(0, 200)
    const hint = resp.status === 403 ? ' — kubo refuses this origin: allow it in API.HTTPHeaders (see the fix below)' : ''
    throw new IpfsError(op, `${op} failed: HTTP ${resp.status} ${msg}${hint}`)
  }
  return text
}

/** Let kubo's "not pinned" answer through as '' (nothing pinned); rethrow anything else. */
function ignoreNotPinned(e: unknown): string {
  if (e instanceof IpfsError && /not pinned/.test(e.message)) return ''
  throw e
}

/** kubo's version (`/api/v0/version`), a cheap reachability check. */
export async function kuboVersion(s: IpfsSettings, secrets: ProfileSecrets): Promise<string> {
  const text = await rpc(s, secrets, 'version', 'version')
  return /"Version"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? 'unknown'
}

/** Add `bytes` with the pinned parameters; the CID must equal the local derivation and be pinned. */
export async function addVerified(s: IpfsSettings, secrets: ProfileSecrets, bytes: Uint8Array): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)]), 'pack')
  const text = await rpc(s, secrets, 'ipfs add', `add?${ADD_PARAMS}`, form)
  const line = text.trim().split('\n').pop() ?? ''
  const cid = /"Hash"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? ''
  const expected = cidV1RawLeaves(bytes)
  if (cid !== expected) {
    throw new IpfsError('ipfs add', `kubo returned CID ${cid || '(none)'} but these bytes derive to ${expected} under the pinned import parameters; refusing to record it`)
  }
  const pinned = await rpc(s, secrets, 'pin check', `pin/ls?arg=${cid}&type=recursive`).catch(ignoreNotPinned)
  if (!pinned.includes(cid)) throw new IpfsError('pin check', `kubo added ${cid} but does not report it pinned; a gc would drop it`)
  return cid
}

/** Unpin `cid` (the wizard's probe cleanup). A CID that is not pinned is fine. */
export async function unpin(s: IpfsSettings, secrets: ProfileSecrets, cid: string): Promise<void> {
  if (!isCid(cid)) throw new IpfsError('unpin', 'not a CID')
  await rpc(s, secrets, 'unpin', `pin/rm?arg=${cid}`).catch(ignoreNotPinned)
}

/** The node's announced multiaddrs, handed to a pinning service as `origins`. */
async function origins(s: IpfsSettings, secrets: ProfileSecrets): Promise<string[]> {
  try {
    const text = await rpc(s, secrets, 'id', 'id')
    const parsed: unknown = JSON.parse(text)
    const addrs = parsed && typeof parsed === 'object' ? (parsed as { Addresses?: unknown }).Addresses : undefined
    return Array.isArray(addrs) ? addrs.filter((a): a is string => typeof a === 'string').slice(0, 20) : []
  } catch {
    return []
  }
}

interface PinStatus {
  readonly requestid: string
  readonly status: string
}

async function psa(s: IpfsSettings, secrets: ProfileSecrets, op: string, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!secrets.pinningToken) throw new IpfsError(op, 'the pinning service needs an access token')
  const url = `${s.pinningEndpoint.replace(/\/+$/, '')}${path}`
  let resp: Response
  try {
    resp = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${secrets.pinningToken}`, 'content-type': 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
  } catch (e) {
    throw new IpfsError(op, `${op}: the pinning service is unreachable or refused this origin (CORS)${e instanceof Error ? ` (${e.message})` : ''}`)
  }
  if (!resp.ok) {
    const hint = resp.status === 401 || resp.status === 403 ? ' — check the access token' : ''
    throw new IpfsError(op, `${op} failed: HTTP ${resp.status}${hint}`)
  }
  return resp.json() as Promise<unknown>
}

function pinStatus(v: unknown): PinStatus {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const requestid = typeof o['requestid'] === 'string' ? o['requestid'] : ''
  const status = typeof o['status'] === 'string' ? o['status'] : ''
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestid)) throw new IpfsError('pin', 'the pinning service returned a malformed request id')
  return { requestid, status }
}

/** An authenticated no-op against the pinning service (`GET /pins?limit=1`). */
export async function pinningReachable(s: IpfsSettings, secrets: ProfileSecrets): Promise<void> {
  await psa(s, secrets, 'pinning service', '/pins?limit=1')
}

/**
 * Pin `cid` on the pinning service and wait for `pinned`. An existing request for the CID is
 * reused (a re-push pays nothing twice).
 */
export async function remotePin(s: IpfsSettings, secrets: ProfileSecrets, cid: string, name: string): Promise<void> {
  if (!isCid(cid)) throw new IpfsError('pin', 'not a CID')
  const found = await psa(s, secrets, 'pin lookup', `/pins?cid=${cid}&status=queued,pinning,pinned`)
  const results = found && typeof found === 'object' ? (found as { results?: unknown }).results : undefined
  const existing = Array.isArray(results) ? results.map(pinStatus) : []
  if (existing.some((p) => p.status === 'pinned')) return
  let pin = existing.find((p) => p.status === 'queued' || p.status === 'pinning')
  if (!pin) {
    pin = pinStatus(await psa(s, secrets, 'pin', '/pins', { method: 'POST', body: JSON.stringify({ cid, name, origins: await origins(s, secrets) }) }))
  }
  const deadline = Date.now() + PIN_TIMEOUT_MS
  for (;;) {
    if (pin.status === 'pinned') return
    if (pin.status === 'failed') throw new IpfsError('pin', `the pinning service reports request ${pin.requestid} failed`)
    if (Date.now() >= deadline) {
      throw new IpfsError('pin', `the pin is still ${pin.status} after ${PIN_TIMEOUT_MS / 1000}s; the service may not be able to reach your kubo node`)
    }
    await new Promise((r) => setTimeout(r, PIN_POLL_MS))
    pin = pinStatus(await psa(s, secrets, 'pin status', `/pins/${pin.requestid}`))
  }
}

/** The gateway URL of `cid` on `gateway`. */
export function gatewayUrl(gateway: string, cid: string): string {
  return `${gateway.replace(/\/+$/, '')}/ipfs/${cid}`
}
