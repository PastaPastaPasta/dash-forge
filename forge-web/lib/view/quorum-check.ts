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

import { bytesToHex } from '@noble/hashes/utils.js'
import { z } from 'zod'

import { quorumEndpoint, type NetworkConfig } from '../constants'
import { urlHost } from './format'

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
    out.push({ hash: bytesToHex(hash), key: bytesToHex(key), height: fields.find((f) => f.no === 2)?.int ?? 0 })
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
  /** Some quorum the primary lists is not in the second list: nothing independent vouches for it. */
  | { readonly kind: 'unconfirmed'; readonly quorums: readonly string[] }

function duplicates(list: readonly QuorumKey[]): string[] {
  const seen = new Set<string>()
  return list.filter((q) => seen.size === seen.add(q.hash).size).map((q) => q.hash)
}

/**
 * Compare the trust anchor's key list (`primary`, what the SDK is given) with an independent
 * one. Every primary quorum must appear in the second list with the identical key: a key only
 * the primary lists is exactly what a lying endpoint would add. Extra quorums on the second
 * side are harmless (the SDK cannot use a key it was never given). A hash listed twice on
 * either side is a mismatch: which copy a verifier uses is not defined.
 */
export function compareQuorumKeys(primary: readonly QuorumKey[], second: readonly QuorumKey[]): QuorumComparison {
  const dupes = [...new Set([...duplicates(primary), ...duplicates(second)])]
  if (dupes.length > 0) return { kind: 'mismatch', quorums: dupes }
  const byHash = new Map(second.map((q) => [q.hash, q.key]))
  const mismatched = primary.filter((q) => byHash.has(q.hash) && byHash.get(q.hash) !== q.key).map((q) => q.hash)
  if (mismatched.length > 0) return { kind: 'mismatch', quorums: mismatched }
  const unconfirmed = primary.filter((q) => !byHash.has(q.hash)).map((q) => q.hash)
  if (unconfirmed.length > 0 || primary.length === 0) return { kind: 'unconfirmed', quorums: unconfirmed }
  return { kind: 'agree', overlap: primary.length }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface CrossCheckDeps {
  readonly fetch?: typeof fetch
  /** Randomness for the DAPI node order (tests pin it). */
  readonly random?: () => number
  readonly timeoutMs?: number
  /** Pause before re-reading both lists after they disagreed on which quorums exist. */
  readonly retryDelayMs?: number
}

/** How many DAPI nodes are asked, one after another, before giving up on a second source. */
const DAPI_TRIES = 3

async function fetchServiceKeys(endpoint: string, deps: Required<CrossCheckDeps>): Promise<QuorumKey[]> {
  const resp = await deps.fetch(`${endpoint.replace(/\/+$/, '')}/quorums`, { signal: AbortSignal.timeout(deps.timeoutMs) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return parseQuorumService(await resp.json())
}

async function fetchDapiKeys(address: string, deps: Required<CrossCheckDeps>): Promise<QuorumKey[]> {
  const resp = await deps.fetch(`${address.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: QUORUMS_INFO_REQUEST,
    signal: AbortSignal.timeout(deps.timeoutMs),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const status = resp.headers.get('grpc-status')
  if (status !== null && status !== '0') throw new Error(`grpc-status ${status}`)
  const keys = decodeCurrentQuorumsInfo(grpcWebMessage(new Uint8Array(await resp.arrayBuffer())))
  if (keys.length === 0) throw new Error('no validator sets')
  return keys
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
      return { host: urlHost(address), keys: await fetchDapiKeys(address, deps) }
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
    retryDelayMs: deps.retryDelayMs ?? 2000,
  }
  const endpoint = quorumEndpoint(config)
  if (endpoint === '') return { state: 'unavailable', reason: 'no quorum key endpoint is configured' }
  const primary = urlHost(endpoint)

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
    // A quorum only the primary lists: most likely a rotation between the two reads. Read
    // both again once, a moment later.
    if (attempt === 0) await new Promise((r) => setTimeout(r, full.retryDelayMs))
  }
  return { state: 'unavailable', reason: 'the two key sources listed different quorums' }
}

/** A settled cross-check is re-run once it is this old (quorums rotate; the keys are refetched). */
export const QUORUM_CHECK_MAX_AGE_MS = 60 * 60_000

interface SessionCheck {
  /** The latest run (settled or still going). */
  run: Promise<QuorumCrossCheck>
  running: boolean
  /** The latest settled outcome and when it settled (kept while a newer run goes). */
  settled?: { readonly result: QuorumCrossCheck; readonly at: number }
}

const sessionChecks = new Map<string, SessionCheck>()

/** The last settled cross-check for `config` this session, whatever its age (shown while a new one runs). */
export function lastQuorumCheck(config: NetworkConfig): QuorumCrossCheck | undefined {
  return sessionChecks.get(config.key)?.settled?.result
}

/**
 * How long until `config`'s settled cross-check is due again: 0 when due now, when none has
 * settled, or when the last one was transient (it is re-run by the next check).
 */
export function quorumCheckDueInMs(config: NetworkConfig, now = Date.now()): number {
  const settled = sessionChecks.get(config.key)?.settled
  if (settled === undefined || isTransient(settled.result)) return 0
  return Math.max(0, settled.at + QUORUM_CHECK_MAX_AGE_MS - now)
}

/**
 * {@link crossCheckQuorumKeys} once per network, and again once the result is
 * {@link QUORUM_CHECK_MAX_AGE_MS} old; a routine reconnect does not re-run it. An outcome that
 * depends on a network hiccup (`unavailable`, or no DAPI node answering) is re-run by the next
 * view. {@link lastQuorumCheck} keeps the previous outcome readable while a new run goes.
 */
export function crossCheckQuorumKeysCached(
  config: NetworkConfig,
  { now = Date.now, check = crossCheckQuorumKeys }: { now?: () => number; check?: (c: NetworkConfig) => Promise<QuorumCrossCheck> } = {},
): Promise<QuorumCrossCheck> {
  const entry = sessionChecks.get(config.key) ?? { run: Promise.resolve({ state: 'unavailable', reason: '' } as QuorumCrossCheck), running: false }
  sessionChecks.set(config.key, entry)
  const fresh = entry.settled !== undefined && now() - entry.settled.at < QUORUM_CHECK_MAX_AGE_MS && !isTransient(entry.settled.result)
  if (entry.running || fresh) return entry.run
  // Never rejects: a check that throws is a transient `unavailable`, re-run by the next view.
  const run = check(config).catch((e: unknown): QuorumCrossCheck => ({
    state: 'unavailable',
    reason: e instanceof Error ? e.message : String(e),
  }))
  entry.run = run
  entry.running = true
  void run.then((result) => {
    if (entry.run !== run) return
    entry.running = false
    entry.settled = { result, at: now() }
  })
  return run
}

function isTransient(r: QuorumCrossCheck): boolean {
  return r.state === 'unavailable' || (r.state === 'single' && r.reason === 'second-unreachable')
}

/** Forget every cached cross-check (tests). */
export function resetQuorumChecks(): void {
  sessionChecks.clear()
}
