/**
 * Quorum-key cross-check — compare the trust anchor with a second, independent source.
 *
 * Every proof the evo-sdk checks is checked against quorum public keys it fetched from ONE
 * HTTPS endpoint (`quorumEndpoint(config)`, `quorums.<net>.networks.dash.org`). Whoever runs
 * that endpoint could vouch for false data. This module fetches the list again from that
 * endpoint and from DAPI itself (`Platform/getCurrentQuorumsInfo`, grpc-web), and compares the
 * threshold keys quorum by quorum. The SDK's own copy is internal, so the check compares a
 * fresh fetch of the same list, and the UI says so.
 *
 * Rules: every quorum present in both lists must carry the identical key (a mismatch is
 * `mismatch`, loud); the sets may differ at a rotation boundary, but they must overlap, else
 * one retry and then `unavailable`. A network with no recorded DAPI list, or none that answers,
 * reports `single`: one source is all this app could see.
 */

import { z } from 'zod'

import { quorumEndpoint, type NetworkConfig } from '../constants'

/** One quorum's threshold public key, both as lowercase hex. */
export interface QuorumKey {
  readonly hash: string
  readonly key: string
  readonly height: number
}

export type QuorumCrossCheck =
  /** Both sources answered and agree on every shared quorum. */
  | { readonly state: 'agreed'; readonly primary: string; readonly secondary: string; readonly overlap: number }
  /** Only the primary answered: no second source is configured, or none reached. */
  | { readonly state: 'single'; readonly primary: string; readonly reason: 'no-second-source' | 'second-unreachable' }
  /** The sources disagree about a quorum's key: the anchor is not trustworthy. */
  | { readonly state: 'mismatch'; readonly primary: string; readonly secondary: string; readonly quorums: readonly string[] }
  /** The comparison could not run (the primary is down, or the lists never overlapped). */
  | { readonly state: 'unavailable'; readonly reason: string }

// ---------------------------------------------------------------------------
// Protobuf (hand-written reader: the SDK's wrapper drops the keys)
// ---------------------------------------------------------------------------

interface Field {
  readonly no: number
  readonly wire: number
  /** Varint value (wire 0). */
  readonly int?: number
  /** Length-delimited payload (wire 2). */
  readonly bytes?: Uint8Array
}

/** Split a protobuf message into its top-level fields. Throws on a malformed message. */
export function protoFields(buf: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  const varint = (): number => {
    let result = 0
    let scale = 1
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++] as number
      result += (b & 0x7f) * scale
      if (b < 0x80) return result
      scale *= 128
    }
    throw new Error('varint too long')
  }
  while (i < buf.length) {
    const tag = varint()
    const no = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) out.push({ no, wire, int: varint() })
    else if (wire === 2) {
      const len = varint()
      if (i + len > buf.length) throw new Error('truncated field')
      out.push({ no, wire, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4
      if (i > buf.length) throw new Error('truncated fixed field')
    } else throw new Error(`unsupported wire type ${wire}`)
  }
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The first grpc-web DATA frame's message. A trailer frame (flag bit 7) carrying a non-zero
 * `grpc-status` is an error; a response with no data frame at all is one too.
 */
export function grpcWebMessage(body: Uint8Array): Uint8Array {
  let i = 0
  let message: Uint8Array | null = null
  while (i + 5 <= body.length) {
    const flag = body[i] as number
    const len = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0, false)
    const payload = body.subarray(i + 5, i + 5 + len)
    if (payload.length !== len) throw new Error('truncated grpc-web frame')
    if ((flag & 0x80) !== 0) {
      const status = /grpc-status:\s*(\d+)/i.exec(new TextDecoder().decode(payload))?.[1]
      if (status !== undefined && status !== '0') throw new Error(`DAPI answered grpc-status ${status}`)
    } else if (message === null) message = payload
    i += 5 + len
  }
  if (message === null) throw new Error('DAPI sent no message')
  return message
}

/**
 * Decode a `GetCurrentQuorumsInfoResponse`: `v0` (field 1) → repeated `validator_sets`
 * (field 3), each `{1: quorum_hash, 2: core_height, 4: threshold_public_key}`.
 */
export function decodeCurrentQuorumsInfo(message: Uint8Array): QuorumKey[] {
  const v0 = protoFields(message).find((f) => f.no === 1 && f.bytes !== undefined)?.bytes
  if (v0 === undefined) throw new Error('response has no v0 body')
  const out: QuorumKey[] = []
  for (const set of protoFields(v0)) {
    if (set.no !== 3 || set.bytes === undefined) continue
    const fields = protoFields(set.bytes)
    const hash = fields.find((f) => f.no === 1)?.bytes
    const key = fields.find((f) => f.no === 4)?.bytes
    if (hash === undefined || key === undefined || key.length !== 48) continue
    out.push({ hash: hex(hash), key: hex(key), height: fields.find((f) => f.no === 2)?.int ?? 0 })
  }
  return out
}

/** The grpc-web request body: the 5-byte frame header, then `GetCurrentQuorumsInfoRequest{v0:{}}`. */
export const QUORUMS_INFO_REQUEST = new Uint8Array([0, 0, 0, 0, 2, 0x0a, 0x00])

// ---------------------------------------------------------------------------
// Quorum service JSON (trust boundary: parsed, not cast)
// ---------------------------------------------------------------------------

const HEX = /^[0-9a-fA-F]+$/
const QuorumServiceSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      quorum_hash: z.string().regex(HEX),
      key: z.string().regex(HEX).length(96),
      height: z.number().int().nonnegative(),
    }),
  ),
})

/** Parse the quorum service's `/quorums` answer. */
export function parseQuorumService(json: unknown): QuorumKey[] {
  const parsed = QuorumServiceSchema.parse(json)
  return parsed.data.map((q) => ({ hash: q.quorum_hash.toLowerCase(), key: q.key.toLowerCase(), height: q.height }))
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type QuorumComparison =
  | { readonly kind: 'agree'; readonly overlap: number }
  | { readonly kind: 'mismatch'; readonly quorums: readonly string[] }
  | { readonly kind: 'no-overlap' }

/** Compare two key lists by quorum hash. */
export function compareQuorumKeys(a: readonly QuorumKey[], b: readonly QuorumKey[]): QuorumComparison {
  const byHash = new Map(a.map((q) => [q.hash, q.key]))
  let overlap = 0
  const mismatched: string[] = []
  for (const q of b) {
    const other = byHash.get(q.hash)
    if (other === undefined) continue
    overlap += 1
    if (other !== q.key) mismatched.push(q.hash)
  }
  if (mismatched.length > 0) return { kind: 'mismatch', quorums: mismatched }
  return overlap === 0 ? { kind: 'no-overlap' } : { kind: 'agree', overlap }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface CrossCheckDeps {
  readonly fetch?: typeof fetch
  /** Randomness for the DAPI node order (tests pin it). */
  readonly random?: () => number
  readonly timeoutMs?: number
}

/** How many DAPI nodes are asked, one after another, before giving up on a second source. */
const DAPI_TRIES = 3

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchServiceKeys(endpoint: string, deps: Required<CrossCheckDeps>): Promise<QuorumKey[]> {
  return withTimeout(deps.timeoutMs, async (signal) => {
    const resp = await deps.fetch(`${endpoint.replace(/\/+$/, '')}/quorums`, { signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return parseQuorumService(await resp.json())
  })
}

async function fetchDapiKeys(address: string, deps: Required<CrossCheckDeps>): Promise<QuorumKey[]> {
  return withTimeout(deps.timeoutMs, async (signal) => {
    const resp = await deps.fetch(`${address.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: QUORUMS_INFO_REQUEST,
      signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const status = resp.headers.get('grpc-status')
    if (status !== null && status !== '0') throw new Error(`grpc-status ${status}`)
    const keys = decodeCurrentQuorumsInfo(grpcWebMessage(new Uint8Array(await resp.arrayBuffer())))
    if (keys.length === 0) throw new Error('no validator sets')
    return keys
  })
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** The first of up to {@link DAPI_TRIES} random DAPI nodes that answers, or null. */
async function secondSource(
  addresses: readonly string[],
  deps: Required<CrossCheckDeps>,
): Promise<{ host: string; keys: QuorumKey[] } | null> {
  for (const address of shuffled(addresses, deps.random).slice(0, DAPI_TRIES)) {
    try {
      return { host: hostOf(address), keys: await fetchDapiKeys(address, deps) }
    } catch {
      /* next node */
    }
  }
  return null
}

/** Run the cross-check for `config` (never rejects; the outcome says what happened). */
export async function crossCheckQuorumKeys(config: NetworkConfig, deps: CrossCheckDeps = {}): Promise<QuorumCrossCheck> {
  const full: Required<CrossCheckDeps> = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    random: deps.random ?? Math.random,
    timeoutMs: deps.timeoutMs ?? 6000,
  }
  const endpoint = quorumEndpoint(config)
  if (endpoint === '') return { state: 'unavailable', reason: 'no quorum key endpoint is configured' }
  const primary = hostOf(endpoint)

  for (let attempt = 0; attempt < 2; attempt++) {
    let first: QuorumKey[]
    try {
      first = await fetchServiceKeys(endpoint, full)
    } catch (e) {
      return { state: 'unavailable', reason: `${primary} did not answer (${e instanceof Error ? e.message : String(e)})` }
    }
    if (config.dapiAddresses.length === 0) return { state: 'single', primary, reason: 'no-second-source' }
    const second = await secondSource(config.dapiAddresses, full)
    if (second === null) return { state: 'single', primary, reason: 'second-unreachable' }
    const verdict = compareQuorumKeys(first, second.keys)
    if (verdict.kind === 'agree') return { state: 'agreed', primary, secondary: second.host, overlap: verdict.overlap }
    if (verdict.kind === 'mismatch') {
      return { state: 'mismatch', primary, secondary: second.host, quorums: verdict.quorums }
    }
    // No shared quorum: a rotation boundary between the two reads. Read both again once.
  }
  return { state: 'unavailable', reason: 'the two key sources never listed the same quorum' }
}

const sessionChecks = new Map<string, Promise<QuorumCrossCheck>>()

/**
 * {@link crossCheckQuorumKeys} once per network per session. An `unavailable` outcome is not
 * kept, so a later view (back online) runs the check again.
 */
export function crossCheckQuorumKeysCached(config: NetworkConfig): Promise<QuorumCrossCheck> {
  const hit = sessionChecks.get(config.key)
  if (hit !== undefined) return hit
  const run = crossCheckQuorumKeys(config)
  sessionChecks.set(config.key, run)
  void run.then((r) => {
    if (r.state === 'unavailable' && sessionChecks.get(config.key) === run) sessionChecks.delete(config.key)
  })
  return run
}
