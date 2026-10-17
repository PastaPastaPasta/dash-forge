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
 * `mismatch`, loud); the sets may differ at a rotation boundary, which can take the quorum
 * service about a minute to catch up with: the lists are read again for up to
 * {@link ROTATION_RETRIES_MS} (the page meanwhile says it is still comparing), then `unavailable`. A network with no recorded DAPI list, or none that answers,
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

/** The `v0` body (field 1) of a `GetCurrentQuorumsInfoResponse`. */
function responseV0(message: Uint8Array): Uint8Array {
  const v0 = protoFields(message).find((f) => f.no === 1 && f.bytes !== undefined)?.bytes
  if (v0 === undefined) throw new Error('response has no v0 body')
  return v0
}

/**
 * The `ResponseMetadata` a Platform answer carries (dapi-grpc `platform.proto`, field 5 of
 * `GetCurrentQuorumsInfoResponseV0`). A field the node did not send is undefined: proto3 does
 * not distinguish "absent" from zero on the wire, and a zero here means nothing useful.
 */
export interface ResponseMetadata {
  /** Platform block height (field 1). */
  readonly height?: number
  /** Core chain-locked height (field 2). */
  readonly coreChainLockedHeight?: number
  readonly epoch?: number
  /** The block's time in ms since the epoch (field 4); fits a JS number. */
  readonly timeMs?: number
  /** The Platform protocol version the node runs (field 5). */
  readonly protocolVersion?: number
  /** The chain id, `dash-testnet-51` style (field 6). */
  readonly chainId?: string
}

/** The metadata of a `GetCurrentQuorumsInfoResponse`, or null when the node sent none. */
export function decodeResponseMetadata(message: Uint8Array): ResponseMetadata | null {
  const bytes = protoFields(responseV0(message)).find((f) => f.no === 5 && f.bytes !== undefined)?.bytes
  if (bytes === undefined) return null
  const fields = protoFields(bytes)
  const int = (no: number): number | undefined => {
    const v = fields.find((f) => f.no === no && f.wire === 0)?.int
    return v === undefined || v === 0 ? undefined : v
  }
  const chain = fields.find((f) => f.no === 6 && f.bytes !== undefined)?.bytes
  return {
    height: int(1),
    coreChainLockedHeight: int(2),
    epoch: int(3),
    timeMs: int(4),
    protocolVersion: int(5),
    chainId: chain === undefined || chain.length === 0 ? undefined : new TextDecoder().decode(chain),
  }
}

/** Forge needs contract groups and the other protocol-14 rules: an older node answers from a different network state. */
export const MIN_PLATFORM_PROTOCOL = 14

/**
 * How old a node's latest block may be before its answer is not taken: the SDK's own
 * `DEFAULT_METADATA_TIME_TOLERANCE_MS` (rs-sdk `sdk.rs`, 31 minutes), so a node this check
 * accepts is one the SDK would accept too. A seed stuck on an old block is exactly what fails it.
 */
export const DAPI_METADATA_MAX_AGE_MS = 31 * 60_000

/**
 * Why a node's answer is not a fair second opinion, or null when it is (or carries no metadata,
 * which is taken as before): it runs an older protocol, its latest block is older than
 * {@link DAPI_METADATA_MAX_AGE_MS} (it has stopped following the chain), or it reports another
 * chain than the one this network is known to be (`chainId`, when the deployment records one).
 * A block time ahead of `now` is not held against the node: that is this device's clock
 * (`lib/sdk/clock-skew.ts` reports it).
 */
export function metadataFault(meta: ResponseMetadata | null, now: number, chainId: string | null | undefined): string | null {
  if (meta === null) return null
  if (meta.protocolVersion !== undefined && meta.protocolVersion < MIN_PLATFORM_PROTOCOL) {
    return `node runs protocol ${meta.protocolVersion}, below ${MIN_PLATFORM_PROTOCOL}`
  }
  if (meta.timeMs !== undefined && now - meta.timeMs > DAPI_METADATA_MAX_AGE_MS) {
    return `node's latest block is ${Math.round((now - meta.timeMs) / 60_000)} minutes old`
  }
  if (chainId && meta.chainId !== undefined && meta.chainId !== chainId) {
    return `node reports chain ${meta.chainId}, not ${chainId}`
  }
  return null
}

/**
 * Decode a `GetCurrentQuorumsInfoResponse`: `v0` (field 1) → repeated `validator_sets`
 * (field 3), each `{1: quorum_hash, 2: core_height, 4: threshold_public_key}`.
 */
export function decodeCurrentQuorumsInfo(message: Uint8Array): QuorumKey[] {
  const v0 = responseV0(message)
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
  /** Pauses before each re-read of both lists after they disagreed on which quorums exist. */
  readonly rotationRetriesMs?: readonly number[]
  /** The clock a DAPI answer's block time is held against (tests pin it). */
  readonly now?: () => number
}

/**
 * The pauses before re-reading both lists while they disagree on which quorums exist (QW4-016):
 * a rotation reaches the two sources at different times, and the quorum service has been seen to
 * lag DAPI by about 50 s. About a minute in all, before the comparison is reported as not run.
 */
export const ROTATION_RETRIES_MS: readonly number[] = [2_000, 10_000, 20_000, 25_000]

/** How many DAPI nodes are asked, one after another, before giving up on a second source. */
const DAPI_TRIES = 3

async function fetchServiceKeys(endpoint: string, deps: Required<Pick<CrossCheckDeps, 'fetch' | 'timeoutMs'>>): Promise<QuorumKey[]> {
  const resp = await deps.fetch(`${endpoint.replace(/\/+$/, '')}/quorums`, { signal: AbortSignal.timeout(deps.timeoutMs) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return parseQuorumService(await resp.json())
}

async function fetchDapiKeys(address: string, deps: Required<CrossCheckDeps>, chainId: string | null | undefined): Promise<QuorumKey[]> {
  const resp = await deps.fetch(`${address.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: QUORUMS_INFO_REQUEST,
    signal: AbortSignal.timeout(deps.timeoutMs),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const status = resp.headers.get('grpc-status')
  if (status !== null && status !== '0') throw new Error(`grpc-status ${status}`)
  const message = grpcWebMessage(new Uint8Array(await resp.arrayBuffer()))
  // A node that has stopped following the chain (or runs an older protocol) lists the quorums of
  // its own stale state: asking it would read as a disagreement, or as another network (TEST-04).
  const fault = metadataFault(decodeResponseMetadata(message), deps.now(), chainId)
  if (fault !== null) throw new Error(fault)
  const keys = decodeCurrentQuorumsInfo(message)
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
  chainId: string | null | undefined,
): Promise<{ host: string; keys: QuorumKey[] } | null> {
  for (const address of shuffled(addresses, deps.random).slice(0, DAPI_TRIES)) {
    try {
      return { host: urlHost(address), keys: await fetchDapiKeys(address, deps, chainId) }
    } catch {
      /* next node */
    }
  }
  return null
}

/** Why a quorum service typed in Settings was not taken. */
export type QuorumProbeFailure = 'no-answer' | 'other-network' | 'keys-differ'

export class QuorumProbeError extends Error {
  constructor(readonly reason: QuorumProbeFailure) {
    super(`quorum service refused: ${reason}`)
  }
}

/**
 * Whether `endpoint` can serve this network's quorum keys. Settings asks before saving a
 * quorum service the reader typed, so a typo or another network's service can't stop every
 * read: it must list quorums, and when a Platform node from `dapiAddresses` answers, its keys
 * must not contradict the node's and at least one quorum must be the node's (a quorum only one
 * side lists is a rotation in flight). With no node answering, a service that lists quorums is
 * taken: the default may be what is down.
 */
export async function probeQuorumService(
  endpoint: string,
  dapiAddresses: readonly string[],
  deps: Pick<CrossCheckDeps, 'fetch' | 'timeoutMs' | 'random' | 'now'> = {},
): Promise<void> {
  const full: Required<CrossCheckDeps> = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    random: deps.random ?? Math.random,
    timeoutMs: deps.timeoutMs ?? 8000,
    rotationRetriesMs: [],
    now: deps.now ?? Date.now,
  }
  let keys: QuorumKey[]
  try {
    keys = await fetchServiceKeys(endpoint, full)
  } catch {
    throw new QuorumProbeError('no-answer')
  }
  if (keys.length === 0) throw new QuorumProbeError('no-answer')
  const second = dapiAddresses.length > 0 ? await secondSource(dapiAddresses, full, null) : null
  if (second === null) return
  const verdict = compareQuorumKeys(keys, second.keys)
  if (verdict.kind === 'mismatch') throw new QuorumProbeError('keys-differ')
  if (verdict.kind === 'unconfirmed' && verdict.quorums.length === keys.length) throw new QuorumProbeError('other-network')
}

/** Run the cross-check for `config` (never rejects; the outcome says what happened). */
export async function crossCheckQuorumKeys(config: NetworkConfig, deps: CrossCheckDeps = {}): Promise<QuorumCrossCheck> {
  const full: Required<CrossCheckDeps> = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    random: deps.random ?? Math.random,
    timeoutMs: deps.timeoutMs ?? 6000,
    rotationRetriesMs: deps.rotationRetriesMs ?? ROTATION_RETRIES_MS,
    now: deps.now ?? Date.now,
  }
  const endpoint = quorumEndpoint(config)
  if (endpoint === '') return { state: 'unavailable', reason: 'no quorum key endpoint is configured' }
  const primary = urlHost(endpoint)

  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    let first: QuorumKey[]
    try {
      first = await fetchServiceKeys(endpoint, full)
    } catch (e) {
      return { state: 'unavailable', reason: `${primary} did not answer (${e instanceof Error ? e.message : String(e)})` }
    }
    if (config.dapiAddresses.length === 0) return { state: 'single', primary, reason: 'no-second-source' }
    const second = await secondSource(config.dapiAddresses, full, config.chainId)
    if (second === null) return { state: 'single', primary, reason: 'second-unreachable' }
    const verdict = compareQuorumKeys(first, second.keys)
    if (verdict.kind === 'agree') return { state: 'agreed', primary, secondary: second.host, overlap: verdict.overlap }
    if (verdict.kind === 'mismatch') {
      return { state: 'mismatch', primary, secondary: second.host, quorums: verdict.quorums }
    }
    // A quorum only the primary lists: most likely a rotation one source has not caught up with.
    // Read both again, a little later each time.
    const pause = full.rotationRetriesMs[attempt]
    // Slow answers count too: never past the schedule's own length, plus a little.
    if (pause === undefined || Date.now() - started + pause > ROTATION_DEADLINE_MS) break
    await new Promise((r) => setTimeout(r, pause))
  }
  return { state: 'unavailable', reason: ROTATION_REASON }
}

/** How long one cross-check may keep re-reading through a rotation, slow answers included. */
const ROTATION_DEADLINE_MS = 75_000

/** Why a cross-check gave up: the lists never agreed on which quorums exist. */
export const ROTATION_REASON = 'the two key sources kept listing different quorums (a quorum rotation one of them had not caught up with)'

/** A settled cross-check is re-run once it is this old (quorums rotate; the keys are refetched). */
export const QUORUM_CHECK_MAX_AGE_MS = 60 * 60_000

interface SessionCheck {
  /** The run in flight, if any. */
  running?: Promise<QuorumCrossCheck>
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
  const entry: SessionCheck = sessionChecks.get(config.key) ?? {}
  sessionChecks.set(config.key, entry)
  if (entry.running) return entry.running
  if (entry.settled && quorumCheckDueInMs(config, now()) > 0) return Promise.resolve(entry.settled.result)
  // Never rejects: a check that throws is a transient `unavailable`, re-run by the next view.
  const run = check(config).catch((e: unknown): QuorumCrossCheck => ({
    state: 'unavailable',
    reason: e instanceof Error ? e.message : String(e),
  }))
  entry.running = run
  void run.then((result) => {
    entry.running = undefined
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
