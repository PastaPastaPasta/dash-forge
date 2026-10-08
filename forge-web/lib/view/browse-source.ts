/**
 * Browse-plane data source (view glue) — turns Platform `chunk` documents / external URIs
 * into the ranged byte access {@link BrowseReader} + {@link ObjectLocator} need.
 *
 * An artifact (objectLocator, flatIndex, or git pack) is identified by its `packHash` and
 * stored either as on-platform `chunk` docs (`storage 0`, `d0..d2` byteArrays reassembled by
 * `seq`) or at external `uris` (`storage 1`, fetched with HTTP Range). This module reassembles
 * either into a {@link RangeFetch}, and builds a {@link PackSource} over a repo's git-pack
 * manifests so blob/tree/commit reconstruction works without materializing the repo.
 *
 * Availability is best-effort and honestly surfaced: a repo that never published browse
 * artifacts (no locator/flatIndex manifest) degrades to a clear "not indexed yet" state in
 * the UI rather than a hard failure.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { shortId } from '../utils'

import { ACTIVE_NETWORK, CHUNK_PAYLOAD_MAX, PACK_KIND } from '../constants'
import { keepIndexRange, loadIndexArtifact, storedIndexArtifact, storedIndexRanges } from './index-cache'
import { endIndexProgress, noteIndexProgress } from './index-progress'
import { attachHistory, chainHistory, historySource, type HistorySource } from './history-source'
import {
  BrowseReader,
  FANOUT_LEN,
  FlatIndex,
  FragmentedIndex,
  MissingObjectError,
  ObjectLocator,
  RangedLocator,
  type ObjectIndex,
  type PackSource,
} from '../browse'
import {
  CHUNK_QUERY_MAX,
  contractOf,
  DOC,
  readPackCopies,
  packsOfKind,
  type AsOf,
  readNewestManifestOfKind,
  readBrowseManifests,
  readForkParent,
  staleRepoTimelines,
  onRepoContentWritten,
  repoKey,
  repoSource,
  type PackManifest,
  type RepoRef,
} from '../repo'
import { base64ToBytes, queryDocumentsWithProof } from '../sdk'
import { isPublicHttpsUrl } from '../net'
import { externalSourceName, noteContentCheck, noteViewPack, objectObserver } from './content-checks'
import { noteReadOutage } from './reconnect'
import {
  describePack,
  gatewayDownReason,
  gatewayHealth,
  gatewayOf,
  noteRepoGateways,
  readGateways,
  readGatewaysFor,
  resetGatewayHealth,
  resetRepoGateways,
} from './storage-status'
import { mapPooled, trimOldest } from './pool'
import { openPrivateArtifact, readPrivateRange } from './private-packs'
import { onPrivateSessionEnded, type PrivateSession } from '../repo/private-session'
import { knownConversion } from '../repo/converted'
import { HEADER_LEN, PackError, maybeSealed, skipReason, sniff, type Conversion, type SkipReason } from '../private'
import { mirrorCopy, mirrorUrisOf, resetMirrorUris } from '../repo/pack-mirrors'

/** Chunk queries in flight at once when one range spans more than a single query. */
const CHUNK_QUERY_POOL = 6

/**
 * Chunk queries in flight at once across every read of the session. Each range pools its own
 * batches ({@link CHUNK_QUERY_POOL}), but a diff counting two dozen files over several packs, or
 * rename detection reading candidates, runs many ranges side by side; without one global bound a
 * turn could send ~50 proof-verified queries at once.
 */
export const CHUNK_QUERIES_IN_FLIGHT = 16
const chunkQuerySlots = { active: 0, waiting: [] as (() => void)[] }

/**
 * Run `run` on the next macrotask. A `MessageChannel` post, not `setTimeout(0)`: browsers clamp
 * timers in background tabs to ~1 s, which would stall every serial round of chunk reads while
 * the tab is hidden. `setTimeout` only where there is no `MessageChannel`.
 */
function nextMacrotask(run: () => void): void {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(run, 0)
    return
  }
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    run()
  }
  channel.port2.postMessage(null)
}

/** Concatenate the `d0..d2` byteArray fields (base64) of one chunk row, in order. */
function chunkPayload(doc: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const f of ['d0', 'd1', 'd2']) {
    const v = doc[f]
    if (typeof v === 'string' && v.length > 0) parts.push(base64ToBytes(v))
  }
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Chunk LRU — session cache of platform `chunk` payloads
// ---------------------------------------------------------------------------

/**
 * Chunk documents are immutable, so a session-wide LRU keyed by everything a chunk query is
 * scoped by ({@link chunkCopyKey}) serves exactly the bytes asking again would. A chunk carries
 * no digest of its own (`packHash` is the whole artifact's sha256), so a copy whose whole
 * artifact fails that check has its chunks dropped ({@link forgetChunks}). Entries hold the
 * fetch PROMISE, so concurrent reads of the same chunk dedupe to one query. Only resolved entries carry a size and count toward
 * the budget; rejected fetches are evicted so a retry re-queries. Map insertion order is
 * the recency order (touched entries are re-inserted).
 */
const CHUNK_CACHE_BUDGET_BYTES = 32 * 1024 * 1024
interface ChunkCacheEntry {
  promise: Promise<Uint8Array>
  /** Set once resolved; undefined while in flight. */
  size?: number
}
const chunkCache = new Map<string, ChunkCacheEntry>()
let chunkCacheBytes = 0

function chunkCacheGet(key: string): Promise<Uint8Array> | undefined {
  const entry = chunkCache.get(key)
  if (entry === undefined) return undefined
  // Touch: re-insert so Map order stays least-recently-used-first.
  chunkCache.delete(key)
  chunkCache.set(key, entry)
  return entry.promise
}

function chunkCacheSet(key: string, promise: Promise<Uint8Array>): void {
  const entry: ChunkCacheEntry = { promise }
  chunkCache.set(key, entry)
  promise
    .then((bytes) => {
      if (chunkCache.get(key) !== entry) return
      entry.size = bytes.length
      chunkCacheBytes += bytes.length
      evictChunks()
    })
    .catch(() => {
      if (chunkCache.get(key) === entry) chunkCache.delete(key)
    })
}

function evictChunks(): void {
  for (const [key, entry] of chunkCache) {
    if (chunkCacheBytes <= CHUNK_CACHE_BUDGET_BYTES) break
    if (entry.size === undefined) continue // in flight — a caller still awaits it
    chunkCache.delete(key)
    chunkCacheBytes -= entry.size
  }
}

/**
 * The cache key of one copy of an artifact: every scope its chunk query has — the network, the
 * contract, the repo, the uploader and the pack hash. A hostile copy's chunks must never be served
 * for an honest one (every writer has its own copy of a pack, `forge-v2.md` §4), nor one repo's for
 * another's. A fork reads its parent's chunks under the parent's repo id, so the two share entries.
 */
function chunkCopyKey(repo: RepoRef, manifest: PackManifest): string {
  return `${copyScope(repo, manifest)}:${manifest.packHash}`
}

/** Whose chunks a copy is: the network, contract, repo and uploader its chunk query names. */
function copyScope(repo: RepoRef, manifest: PackManifest): string {
  return `${ACTIVE_NETWORK.key}:${contractOf(repo.forge, DOC.chunk)}:${repoKey(repo)}:${manifest.uploader}`
}

/** Drop the cached chunks of a copy whose whole artifact did not hash to its `packHash`. */
function forgetChunks(repo: RepoRef, manifest: PackManifest): void {
  const prefix = `${chunkCopyKey(repo, manifest)}:`
  for (const [key, entry] of chunkCache) {
    if (!key.startsWith(prefix)) continue
    chunkCache.delete(key)
    if (entry.size !== undefined) chunkCacheBytes -= entry.size
  }
}

/** Test hook: drop all cached chunks (and reset the byte budget). */
export function clearChunkCache(): void {
  chunkCache.clear()
  chunkCacheBytes = 0
  chunkQueriesSent = 0
  pendingChunkQueries.clear()
}

/** Query one batch of chunk docs (uncached) and return payloads keyed by seq. */
async function queryChunkBatch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  seqs: readonly number[],
): Promise<Map<number, Uint8Array>> {
  const source = repoSource(repo)
  // One query returns at most CHUNK_QUERY_MAX rows, so a request spanning more seqs than
  // that is split into several parallel queries rather than silently coming back short.
  // Without this split a single range spanning more than 100 chunks could never load, which
  // capped any artifact at ~1.47 MB — the browse plane's hard ceiling at roughly 40k
  // objects. `seq` is unique per `packHash`, so each sub-batch is exact and no
  // `in`-starvation fallback is needed.
  const batches: number[][] = []
  for (let i = 0; i < seqs.length; i += CHUNK_QUERY_MAX) {
    batches.push([...seqs.slice(i, i + CHUNK_QUERY_MAX)])
  }

  const bySeq = new Map<number, Uint8Array>()
  // Bounded concurrency, not `Promise.all` over every batch. A whole-artifact range on a
  // large pack spans thousands of chunk documents — a 100 MB artifact is ~7,100 docs, i.e.
  // ~72 batches — and firing those at once means 72 simultaneous proof-verified queries
  // with all-or-nothing failure and no bound on peak memory. A small pool keeps the
  // round-trip overlap that makes this fast without turning one read into a burst.
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const batch = batches[i]
      if (batch === undefined) return
      const { documents } = await withSlotOf(chunkQuerySlots, CHUNK_QUERIES_IN_FLIGHT, () =>
        queryDocumentsWithProof(sdk, source.chunkQuery(manifest.packHash, manifest.uploader, batch)),
      )
      for (const doc of documents) {
        const raw = doc['seq']
        const seq = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : -1
        // `seq` is unique per `packHash`, so no batch can claim a seq another already set.
        if (seq >= 0) bySeq.set(seq, chunkPayload(doc))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_QUERY_POOL, batches.length) }, worker))
  return bySeq
}

/**
 * Chunk seqs asked for in the same turn of the event loop, per copy of an artifact, gathered into
 * one query (QW-027/QW-028): reads that run side by side (a pool of blob reads counting a diff's
 * lines, a tree walk's parallel reads, Blame's read-ahead) each need a chunk or two, and each used to
 * cost a query of its own. Gathered, they share queries of up to {@link CHUNK_QUERY_MAX} seqs
 * ({@link queryChunkBatch} splits and pools past that). A copy's seqs are unique per `packHash`,
 * so a gathered answer serves each asker exactly its own seqs.
 */
interface PendingChunkQuery {
  readonly seqs: Set<number>
  readonly result: Promise<Map<number, Uint8Array>>
}
const pendingChunkQueries = new Map<string, PendingChunkQuery>()

let chunkQueriesSent = 0

/** Test hook: how many chunk queries {@link queueChunkSeqs} has sent since {@link clearChunkCache}. */
export function chunkQueryCount(): number {
  return chunkQueriesSent
}

/**
 * `seqs` of the copy keyed `key`, fetched with the other seqs asked for this turn (one macrotask:
 * the continuations of reads that just landed together get to ask first), in one query while they
 * fit one ({@link CHUNK_QUERY_MAX}); past that, the next asker starts a new query rather than make
 * everyone wait for a bigger one. `query` fetches a gathered set; the first asker's is used.
 */
export function queueChunkSeqs(
  key: string,
  seqs: readonly number[],
  query: (seqs: readonly number[]) => Promise<Map<number, Uint8Array>>,
): Promise<Map<number, Uint8Array>> {
  let pending = pendingChunkQueries.get(key)
  if (pending !== undefined && pending.seqs.size + seqs.filter((q) => !pending?.seqs.has(q)).length > CHUNK_QUERY_MAX) pending = undefined
  if (pending === undefined) {
    const gathered = new Set<number>()
    const result = new Promise<Map<number, Uint8Array>>((resolve, reject) => {
      nextMacrotask(() => {
        if (pendingChunkQueries.get(key)?.seqs === gathered) pendingChunkQueries.delete(key)
        chunkQueriesSent += Math.ceil(gathered.size / CHUNK_QUERY_MAX)
        query([...gathered].sort((a, b) => a - b)).then(resolve, reject)
      })
    })
    pending = { seqs: gathered, result }
    pendingChunkQueries.set(key, pending)
  }
  for (const seq of seqs) pending.seqs.add(seq)
  return pending.result
}

/**
 * Fetch a contiguous `[start, end)` range of a platform-stored artifact by `packHash` (hex).
 *
 * OFFSET→SEQ MAPPING (VERIFIED against forge-core `pack.rs::split`): the chunker fills every
 * field to `FIELD_MAX` and every chunk to `FIELDS_PER_DOC` full fields before starting the
 * next, so **every chunk except the last carries exactly `CHUNK_PAYLOAD_MAX` (= FIELD_MAX ×
 * FIELDS = 4900 × 3 = 14700) bytes**. Byte offset `n` therefore lives in `seq = ⌊n /
 * CHUNK_PAYLOAD_MAX⌋` at intra-chunk offset `n mod CHUNK_PAYLOAD_MAX`. The last chunk is
 * shorter, but a range never reads past the artifact's `sizeBytes`, so the last `seq` is
 * always resolved from the row actually returned (its real length), never assumed full.
 *
 * Chunk payloads are served through the session LRU: only the seqs absent from the cache
 * are queried (one batch — the chunk index, `(repoId, $ownerId, packHash, seq)`, is unique
 * per key, so no
 * `in`-starvation fallback is needed), and every fetched chunk is cached for later ranges.
 */
async function fetchPlatformRange(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const packHashHex = manifest.packHash
  const cachePrefix = chunkCopyKey(repo, manifest)
  const firstSeq = Math.floor(start / CHUNK_PAYLOAD_MAX)
  const lastSeq = Math.floor((end - 1) / CHUNK_PAYLOAD_MAX)
  const seqs: number[] = []
  for (let s = firstSeq; s <= lastSeq; s++) seqs.push(s)

  const held = new Map<number, Promise<Uint8Array>>()
  const missing: number[] = []
  for (const seq of seqs) {
    const hit = chunkCacheGet(`${cachePrefix}:${seq}`)
    if (hit !== undefined) held.set(seq, hit)
    else missing.push(seq)
  }
  if (missing.length > 0) {
    const batch = queueChunkSeqs(cachePrefix, missing, (seqs) => queryChunkBatch(sdk, repo, manifest, seqs))
    for (const seq of missing) {
      const promise = batch.then((bySeq) => {
        const payload = bySeq.get(seq)
        if (payload === undefined) {
          throw new Error(`missing chunk seq ${seq} for pack ${packHashHex.slice(0, 12)}`)
        }
        return payload
      })
      chunkCacheSet(`${cachePrefix}:${seq}`, promise)
      held.set(seq, promise)
    }
  }

  const out = new Uint8Array(end - start)
  for (const seq of seqs) {
    const payload = await held.get(seq)!
    const chunkStart = seq * CHUNK_PAYLOAD_MAX
    const from = Math.max(start, chunkStart) - chunkStart
    const to = Math.min(end, chunkStart + payload.length) - chunkStart
    if (to > from) out.set(payload.subarray(from, to), chunkStart + from - start)
  }
  return out
}

// ---------------------------------------------------------------------------
// External (storage 1) artifacts
// ---------------------------------------------------------------------------

/**
 * Budget for one request to one external mirror. The mirror may be a dead host (a manifest
 * written by a push to someone's local MinIO) or a public gateway searching the IPFS network
 * for a CID nobody pins; neither may hold a browse hostage.
 */
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000

/**
 * An external artifact that no mirror served authentically. Carries what a view needs to
 * say *which* pack is missing and *where* it was looked for.
 */
export class PackUnavailableError extends Error {
  constructor(
    readonly packHash: string,
    /** Hosts actually tried (empty: the manifest records no browser-fetchable mirror). */
    readonly hosts: readonly string[],
    /** Whether some mirror answered with bytes that failed the sha256 check. */
    readonly corrupt: boolean,
    /** Why, per host where known (`host: message; …`). */
    readonly reason: string,
    /**
     * Hosts of recorded http(s) URLs no browser fetches ({@link unfollowedHosts}): a push to a
     * loopback, private-network or plain-http store. Named so a reader learns the copy exists
     * but is not public, not that nothing is recorded.
     */
    readonly unfollowed: readonly string[] = [],
  ) {
    super(
      `pack ${packHash.slice(0, 12)}… could not be fetched from its storage (${
        hosts.length > 0 ? hosts.join(', ') : 'no browser-fetchable mirror recorded'
      }): ${reason}`,
    )
    this.name = 'PackUnavailableError'
  }

  /** No mirror answered with bytes: an outage, unless one served bad bytes (`corrupt`). */
  get transport(): boolean {
    return !this.corrupt
  }
}

/**
 * An artifact of a repository made public that this reader skips (`private-repos.md` §18.2;
 * forge-core `ArtifactRead::Skipped`): stored encrypted while the repo was private under a key
 * nobody published, or in a format a newer version of Forge writes. Read like a pack no mirror
 * serves: reported, never fatal by itself.
 */
export class PackSkippedError extends PackUnavailableError {
  constructor(
    packHash: string,
    readonly why: SkipReason,
  ) {
    const reason =
      why.reason === 'noKey'
        ? "stored encrypted while the repo was private, and its key wasn't made public"
        : 'encrypted in a format a newer version of Forge writes'
    super(packHash, [], false, reason)
    this.message = `pack ${packHash.slice(0, 12)}… is not readable here: ${reason}`
    this.name = 'PackSkippedError'
  }

  override get transport(): boolean {
    return false
  }
}

/**
 * How a public repo's browse plane reads an artifact stored while it was private (§18.2): the
 * repo's conversion facts, and the published keys it holds (`repo.published`). Null for a repo
 * never made public (and a private one: its session opens everything).
 */
function convertedReads(repo: RepoRef): { readonly conversion: Conversion; readonly keys: PrivateSession | undefined } | null {
  if (repo.visibility !== 'public' || repo.session !== undefined) return null
  const conversion = knownConversion(repo.repoId) ?? null
  return conversion === null ? null : { conversion, keys: repo.published }
}

/**
 * `e`, or the skip it stands for: a `DFPK` header of a version this client does not open is
 * skipped in any repo, never read as corrupt (§3.2).
 */
function skippedOr(e: unknown, packHash: string): unknown {
  return e instanceof PackError && e.code === 'unknownVersion' ? new PackSkippedError(packHash, { reason: 'otherFormat', version: e.version ?? 0 }) : e
}

/** Why a converted repo's reader skips an artifact whose first bytes are `head`, holding `keys` (forge-core `skip_reason`). */
function skipOf(head: Uint8Array, keys: PrivateSession | undefined): SkipReason | null {
  return skipReason(head, (e) => keys?.ctx.keys.has(e) === true)
}

/**
 * The HTTP(S) URLs an external artifact can be fetched from, in order: the manifest's own
 * `http(s)` mirrors, then each `ipfs://<cid>` through every gateway in `gateways`. Schemes a
 * browser cannot fetch over HTTP (`s3://`, `platform://`) are skipped — an `s3://` locator
 * always travels with the bucket's public `https` URL, which is listed separately, and a
 * `platform://` one is read as chunks by {@link platformLocatorReads}.
 */
export function externalFetchUrls(
  uris: readonly string[],
  gateways: readonly string[] = readGateways(),
): string[] {
  const out: string[] = []
  for (const uri of uris) {
    // A manifest is written by whoever pushed: a URL at this machine, a private network or
    // over plain http would have every reader's browser request its own local services.
    if (isPublicHttpsUrl(uri)) out.push(uri)
    const ipfs = /^ipfs:\/\/([A-Za-z0-9]+)$/.exec(uri)
    if (ipfs !== null) {
      for (const gw of gateways) out.push(`${gw.replace(/\/+$/, '')}/ipfs/${ipfs[1]}`)
    }
  }
  return [...new Set(out)]
}

/** Requests in flight per origin. Every external pack starts at once; one host must not be
 * hit with all of them (nor hold the browser's per-host connection pool hostage). */
const PER_ORIGIN_CONCURRENCY = 4

/** How many of an artifact's URLs are raced at once (an `ipfs://` fans out per gateway). */
const MIRROR_RACE_WIDTH = 3
let mirrorRaceWidth = MIRROR_RACE_WIDTH

/**
 * Test hook: race `width` URLs at a time (`null` restores {@link MIRROR_RACE_WIDTH}). The
 * survivability drill tries one at a time, so the places a fallback names are exact.
 */
export function overrideMirrorRaceWidth(width: number | null): void {
  mirrorRaceWidth = width ?? MIRROR_RACE_WIDTH
}

/**
 * Why a URL failed: a timeout is worth one more sequential try, anything else is not.
 * `answered`: the host replied (an HTTP error, too many or wrong bytes), so the URL is dead for
 * this session; a request nothing answered (offline, refused, reset) says nothing about it.
 */
class FetchFailure extends Error {
  /** Nothing answered: an outage, not a verdict on the content (`BrowseReader`, L-10). */
  readonly transport: boolean
  constructor(
    message: string,
    readonly timedOut: boolean,
    readonly answered = false,
  ) {
    super(message)
    this.transport = !answered
  }
}

/** A tiny per-origin semaphore. */
const originSlots = new Map<string, { active: number; waiting: (() => void)[] }>()

async function withOriginSlot<T>(url: string, run: () => Promise<T>): Promise<T> {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    origin = url
  }
  return withSlot(origin, run)
}

/** At most {@link PER_ORIGIN_CONCURRENCY} `run`s in flight per `key`. */
async function withSlot<T>(key: string, run: () => Promise<T>): Promise<T> {
  let slot = originSlots.get(key)
  if (slot === undefined) {
    slot = { active: 0, waiting: [] }
    originSlots.set(key, slot)
  }
  return withSlotOf(slot, PER_ORIGIN_CONCURRENCY, run)
}

/**
 * At most `limit` `run`s of `slots` in flight. A finishing run hands its slot straight to the
 * next waiter, so a newcomer arriving in between cannot take it too and overshoot the limit.
 */
async function withSlotOf<T>(slots: { active: number; readonly waiting: (() => void)[] }, limit: number, run: () => Promise<T>): Promise<T> {
  if (slots.active >= limit) await new Promise<void>((resolve) => slots.waiting.push(resolve))
  else slots.active += 1
  try {
    return await run()
  } finally {
    const next = slots.waiting.shift()
    if (next !== undefined) next()
    else slots.active -= 1
  }
}

/**
 * URLs that failed this session for a reason other than a timeout (connection refused, 404,
 * wrong bytes). A later pack naming the same mirror skips them rather than paying for the
 * same failure again. Keyed by URL, not host: one gateway may lack one CID and hold another.
 */
// Only URLs whose host answered (FetchFailure `answered`): one nothing answered (offline,
// refused) is tried again once the connection is back (L-10). Each keeps why it failed, so a
// read that skips it still names it among the places that did not serve.
const deadUrls = new Map<string, string>()


/** "Try again": ask every mirror afresh, including the ones that failed this session. */
export function forgetDeadMirrors(): void {
  deadUrls.clear()
  resetGatewayHealth()
}

/** Test hook: forget the dead-URL list, the gateway probes and the per-origin queues. */
export function resetExternalFetchState(): void {
  deadUrls.clear()
  originSlots.clear()
  resetGatewayHealth()
  resetRepoGateways()
  resetMirrorUris()
  mirroredWhole.clear()
  mirroredBytes = 0
}

/**
 * GET `url` and read the whole body. Two deadlines, both {@link EXTERNAL_FETCH_TIMEOUT_MS}:
 * one for the response to begin (a dead or silent host), then an IDLE deadline re-armed on
 * every chunk, started only once the response has begun — a slow mirror streaming a large
 * pack is fine, a stalled one is not. A whole-body deadline would make every pack larger
 * than bandwidth × deadline permanently "unavailable" from healthy mirrors. The per-origin
 * queue wait is not counted against either. A 206 is accepted alongside 2xx.
 */
async function fetchBody(
  url: string,
  init: RequestInit = {},
  opts: { readonly cancel?: AbortSignal; readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  return withOriginSlot(url, async () => {
    if (opts.cancel?.aborted) throw new FetchFailure('another mirror served it first', false)
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, EXTERNAL_FETCH_TIMEOUT_MS)
    }
    const onCancel = (): void => controller.abort()
    opts.cancel?.addEventListener('abort', onCancel)
    arm() // the response must begin within the deadline
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal })
      if (!resp.ok && resp.status !== 206) throw new FetchFailure(`HTTP ${resp.status}`, false, true)
      if (resp.body === null) return new Uint8Array(await resp.arrayBuffer())
      const reader = resp.body.getReader()
      const parts: Uint8Array[] = []
      let total = 0
      for (;;) {
        arm() // idle deadline: re-armed per chunk once the body is streaming
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        // A mirror streaming more than the manifest says cannot be serving this pack.
        if (opts.maxBytes !== undefined && total > opts.maxBytes) {
          controller.abort()
          throw new FetchFailure('served more bytes than the manifest records', false, true)
        }
        parts.push(value)
      }
      const out = new Uint8Array(total)
      let at = 0
      for (const p of parts) {
        out.set(p, at)
        at += p.length
      }
      return out
    } catch (e) {
      if (timedOut) throw new FetchFailure(`no data for ${EXTERNAL_FETCH_TIMEOUT_MS / 1000}s`, true)
      if (opts.cancel?.aborted) throw new FetchFailure('another mirror served it first', false)
      if (e instanceof FetchFailure) throw e
      throw new FetchFailure(e instanceof Error ? e.message : String(e), false)
    } finally {
      clearTimeout(timer)
      opts.cancel?.removeEventListener('abort', onCancel)
    }
  })
}

function hostsOf(urls: readonly string[]): string[] {
  return [...new Set(urls.map(externalSourceName))]
}

/**
 * The hosts of `uris` that are http(s) URLs a reader never fetches ({@link externalFetchUrls}
 * keeps only public https): loopback, a private network, plain http. The CLI can record one
 * with `--allow-private-uri`; it serves its owner's machine, never a visitor's browser.
 */
export function unfollowedHosts(uris: readonly string[]): string[] {
  return [...new Set(uris.filter((u) => /^https?:\/\//i.test(u) && !isPublicHttpsUrl(u)).map(externalSourceName))]
}

/**
 * Drop the URLs that `ipfs://` fanned out to on an IPFS gateway known to be down
 * ({@link gatewayHealth}: probed in parallel, once per gateway), with a `host: reason` line
 * each, so a retired gateway costs nothing instead of a timeout per pack and the storage card
 * can name it. URLs the manifest itself recorded (`recorded`: an R2/S3 URL, the repo's own
 * `https://gw/ipfs/<cid>`) are never dropped. If every URL would be dropped, all are kept:
 * a stale verdict must not make a pack unreadable without one real attempt.
 */
async function skipDeadGateways(
  urls: readonly string[],
  recorded: ReadonlySet<string>,
): Promise<{ readonly live: string[]; readonly down: Failure[] }> {
  const verdicts = await Promise.all(
    urls.map(async (url) => {
      const gw = recorded.has(url) ? null : gatewayOf(url)
      return { url, down: gw === null ? null : await gatewayHealth(gw) }
    }),
  )
  const live: string[] = []
  const down: Failure[] = []
  for (const verdict of verdicts) {
    if (verdict.down === null) live.push(verdict.url)
    else down.push({ url: verdict.url, reason: gatewayDownReason(externalSourceName(verdict.url), verdict.down) })
  }
  if (live.length === 0) return { live: [...urls], down: [] }
  return { live, down }
}

/** One URL that did not serve an artifact, and why (`host: why`, the {@link PackUnavailableError} reason format). */
interface Failure {
  readonly url: string
  readonly reason: string
}

/** `url` failed because `why`, as a {@link Failure} (its reason prefixed with the URL's source name). */
function failureAt(url: string, why: string): Failure {
  return { url, reason: `${externalSourceName(url)}: ${why}` }
}

/** The distinct reasons of `failures`, in order. */
function reasonsOf(failures: readonly Failure[]): string[] {
  return [...new Set(failures.map((f) => f.reason))]
}

/** An artifact's fetchable URLs, those still worth trying (not failed this session, gateway up), and why the rest are not. */
async function mirrorUrls(
  manifest: PackManifest,
  gateways: readonly string[],
): Promise<{ readonly urls: string[]; readonly live: string[]; readonly down: Failure[] }> {
  const urls = externalFetchUrls(manifest.uris, gateways)
  const skipped = urls.flatMap((url) => {
    const why = deadUrls.get(url)
    return why === undefined ? [] : [failureAt(url, why)]
  })
  const { live, down } = await skipDeadGateways(
    urls.filter((u) => !deadUrls.has(u)),
    new Set(manifest.uris),
  )
  return { urls, live, down: [...skipped, ...down] }
}

/** The CID of a path-style gateway URL (`…/ipfs/<cid>`), or null. */
function gatewayCid(url: string): string | null {
  return /\/ipfs\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(url)?.[1] ?? null
}

/**
 * The failures worth naming once `winner` served (parity with forge-core
 * `preferred_failures`): only URLs ranked before it in `urls` (one ranked after it that lost
 * the race, or was never needed, is no fallback), and not another gateway's miss for the CID a
 * gateway served — the IPFS copy is fine; a default gateway lacking it, or one known to be
 * down, is not a lost copy. A gateway URL the manifest records (`recorded`) is kept.
 */
function preferredFailures(
  urls: readonly string[],
  recorded: ReadonlySet<string>,
  winner: string,
  failures: readonly Failure[],
): string[] {
  const won = urls.indexOf(winner)
  const cid = gatewayCid(winner)
  return reasonsOf(
    failures.filter((f) => {
      const otherGateway = cid !== null && gatewayCid(f.url) === cid && !recorded.has(f.url)
      return f.url !== winner && urls.indexOf(f.url) < won && !otherGateway
    }),
  )
}

/**
 * Which URL served an artifact, and the preferred copies that failed before it (`host: why`,
 * {@link preferredFailures}), so the trust panel can name both the host the bytes came from and
 * the recorded copies that are down.
 */
type OnServed = (uri: string, failed: readonly string[]) => void

/**
 * Fetch a contiguous range of an external artifact via HTTP Range, trying each fetchable
 * mirror in turn. `onServed` is told which URL answered (and which failed first). A range
 * cannot be hashed on its own: the reader re-hashes every object it reconstructs from it.
 */
async function fetchExternalRange(
  manifest: PackManifest,
  start: number,
  end: number,
  gateways: readonly string[],
  onServed?: OnServed,
): Promise<Uint8Array> {
  const { urls, live, down } = await mirrorUrls(manifest, gateways)
  const failed = [...down]
  for (const url of live) {
    try {
      const buf = await fetchBody(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
      onServed?.(url, preferredFailures(urls, new Set(manifest.uris), url, failed))
      // Some hosts ignore Range and return the whole body — slice defensively.
      return buf.length > end - start ? buf.subarray(start, end) : buf
    } catch (e) {
      if (e instanceof FetchFailure && e.answered) deadUrls.set(url, errorText(e))
      failed.push(failureAt(url, errorText(e)))
    }
  }
  // `host: why` per place, as the whole-body fetch reports it: a reason that also names the
  // Platform chunks tried first must not have every mirror read as that chunk failure.
  throw new PackUnavailableError(
    manifest.packHash,
    hostsOf(urls),
    false,
    reasonsOf(failed).join('; ') || 'no browser-fetchable mirror',
    unfollowedHosts(manifest.uris),
  )
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Fetch a whole external artifact; the first body whose size and sha256 match the
 * proof-read manifest wins. Mirrors are availability, never authority: one answering with
 * other bytes is treated as down and flagged `corrupt` (reported distinctly — it is a
 * misbehaving host, not an outage).
 *
 * The URLs are raced {@link MIRROR_RACE_WIDTH} at a time (skipping this session's dead URLs),
 * and the losers are cancelled as soon as one wins. URLs that only timed out get ONE more
 * sequential try each before the pack is declared unavailable: a gateway resolving a cold
 * CID is often slow once and fast after. `cancel` aborts everything (the clone gave up).
 */
async function fetchExternalWhole(
  manifest: PackManifest,
  gateways: readonly string[],
  onServed?: OnServed,
  cancel?: AbortSignal,
): Promise<Uint8Array> {
  const { urls, live, down } = await mirrorUrls(manifest, gateways)
  const want = manifest.packHash.toLowerCase()
  if (live.length === 0) {
    throw new PackUnavailableError(
      manifest.packHash,
      hostsOf(urls),
      false,
      urls.length === 0 ? 'nothing to try' : reasonsOf(down).join('; ') || 'every mirror already failed this session',
      unfollowedHosts(manifest.uris),
    )
  }
  let corrupt = false
  const failures: Failure[] = [...down]
  const timedOut: string[] = []
  // Cancels the losing mirrors once one has served the pack (or the whole clone gave up):
  // an ipfs:// URI fans out to one request per gateway, and each would otherwise download
  // (and hold) the whole pack.
  const winner = new AbortController()
  const onCancel = (): void => winner.abort()
  cancel?.addEventListener('abort', onCancel)
  if (cancel?.aborted) winner.abort()

  const attempt = async (url: string): Promise<{ url: string; bytes: Uint8Array }> => {
    try {
      const bytes = await fetchBody(url, {}, { cancel: winner.signal, maxBytes: manifest.sizeBytes })
      if (bytes.length !== manifest.sizeBytes || bytesToHex(sha256(bytes)) !== want) {
        corrupt = true
        throw new FetchFailure('served bytes that do not match the manifest sha256', false, true)
      }
      return { url, bytes }
    } catch (e) {
      if (!winner.signal.aborted) {
        failures.push(failureAt(url, errorText(e)))
        if (e instanceof FetchFailure && e.timedOut) timedOut.push(url)
        else if (e instanceof FetchFailure && e.answered) deadUrls.set(url, errorText(e))
      }
      throw e
    }
  }

  try {
    const got = (await raceBounded(live, mirrorRaceWidth, attempt, winner.signal)) ??
      (await firstSequential(timedOut, attempt, winner.signal))
    if (got !== null) {
      winner.abort()
      // The winner's own earlier timeout (it served on its retry) is not a failure: dropped.
      onServed?.(got.url, preferredFailures(urls, new Set(manifest.uris), got.url, failures))
      return got.bytes
    }
    if (cancel?.aborted) throw new Error('the in-browser clone was cancelled')
    throw new PackUnavailableError(manifest.packHash, hostsOf(urls), corrupt, reasonsOf(failures).join('; '), unfollowedHosts(manifest.uris))
  } finally {
    cancel?.removeEventListener('abort', onCancel)
  }
}

/**
 * Run `attempt` over `items` with at most `width` in flight; resolve with the first success,
 * or null once every item has failed (or `stop` fired).
 */
function raceBounded<T, R>(
  items: readonly T[],
  width: number,
  attempt: (item: T) => Promise<R>,
  stop: AbortSignal,
): Promise<R | null> {
  return new Promise((resolve) => {
    let next = 0
    let running = 0
    let settled = false
    const launch = (): void => {
      while (!settled && !stop.aborted && running < width && next < items.length) {
        const item = items[next++] as T
        running += 1
        attempt(item).then(
          (r) => {
            if (!settled) {
              settled = true
              resolve(r)
            }
          },
          () => {
            running -= 1
            if (settled) return
            if ((next >= items.length || stop.aborted) && running === 0) {
              settled = true
              resolve(null)
            } else launch()
          },
        )
      }
      if (!settled && running === 0) {
        settled = true
        resolve(null)
      }
    }
    launch()
  })
}

/** Try `items` one at a time; the first success, or null. */
async function firstSequential<T, R>(
  items: readonly T[],
  attempt: (item: T) => Promise<R>,
  stop: AbortSignal,
): Promise<R | null> {
  for (const item of [...items]) {
    if (stop.aborted) return null
    try {
      return await attempt(item)
    } catch {
      /* next */
    }
  }
  return null
}

/** A chunk locator: `platform://<core>/<repoId>/<owner>/<packHash>` (forge-core `scope.rs`). */
const PLATFORM_LOCATOR = /^platform:\/\/([^/]+)\/([^/]+)\/([^/]+)\/([0-9a-f]{64})$/i

/**
 * The chunk reads a `storage 1` manifest's `platform://` locators name. A fork records each
 * of its parent's Platform copies this way (forge-core `fork.rs`): the pack's chunks stay in
 * the parent's scope, keyed `(parentRepoId, uploader, packHash, seq)`. Each read is the
 * manifest re-pointed at that scope: the parent's `repoId`, the locator's uploader, storage 0.
 *
 * Only locators into THIS network's forge-core, and only of this manifest's own pack (a
 * locator naming another pack would download it in full before the hash check refused it).
 * Any other form is skipped, like any locator a browser cannot follow.
 */
function platformLocatorReads(
  repo: RepoRef,
  manifest: PackManifest,
): { readonly repo: RepoRef; readonly manifest: PackManifest }[] {
  const want = manifest.packHash.toLowerCase()
  const seen = new Set<string>()
  const out: { repo: RepoRef; manifest: PackManifest }[] = []
  for (const uri of manifest.uris) {
    const [, core, repoId, owner, hash] = PLATFORM_LOCATOR.exec(uri) ?? []
    if (core !== repo.forge.core || repoId === undefined || owner === undefined) continue
    if (hash?.toLowerCase() !== want || seen.has(`${repoId}/${owner}`)) continue
    seen.add(`${repoId}/${owner}`)
    out.push({
      repo: { ...repo, repoId, ownerId: '', name: '' },
      manifest: { ...manifest, storage: 0, uris: [], uploader: owner },
    })
  }
  return out
}

/**
 * A repo whose stored packs no place could serve: the refs are fine, the code is not
 * readable right now. Carries every pack and where it was looked for, so the view can list
 * the places tried instead of a spinner or a bare error.
 */
export class StorageUnreachableError extends Error {
  constructor(readonly packs: readonly UnavailablePack[]) {
    super(
      `none of this repo's ${packs.length} live packs could be fetched from their storage: ` +
        packs.map((u) => u.reason).join('; '),
    )
    this.name = 'StorageUnreachableError'
  }
}

/** The {@link UnavailablePack} a {@link PackUnavailableError} describes. */
export function unavailableOf(e: PackUnavailableError): UnavailablePack {
  return { packHash: e.packHash, hosts: e.hosts, reason: e.reason, corrupt: e.corrupt, unfollowed: e.unfollowed, ...(e instanceof PackSkippedError ? { skipped: true as const } : {}) }
}

/**
 * Record in the repo's content-check ledger where an artifact's (pack `packHash`) bytes came
 * from; `copy` (its manifest document id) for a range, which the reader verifies per copy, so a
 * copy whose bytes it then rejects is not named for the objects another copy served.
 */
function noteSource(repo: RepoRef, packHash: string, uri?: string, copy?: string): void {
  noteContentCheck(repoKey(repo), {
    source: uri === undefined ? 'platform' : externalSourceName(uri),
    pack: packHash,
    ...(copy === undefined ? {} : { copy }),
  })
}

/**
 * Record in the repo's ledger the preferred copies that failed (`host: why` each) before
 * another served pack `packHash`: the read worked, but a recorded copy is down, and the trust
 * panel's source row names it instead of the fallback passing unnoticed.
 */
function noteFailedPlaces(repo: RepoRef, packHash: string, failed: readonly string[]): void {
  if (failed.length === 0) return
  const hosts = [...new Set(failed.map((f) => f.slice(0, Math.max(0, f.indexOf(': ')))).filter((h) => h !== ''))]
  noteContentCheck(repoKey(repo), {
    fellBackFrom: describePack({ packHash, hosts, reason: failed.join('; '), corrupt: false }, readGatewaysFor(repoKey(repo))),
  })
}

/**
 * The {@link OnServed} for pack `packHash` (copy `copy`): the source, and what failed before it
 * (`before`, then the mirrors'). `ledger` false: nothing is recorded (an artifact that is not the
 * repo's content, {@link loadStoredArtifactBytes}).
 */
function servedBy(repo: RepoRef, packHash: string, copy?: string, before: readonly string[] = [], ledger = true): OnServed {
  if (!ledger) return () => undefined
  return (uri, failed) => {
    noteSource(repo, packHash, uri, copy)
    noteFailedPlaces(repo, packHash, [...before, ...failed])
  }
}

/**
 * Read a `storage 0` copy from its external copies once its own chunks could not be (`chunkError`):
 * a push to Platform and a bucket or gateway records both, and on-chain is only the first place
 * to look, not the only one. `read` is the ranged or whole external fetch, told to name the
 * chunks as the copy that failed when another serves (`documentId`: a range's copy, as
 * {@link noteSource}). No fetchable external copy: the chunk error, as before. None serving
 * either: a {@link PackUnavailableError} naming Platform and every host tried.
 */
async function afterChunksFailed(
  repo: RepoRef,
  copy: PackManifest,
  documentId: string | undefined,
  chunkError: unknown,
  read: (gateways: readonly string[], onServed: OnServed) => Promise<Uint8Array>,
  ledger = true,
): Promise<Uint8Array> {
  const gateways = readGatewaysFor(repoKey(repo))
  if (externalFetchUrls(copy.uris, gateways).length === 0) throw chunkError
  const chunks = `platform: ${errorText(chunkError)}`
  try {
    return await read(gateways, servedBy(repo, copy.packHash, documentId, [chunks], ledger))
  } catch (e) {
    if (!(e instanceof PackUnavailableError)) throw e
    throw new PackUnavailableError(copy.packHash, ['platform', ...e.hosts], e.corrupt, `${chunks}; ${e.reason}`, e.unfollowed)
  }
}

/** The places a copy's failure names (`host: why` each), for {@link servedBy}'s `before`. */
function failedPlaces(e: unknown): string[] {
  return e instanceof PackUnavailableError ? e.reason.split('; ') : [errorText(e)]
}

/**
 * A public repo's pack from its recorded mirrors (UPDATE-1), once every copy failed (`before`:
 * their failures): the whole artifact, its size and sha256 checked like any copy's, so a mirror
 * serving other bytes cannot answer, and one that ignores a size cap cannot stream forever. The
 * ledger notes the pack survives on a mirror, and the copies that failed. Null when none is
 * recorded or none serves.
 */
async function fromPackMirrors(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  before: readonly string[],
  cancel?: AbortSignal,
): Promise<Uint8Array | null> {
  if (repo.session !== undefined || cancel?.aborted) return null
  const uris = await mirrorUrisOf(sdk, repo, manifest)
  if (uris.length === 0) return null
  try {
    const bytes = await fetchExternalWhole(mirrorCopy(manifest, uris), readGatewaysFor(repoKey(repo)), servedBy(repo, manifest.packHash, undefined, before), cancel)
    noteContentCheck(repoKey(repo), { mirroredPack: manifest.packHash })
    return bytes
  } catch {
    // the copies' own failure is the one to report
    return null
  }
}

/**
 * Packs a mirror served whole this session, for range reads (`repoKey:pack`), least recently
 * used first. `size` is set once the read resolved; only those count toward the budget.
 */
const mirroredWhole = new Map<string, { read: Promise<Uint8Array | null>; size?: number }>()
let mirroredBytes = 0

/**
 * Bytes of mirror-served packs kept for range reads. A pack larger than this is shared only
 * while its read is in flight (the ranges a view asks at once), then dropped: a later range
 * reads it again rather than holding it for the session.
 */
const MIRRORED_BYTES_KEPT = 64 * 1024 * 1024
let mirroredBytesKept = MIRRORED_BYTES_KEPT

/** Test hook: keep `bytes` of mirror-served packs (`null` restores {@link MIRRORED_BYTES_KEPT}). */
export function overrideMirroredBytesKept(bytes: number | null): void {
  mirroredBytesKept = bytes ?? MIRRORED_BYTES_KEPT
}

/** {@link fromPackMirrors} once per pack for range reads: each range is a slice of checked bytes. */
function mirroredPack(sdk: EvoSDK, repo: RepoRef, manifest: PackManifest, before: readonly string[]): Promise<Uint8Array | null> {
  const key = `${repoKey(repo)}:${manifest.packHash.toLowerCase()}`
  const hit = mirroredWhole.get(key)
  if (hit !== undefined) {
    // Touch: re-insert so the map stays least recently used first.
    mirroredWhole.delete(key)
    mirroredWhole.set(key, hit)
    return hit.read
  }
  const entry: { read: Promise<Uint8Array | null>; size?: number } = { read: Promise.resolve(null) }
  entry.read = fromPackMirrors(sdk, repo, manifest, before).then((bytes) => {
    if (mirroredWhole.get(key) !== entry) return bytes
    if (bytes === null || bytes.length > mirroredBytesKept) {
      mirroredWhole.delete(key)
      return bytes
    }
    entry.size = bytes.length
    mirroredBytes += bytes.length
    for (const [k, e] of mirroredWhole) {
      if (mirroredBytes <= mirroredBytesKept) break
      if (e.size === undefined) continue // in flight: a range still awaits it
      mirroredWhole.delete(k)
      mirroredBytes -= e.size
    }
    return bytes
  })
  mirroredWhole.set(key, entry)
  return entry.read
}

/** Bytes `[start, end)` of one stored copy as they are (platform chunks or external URIs). */
async function readCopyRange(sdk: EvoSDK, repo: RepoRef, copy: PackManifest, start: number, end: number): Promise<Uint8Array> {
  if (copy.storage !== 0) {
    // Chunks a `platform://` locator names first: on-chain, so no mirror can hold a browse
    // hostage. A range cannot be hashed on its own; the reader re-hashes what it builds.
    let lastErr: unknown
    const chunkFailures: string[] = []
    for (const at of platformLocatorReads(repo, copy)) {
      try {
        const bytes = await fetchPlatformRange(sdk, at.repo, at.manifest, start, end)
        noteSource(repo, copy.packHash, undefined, copy.documentId)
        return bytes
      } catch (e) {
        lastErr = e
        chunkFailures.push(`platform: ${errorText(e)}`)
      }
    }
    const gateways = readGatewaysFor(repoKey(repo))
    if (lastErr !== undefined && externalFetchUrls(copy.uris, gateways).length === 0) {
      throw new PackUnavailableError(copy.packHash, ['platform'], false, errorText(lastErr), unfollowedHosts(copy.uris))
    }
    return fetchExternalRange(copy, start, end, gateways, servedBy(repo, copy.packHash, copy.documentId, chunkFailures))
  }
  let bytes: Uint8Array
  try {
    bytes = await fetchPlatformRange(sdk, repo, copy, start, end)
  } catch (e) {
    // Chunks that cannot be read: the copy's external copies, if it recorded any.
    return afterChunksFailed(repo, copy, copy.documentId, e, (gateways, served) =>
      fetchExternalRange(copy, start, end, gateways, served),
    )
  }
  noteSource(repo, copy.packHash, undefined, copy.documentId)
  return bytes
}

/**
 * The first {@link HEADER_LEN} bytes of a converted repo's pack, read before it is downloaded
 * (forge-core `pack_head`): from the first of its copies that serves them, else null. Unverified:
 * a host that lies costs a download, never a wrong read.
 */
async function packHead(sdk: EvoSDK, repo: RepoRef, copies: readonly PackManifest[]): Promise<Uint8Array | null> {
  for (const c of copies) {
    try {
      return await readCopyRange(sdk, repo, c, 0, Math.min(HEADER_LEN, c.sizeBytes))
    } catch {
      // the next copy
    }
  }
  return null
}

/**
 * Whether a converted repo's pack (`copies`) is skipped **without downloading it** (forge-core
 * `skip_before_download`): recorded while the repo may still have been private, and its first
 * bytes are a sealed header under a key nobody published, or of a version this client does not
 * open. Anything else is downloaded and judged whole.
 */
async function skipBeforeDownload(sdk: EvoSDK, repo: RepoRef, copies: readonly PackManifest[]): Promise<PackSkippedError | null> {
  const reads = convertedReads(repo)
  const first = copies[0]
  if (reads === null || first === undefined || !copies.some((c) => maybeSealed(reads.conversion, c.createdAtBlockHeight ?? 0))) return null
  const head = await packHead(sdk, repo, copies)
  const why = head === null ? null : skipOf(head, reads.keys)
  return why === null ? null : new PackSkippedError(first.packHash, why)
}

/** A ranged reader over one artifact (platform chunks or external URIs), optionally one copy. */
export function artifactRangeFetch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): (start: number, end: number, copy?: number) => Promise<Uint8Array> {
  const readCopy = (copy: PackManifest, start: number, end: number): Promise<Uint8Array> => readCopyRange(sdk, repo, copy, start, end)
  // A private repo's artifacts are sealed: the reader asks for PLAINTEXT ranges (locator rows
  // index plaintext offsets), mapped to sealed segments through the session's header cache. A
  // repository made public's copy recorded while it was private is checked by its first bytes:
  // sealed under a published key, it reads the same way; otherwise it is skipped.
  const session = repo.session
  const reads = convertedReads(repo)
  const heads = new Map<string, Promise<Uint8Array>>()
  const readConverted = async (c: PackManifest, start: number, end: number): Promise<Uint8Array> => {
    if (reads === null || !maybeSealed(reads.conversion, c.createdAtBlockHeight ?? 0)) return readCopy(c, start, end)
    let head = heads.get(c.documentId)
    if (head === undefined) {
      head = readCopy(c, 0, Math.min(HEADER_LEN, c.sizeBytes))
      heads.set(c.documentId, head)
      head.catch(() => heads.delete(c.documentId))
    }
    const bytes = await head
    const why = skipOf(bytes, reads.keys)
    if (why !== null) throw new PackSkippedError(c.packHash, why)
    // Not skipped: a plaintext head reads as it is, a sealed one under a key the published hold.
    const keys = reads.keys
    if (sniff(bytes).kind !== 'sealed' || keys === undefined) return readCopy(c, start, end)
    return readPrivateRange(keys, c, (s, e) => readCopy(c, s, e), start, end)
  }
  const readPlain =
    session === undefined
      ? readConverted
      : (c: PackManifest, start: number, end: number) =>
          readPrivateRange(session, c, (s, e) => readCopy(c, s, e), start, end).catch((e: unknown) => {
            throw skippedOr(e, c.packHash)
          })
  return async (start: number, end: number, copy?: number) => {
    // A range cannot be hashed on its own. The reader re-hashes every object it
    // builds from one and asks for a specific `copy` when the current one fails it; without
    // one, a copy that cannot serve the range at all falls through to the next in order.
    const copies = manifest.copies ?? [manifest]
    if (copy !== undefined) {
      const chosen = copies[copy]
      if (chosen === undefined) throw new Error(`pack ${manifest.packHash.slice(0, 12)}… has no copy ${copy}`)
      return readPlain(chosen, start, end)
    }
    let lastErr: unknown
    const failed: string[] = []
    for (const c of copies) {
      try {
        return await readPlain(c, start, end)
      } catch (e) {
        // A skip here comes from one copy's unverified first bytes: the next copy may serve the
        // pack, so it is one copy's failure like any other.
        lastErr = e
        failed.push(...failedPlaces(e))
      }
    }
    // Every copy failed: a public repo's recorded mirrors (UPDATE-1), read only now (never for a
    // skipped pack, whose whole bytes a mirror would serve sealed too).
    if (session === undefined && !(lastErr instanceof PackSkippedError)) {
      const whole = await mirroredPack(sdk, repo, manifest, failed)
      if (whole !== null) return whole.subarray(start, Math.min(end, whole.length))
    }
    // The rail's "where the bytes came from" row lists the places that did not answer.
    if (lastErr instanceof PackUnavailableError) {
      noteContentCheck(repoKey(repo), {
        unreachable: describePack(unavailableOf(lastErr), readGatewaysFor(repoKey(repo))),
      })
    }
    throw lastErr
  }
}

/**
 * Load a whole artifact's bytes (locator, flatIndex).
 *
 * Delegates to the windowed loader so a multi-MB artifact streams in
 * {@link DOWNLOAD_WINDOW} strides instead of being requested as one enormous range. Both
 * paths are correct now that oversized chunk requests split, but the windowed one bounds
 * how much is in flight and in memory at once.
 */
export function loadArtifactBytes(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): Promise<Uint8Array> {
  return loadArtifactBytesProgress(sdk, repo, manifest)
}

/**
 * A whole artifact's bytes as stored, never opened as a pack, even in a private repo: the first
 * copy whose bytes hash to its `packHash`. For artifacts with their own codec (an environment
 * snapshot), which checks and opens them itself. `repo` keeps its session, so the repo's own
 * gateways and caches are the ones used.
 */
export function loadStoredArtifactBytes(sdk: EvoSDK, repo: RepoRef, manifest: PackManifest): Promise<Uint8Array> {
  return loadArtifactBytesProgress(sdk, repo, manifest, undefined, undefined, true)
}

/**
 * Bytes per windowed whole-artifact fetch. `fetchPlatformRange` now splits an oversized
 * request across parallel {@link CHUNK_QUERY_MAX}-row queries, so this is a
 * memory/progress-granularity knob rather than a correctness ceiling.
 */
const DOWNLOAD_WINDOW = CHUNK_QUERY_MAX * CHUNK_PAYLOAD_MAX

/**
 * Load a whole artifact with download progress — the fallback-clone path for full git
 * packs, which can exceed the single-query chunk window. Platform storage downloads in
 * `DOWNLOAD_WINDOW` strides; external storage races its mirrors for the whole body, which
 * must match the manifest's size and sha256 (progress reported only at completion), and
 * throws {@link PackUnavailableError} when none does. A Platform copy whose chunks cannot be
 * read falls back to the external copies it also recorded ({@link afterChunksFailed}).
 */
export async function loadArtifactBytesProgress(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
  cancel?: AbortSignal,
  stored = false,
): Promise<Uint8Array> {
  // A private repo: every copy's sealed bytes are checked against `packHash`, then its standing,
  // then decrypted; the plaintext is what the caller gets. `stored`: the bytes as uploaded,
  // checked against `packHash` and never opened, nor recorded in the repo's content-check ledger
  // (not git content; {@link loadStoredArtifactBytes}).
  const session = stored ? undefined : repo.session
  // A repository made public (§18.2): a pack recorded while it may have been private is checked
  // by its first bytes before it is downloaded, and every pack by its bytes after.
  const reads = stored ? null : convertedReads(repo)
  if (reads !== null) {
    const skipped = await skipBeforeDownload(sdk, repo, manifest.copies ?? [manifest])
    if (skipped !== null) throw skipped
  }
  const opened = new WeakSet<Uint8Array>()
  const open = async (copy: PackManifest): Promise<Uint8Array> => {
    const bytes = await loadOneCopy(sdk, repo, copy, onProgress, cancel, !stored)
    const keys = session ?? openableWith(copy, bytes)
    if (keys === undefined) return bytes
    try {
      const plain = await openPrivateArtifact(keys, copy, bytes, manifest.copies ?? [copy])
      opened.add(plain)
      return plain
    } catch (e) {
      // Sealed bytes that fail their packHash (or do not open) keep nothing in the chunk cache.
      if (copy.storage === 0) forgetChunks(repo, copy)
      throw skippedOr(e, copy.packHash)
    }
  }
  /**
   * The published keys a public repo's whole copy opens with, once its bytes hash to its
   * `packHash`: undefined for plaintext (handed on as it is); a sealed header nobody published a
   * key for, or of another version, is skipped (forge-core `open_or_skip`). Any public repo's, not
   * only one known to be made public: its config may not have been read yet.
   */
  const openableWith = (copy: PackManifest, bytes: Uint8Array): PrivateSession | undefined => {
    const head = sniff(bytes).kind
    if (stored || repo.visibility !== 'public' || head === 'plain' || head === 'short' || bytesToHex(sha256(bytes)) !== copy.packHash.toLowerCase()) return undefined
    const why = skipOf(bytes, reads?.keys)
    if (why !== null) throw new PackSkippedError(copy.packHash, why)
    return reads?.keys
  }
  const verified = (copy: PackManifest, bytes: Uint8Array): boolean =>
    session !== undefined || opened.has(bytes) || bytesToHex(sha256(bytes)) === copy.packHash.toLowerCase()
  // Every writer may hold a copy of a pack. Read them in `orderPackCopies` order
  // and keep the first whose bytes hash to `packHash`; a copy that does not, or that cannot
  // be read (a missing chunk, a dead mirror), is skipped (`forge-v2.md` §4 reader rule). A
  // pack no copy serves is unreadable. A raw manifest (no `copies`) is its one copy.
  const failures: unknown[] = []
  for (const copy of manifest.copies ?? [manifest]) {
    try {
      const bytes = await open(copy)
      if (verified(copy, bytes)) return bytes
      if (copy.storage === 0) forgetChunks(repo, copy)
      failures.push(new Error(`copy ${shortId(copy.documentId)} does not hash to the pack`))
    } catch (e) {
      // A cancelled load stops here: the next copy is not tried, nor a skipped pack's (same bytes).
      if (cancel?.aborted || e instanceof PackSkippedError) throw e
      failures.push(e)
    }
  }
  const mirrored = await fromPackMirrors(sdk, repo, manifest, failures.flatMap(failedPlaces), cancel)
  if (mirrored !== null) return mirrored
  // One copy: its own error. Every copy external and unserved: the fallback clone's
  // "unavailable" case, which it reports rather than failing the clone on.
  if (failures.length === 1) throw failures[0]
  const last = failures[failures.length - 1]
  if (last instanceof PackUnavailableError && failures.every((f) => f instanceof PackUnavailableError)) {
    throw last
  }
  throw new Error(
    `no copy of pack ${manifest.packHash.slice(0, 12)}… could be read and verified: ${failures.map(errorText).join('; ')}`,
  )
}

async function loadOneCopy(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
  cancel?: AbortSignal,
  ledger = true,
): Promise<Uint8Array> {
  const total = manifest.sizeBytes
  if (total <= 0) return new Uint8Array(0)
  onProgress?.(0, total)
  if (manifest.storage !== 0) {
    const bytes = await loadExternalCopy(sdk, repo, manifest, onProgress, cancel, ledger)
    onProgress?.(total, total)
    return bytes
  }
  let out: Uint8Array
  try {
    out = await loadPlatformWhole(sdk, repo, manifest, onProgress, cancel)
  } catch (e) {
    // A cancelled clone stops here: no external copy is fetched for it.
    if (cancel?.aborted) throw e
    const bytes = await afterChunksFailed(
      repo,
      manifest,
      undefined,
      e,
      (gateways, served) => fetchExternalWhole(manifest, gateways, served, cancel),
      ledger,
    )
    onProgress?.(total, total)
    return bytes
  }
  if (ledger) noteSource(repo, manifest.packHash)
  return out
}

/**
 * {@link DOWNLOAD_WINDOW}s of one whole artifact in flight at once. One window is a single
 * 100-row chunk query, so this is also the query concurrency of a whole-artifact load (L-15:
 * a 10 MB locator fetched one window at a time was ~2 s of serial round trips on a cold home).
 */
const WINDOW_POOL = 4

/** A whole platform-stored artifact, in {@link DOWNLOAD_WINDOW} strides, {@link WINDOW_POOL} at a time. */
async function loadPlatformWhole(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
  cancel?: AbortSignal,
): Promise<Uint8Array> {
  const total = manifest.sizeBytes
  const out = new Uint8Array(total)
  const starts: number[] = []
  for (let at = 0; at < total; at += DOWNLOAD_WINDOW) starts.push(at)
  let fetched = 0
  const cancelled = (): void => {
    if (cancel?.aborted) throw new Error('the in-browser clone was cancelled')
  }
  await mapPooled(starts, WINDOW_POOL, async (at) => {
    cancelled()
    const end = Math.min(at + DOWNLOAD_WINDOW, total)
    const bytes = await fetchPlatformRange(sdk, repo, manifest, at, end)
    // A window that lands after the abort does not count: every window may already be in flight.
    cancelled()
    out.set(bytes, at)
    fetched += end - at
    onProgress?.(fetched, total)
  })
  cancelled()
  return out
}

/**
 * A whole `storage 1` artifact: first from the chunks its `platform://` locators name (a
 * fork's parent-scope copy), which must hash to `packHash` like any mirror's body, then from
 * its external mirrors. Chunks that do not verify are reported `corrupt`, as a mirror is.
 *
 * The fallback clone starts every `storage 1` pack at once (they are usually mirror races),
 * so the chunk reads share one {@link withSlot} queue rather than all running in parallel.
 */
async function loadExternalCopy(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
  cancel?: AbortSignal,
  ledger = true,
): Promise<Uint8Array> {
  const reasons: string[] = []
  let corrupt = false
  for (const at of platformLocatorReads(repo, manifest)) {
    if (cancel?.aborted) throw new Error('the in-browser clone was cancelled')
    try {
      const bytes = await withSlot('platform://', () =>
        loadPlatformWhole(sdk, at.repo, at.manifest, onProgress, cancel),
      )
      if (bytesToHex(sha256(bytes)) === manifest.packHash.toLowerCase()) {
        if (ledger) noteSource(repo, manifest.packHash)
        return bytes
      }
      forgetChunks(at.repo, at.manifest)
      corrupt = true
      reasons.push('platform: chunks do not match the manifest sha256')
    } catch (e) {
      if (cancel?.aborted) throw e
      reasons.push(`platform: ${errorText(e)}`)
    }
  }
  const gateways = readGatewaysFor(repoKey(repo))
  const served = servedBy(repo, manifest.packHash, undefined, reasons, ledger)
  if (reasons.length === 0) return fetchExternalWhole(manifest, gateways, served, cancel)
  const unavailable = (hosts: readonly string[], why: readonly string[], bad: boolean): PackUnavailableError =>
    new PackUnavailableError(
      manifest.packHash,
      ['platform', ...hosts],
      corrupt || bad,
      [...reasons, ...why].join('; '),
      unfollowedHosts(manifest.uris),
    )
  if (externalFetchUrls(manifest.uris, gateways).length === 0) throw unavailable([], [], false)
  try {
    return await fetchExternalWhole(manifest, gateways, served, cancel)
  } catch (e) {
    // Report the chunk failures alongside the mirrors', not only the mirrors'.
    if (e instanceof PackUnavailableError) throw unavailable(e.hosts, [errorText(e)], e.corrupt)
    throw e
  }
}

/**
 * The pack list a locator's `packRef` indexes — THE normative definition, shared by both
 * clients and by whatever publishes a locator.
 *
 * `packRef` is "an index into the manifest's pack list", but no pack list is stored on-chain,
 * so reader and writer must derive the same one. It is the kind-0 packs of `v2PackList`
 * (`forge-v2.md` §4, parity with forge-core `repo.rs::locator_pack_space`): every pack once
 * however many writers hold a copy, positioned by its first upload `($createdAt, $id)`, as of
 * the locator (a locator only indexes packs that existed when it was built). Superseded
 * packs stay in place, so a repack never renumbers what an older locator meant.
 *
 * The indexed path and the fallback clone both read this list, so they always agree about
 * which bytes `packRef 0` means.
 */
export function locatorPackSpace(
  manifests: readonly PackManifest[],
  asOf?: AsOf,
): PackManifest[] {
  // The pack list's kind-0 packs (`forge-v2.md` §4), superseded ones included and in place —
  // a locator's packRefs index every git pack listed as of it.
  return packsOfKind(manifests, PACK_KIND.GIT_PACK, asOf)
}

/**
 * The live index fragments (objectLocators), newest first: the pack list's kind-1 packs,
 * those a verified pack supersedes left out.
 */
function locatorFragments(manifests: readonly PackManifest[]): PackManifest[] {
  return packsOfKind(manifests, PACK_KIND.OBJECT_LOCATOR)
    .filter((p) => !p.superseded)
    .reverse()
}

/**
 * A {@link PackSource} over a repo's pack manifests, indexed by `packRef` as
 * {@link locatorPackSpace} defines it. `asOf` is the owning locator's `$createdAt`.
 *
 * Takes the FULL manifest list, not a pre-filtered kind-0 list: liveness is a property of
 * the whole set (a kind-0 pack is superseded by whatever names it, of any kind), so
 * filtering to kind-0 first would lose the information needed to compute it.
 */
export function buildPackSource(
  sdk: EvoSDK,
  repo: RepoRef,
  manifests: readonly PackManifest[],
  asOf?: AsOf,
): PackSource {
  const ordered = locatorPackSpace(manifests, asOf)
  return {
    async fetchRange(packRef: number, start: number, end: number, copy?: number): Promise<Uint8Array> {
      const manifest = ordered[packRef]
      if (!manifest) throw new Error(`packRef ${packRef} out of range (${ordered.length} packs)`)
      return artifactRangeFetch(sdk, repo, manifest)(start, end, copy)
    },
    copyCount: (packRef: number) => ordered[packRef]?.copies?.length ?? 1,
    sizeOf: (packRef: number) => ordered[packRef]?.sizeBytes,
  }
}

/** A private repo read without a decryption session: its code is not readable here. */
export class PrivateRepoLockedError extends Error {
  constructor() {
    super('this repo is private: its contents are encrypted for members')
    this.name = 'PrivateRepoLockedError'
  }
}

/** A live pack the browser could not obtain from its external storage. */
export interface UnavailablePack {
  readonly packHash: string
  /** Hosts tried (empty: the manifest records no browser-fetchable mirror). */
  readonly hosts: readonly string[]
  readonly reason: string
  /** Some mirror served bytes that failed the sha256 check — a misbehaving host, not an outage. */
  readonly corrupt: boolean
  /** Recorded hosts no browser fetches (private or plain http; see {@link unfollowedHosts}). */
  readonly unfollowed?: readonly string[]
  /** Not fetched at all: a repository made public's pack this reader cannot open ({@link PackSkippedError}); `reason` says why. */
  readonly skipped?: true
}

/** The assembled browse context for a repo, or a reason it is unavailable. */
export interface BrowseContext {
  /** The index whole, or (a large published one, QW3-001) read a fanout slice at a time. */
  readonly locator: ObjectLocator | ObjectIndex
  readonly packs: PackSource
  readonly reader: BrowseReader
  /**
   * External packs the in-browser clone skipped because no mirror served them. Objects only
   * those packs hold are absent from this context; empty/absent means nothing was skipped.
   */
  readonly unavailable?: readonly UnavailablePack[]
}

/**
 * Load the newest flatIndex artifact (full recursive tree listing), or `null` if the repo
 * has not published one. Used by deep tree-browse and filename search — never the cold home.
 */
export async function loadFlatIndex(sdk: EvoSDK, repo: RepoRef): Promise<FlatIndex | null> {
  // Index lookup (`kind ==`, `$createdAt desc`, limit 1) — independent of manifest volume.
  const newest = await readNewestManifestOfKind(sdk, repo, PACK_KIND.FLAT_INDEX)
  if (!newest) return null
  // Any writer can post a kind-2 manifest, so read the pack's copies in order and accept only
  // bytes that hash to `packHash` (loadArtifactBytes checks each copy).
  const flatManifest = await readPackCopies(sdk, repo, newest.packHash, PACK_KIND.FLAT_INDEX)
  if (!flatManifest) return null
  const bytes = await loadArtifactBytes(sdk, repo, flatManifest)
  return FlatIndex.parse(bytes)
}

/**
 * Discriminated browse availability:
 *  - `ready` — a published index covers every live pack; the browse plane serves reads.
 *  - `unindexed` — live kind-0 packs exist but the published index does not cover them
 *    all: the fallback clone can download + index them in-browser (`livePacks` /
 *    `totalSizeBytes` feed that UI). `reason` distinguishes no index at all from one that
 *    is behind, which is what the user can act on.
 *  - `no-packs` — nothing stored to browse at all.
 */
export type BrowseState =
  | { readonly kind: 'ready'; readonly context: BrowseContext; readonly manifests: ReadonlySet<string> }
  | {
      readonly kind: 'unindexed'
      readonly reason: UnindexedReason
      readonly livePacks: PackManifest[]
      readonly totalSizeBytes: number
      readonly manifests: ReadonlySet<string>
    }
  | { readonly kind: 'no-packs' }

/**
 * The pack list a state was resolved from, as its manifest copies' document ids. A push, a merge
 * or an index fragment adds a manifest; none is ever removed (`packManifest` is immutable and
 * cannot be deleted), so a newer read of a repo holds a superset of an older one's — and a read
 * holding fewer came from a node that is behind.
 */
function manifestsOf(state: BrowseState): ReadonlySet<string> {
  return state.kind === 'no-packs' ? new Set() : state.manifests
}

/**
 * Whether `next`, a fresh resolve of a repo, should replace `current`: it saw a manifest
 * `current` did not (a push, a merge), or it saw the same pack list and is `ready` where
 * `current` was not (an index fragment that failed to load came through this time). A read that
 * saw fewer manifests is from a node a block behind and never rolls the cache back.
 */
function supersedes(next: BrowseState, current: BrowseState): boolean {
  const had = manifestsOf(current)
  const has = manifestsOf(next)
  for (const id of has) if (!had.has(id)) return true
  return has.size === had.size && next.kind === 'ready' && current.kind !== 'ready'
}

/**
 * Why the locator path is unavailable.
 *
 * `index-behind` is the case that used to be indistinguishable from `ready`: a published
 * locator whose `packRef` space does not cover the current live packs. Reading through it
 * would resolve every object stored before the index was published and throw
 * `object not in locator` on everything pushed since — so a repo would look browsable right
 * up until someone opened a recent commit. Both cases route to the same in-browser clone,
 * which reads the packs directly and is always correct; only the wording differs.
 */
export type UnindexedReason =
  /** No live objectLocator manifest at all. */
  | 'no-index'
  /** Fragments exist but leave live packs unindexed, or disagree about the pack space. */
  | 'index-behind'

/**
 * Assemble a repo's browse availability: the merged published index plus a pack source over
 * its git packs when the index covers them, or the live pack set the fallback clone would
 * need when it does not.
 */
export async function loadBrowseContext(
  sdk: EvoSDK,
  repo: RepoRef,
  /**
   * A re-resolve of a context whose pack list was read by `after`: only a read issued after it
   * answers (the home's revalidation of a moment ago, else a new one), never the one it checks.
   */
  { after }: { readonly after?: number } = {},
): Promise<BrowseState> {
  // A private repo's artifacts are sealed: nothing is fetched without the reader's session.
  if (repo.visibility === 'private' && repo.session === undefined) throw new PrivateRepoLockedError()
  // ONE snapshot, deliberately. `readPackManifests` applies no `kind` filter and is now
  // complete, so every index fragment is already in this list — and reading packs and
  // fragments separately would be actively wrong: a repack committing between the two
  // queries pairs a post-repack index with a pre-repack pack list, and `packRef` then
  // resolves to the wrong pack silently. That is the same misalignment the completeness fix
  // exists to prevent, reintroduced through the back door. A public repo's list comes from the
  // repo chrome store: the home's own read of a moment ago (zero requests), else its delta.
  const manifests = await readBrowseManifests(sdk, repo, { after, network: ACTIVE_NETWORK.network })
  // The gateways this repo's CURRENT members' pushes recorded reach its IPFS node: try them
  // first. A past writer's or a stranger's manifest cannot steer every read.
  noteRepoGateways(
    repoKey(repo),
    'manifests',
    manifests.filter((m) => m.ownerRole !== null && m.ownerRole !== undefined).flatMap((m) => m.uris),
  )
  const livePacks = locatorPackSpace(manifests)
  if (livePacks.length === 0) return { kind: 'no-packs' }
  const totalSizeBytes = livePacks.reduce((s, m) => s + m.sizeBytes, 0)
  const ids: ReadonlySet<string> = new Set(manifests.map((m) => m.documentId))
  const behind = (reason: UnindexedReason): BrowseState => ({
    kind: 'unindexed',
    reason,
    livePacks,
    totalSizeBytes,
    manifests: ids,
  })

  // A public repo's large fragments are read a fanout slice at a time (QW3-001). A private repo's
  // are sealed, and read whole as before, as are a repository made public's (some may be sealed).
  const own = await publishedLocator(sdk, repo, manifests, livePacks, { ranged: repo.session === undefined && convertedReads(repo) === null })
  if (own === 'behind') return behind('index-behind')
  // A fork's own fragments index only the packs it pushed itself; the packs it holds by
  // reference to its parent (and the parent's parent) are indexed by theirs (QW-023).
  const lineage: Ancestor[] = []
  let locator: ObjectLocator | ObjectIndex | null
  // A ranged index covers the space: `publishedLocator` returns one only when its rows do.
  if (own !== null && !(own instanceof ObjectLocator)) locator = own
  else {
    const whole = own !== null && coversSpace(own, livePacks) ? own : await withAncestors(sdk, repo, own, livePacks, lineage, 0)
    if (whole === null) return behind('no-index')
    // Coverage: every pack in the space that HOLDS anything must be indexed by some fragment.
    // A gap means objects that exist on-chain are unreachable through the index — the honest
    // answer is the fallback clone, not a reader that throws on the first uncovered object.
    if (!coversSpace(whole, livePacks)) return behind('index-behind')
    locator = whole
  }

  // The packRef space is the current live pack set: the fragments cover all of it, and each
  // was built over a prefix of it (a parent's remapped into it), so every row's packRef means
  // the same pack here.
  const packs = buildPackSource(sdk, repo, manifests)
  const reader = repoReader(sdk, repo, locator, packs, livePacks)
  attachRepoHistory(sdk, repo, reader, manifests, lineage)
  return { kind: 'ready', context: { locator, packs, reader }, manifests: ids }
}

/**
 * Whether `locator` indexes every pack of `space` that holds anything.
 *
 * The `objectCount > 0` exemption is not a loophole: a zero-object pack contributes no
 * rows, so its packRef could never appear in `covered` and the repo would read as
 * index-behind forever. The push path no longer stores one (forge-core
 * `upload_push_pack`), but repos pushed by an older client can already carry one — a new
 * branch or tag at an already-stored commit packed nothing.
 */
function coversSpace(locator: ObjectLocator, space: readonly PackManifest[]): boolean {
  const covered = locator.packRefsCovered()
  return space.every((m, i) => m.objectCount === 0 || covered.has(i))
}

/**
 * Index fragments at least this large are read a fanout slice at a time when `ranged`
 * (QW3-001); smaller ones whole, which is one chunk query either way (a push's own fragment is
 * 36 bytes per object it added: 26 KB for a 700-object push).
 */
export const RANGED_INDEX_MIN_BYTES = 256 * 1024

/**
 * Whether `parts` (fragments, oldest first, each held whole or read a range at a time) cover
 * `space`, without reading the ranged ones' rows:
 *  - `uncovered`: a whole part names a pack outside the space, or a pack that holds anything is
 *    indexed by no whole part and was pushed after every ranged one was published (`reach`: the
 *    length of the pack space as of each fragment; a fragment cannot index a later pack). The
 *    D-920 case: a push whose own fragment never landed.
 *  - `covered`: the ranged fragments' rows number exactly the objects of the packs left to them
 *    (a fragment holds one row per object of each pack it indexes).
 *  - `unknown`: they do not (an overlap, a count a writer misstated): settled the exact way, the
 *    fragments read whole and checked row by row.
 */
function rangedCoverage(parts: readonly (ObjectLocator | RangedLocator)[], reach: readonly number[], space: readonly PackManifest[]): 'covered' | 'uncovered' | 'unknown' {
  const covered = new Set<number>()
  let rangedRows = 0
  let rangedReach = 0
  parts.forEach((p, i) => {
    if (p instanceof ObjectLocator) for (const r of p.packRefsCovered()) covered.add(r)
    else {
      rangedRows += p.count
      rangedReach = Math.max(rangedReach, reach[i] ?? 0)
    }
  })
  for (const r of covered) if (r >= space.length) return 'uncovered'
  let objects = 0
  for (let i = 0; i < space.length; i++) {
    const m = space[i] as PackManifest
    if (m.objectCount === 0 || covered.has(i)) continue
    if (i >= rangedReach) return 'uncovered'
    objects += m.objectCount
  }
  return rangedRows === objects ? 'covered' : 'unknown'
}

/**
 * Ranged fragments opened this session, per SDK (an artifact never changes): a revalidation, or
 * the next resolve after a push, reads nothing of them again and keeps the slices already read.
 */
let openedFragments = new WeakMap<EvoSDK, Map<string, Promise<ObjectLocator | RangedLocator>>>()
const OPENED_FRAGMENTS_KEPT = 8

/**
 * A whole index fragment: kept from an earlier visit, else downloaded and kept, its progress shown
 * on the code pages of `progressKey` (the repo viewed: a fork reads its parent's index).
 */
async function wholeFragment(sdk: EvoSDK, repo: RepoRef, m: PackManifest, progressKey: string): Promise<ObjectLocator> {
  const key = progressKey
  try {
    // Fragments are content-addressed: a verified copy from an earlier visit is reused
    // instead of downloading the whole index on every page load (D-023).
    const bytes = await loadIndexArtifact(ACTIVE_NETWORK.key, m.packHash, () =>
      loadArtifactBytesProgress(sdk, repo, m, (fetched, total) => noteIndexProgress(key, m.packHash, fetched, total)),
    )
    return ObjectLocator.parse(bytes)
  } finally {
    endIndexProgress(key, m.packHash)
  }
}

/**
 * Ranges of one artifact read through browser storage: those asked for in one turn are looked up
 * in one store read, and the ones it does not hold are then read together (`read`), so they share
 * chunk queries ({@link queueChunkSeqs}). One store read per range would end each in its own turn,
 * and so in its own query: a branch list's two dozen lookups were two dozen queries.
 */
function gatherRanges(
  stored: (ranges: readonly (readonly [number, number])[]) => Promise<(Uint8Array | undefined)[]>,
  read: (start: number, end: number) => Promise<Uint8Array>,
  keep: (start: number, end: number, bytes: Uint8Array) => void,
): (start: number, end: number) => Promise<Uint8Array> {
  type Asked = { readonly range: readonly [number, number]; readonly resolve: (b: Uint8Array) => void; readonly reject: (e: unknown) => void }
  let pending: Asked[] | null = null
  const flush = async (batch: readonly Asked[]): Promise<void> => {
    const hits = await stored(batch.map((a) => a.range)).catch(() => batch.map(() => undefined))
    batch.forEach((a, i) => {
      const hit = hits[i]
      if (hit !== undefined) return a.resolve(hit)
      const [start, end] = a.range
      read(start, end).then((bytes) => {
        keep(start, end, bytes)
        a.resolve(bytes)
      }, a.reject)
    })
  }
  return (start, end) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (pending === null) {
        const batch: Asked[] = []
        pending = batch
        nextMacrotask(() => {
          pending = null
          void flush(batch)
        })
      }
      pending.push({ range: [start, end], resolve, reject })
    })
}

/**
 * A large index fragment, read a fanout slice at a time ({@link RangedLocator}): its fanout now,
 * each slice when a lookup first needs it, every range kept in IndexedDB for the next visit. A
 * whole copy already kept is used whole; a fanout that does not describe the fragment is read
 * whole instead.
 */
function openFragment(sdk: EvoSDK, repo: RepoRef, m: PackManifest): Promise<ObjectLocator | RangedLocator> {
  const progressKey = repoKey(repo)
  // Opened from this copy's chunks, so held per copy ({@link chunkCopyKey}).
  const memo = chunkCopyKey(repo, m)
  const opened = openedFragments.get(sdk) ?? new Map<string, Promise<ObjectLocator | RangedLocator>>()
  openedFragments.set(sdk, opened)
  const held = opened.get(memo)
  if (held !== undefined) return held
  const open = (async (): Promise<ObjectLocator | RangedLocator> => {
    const scope = ACTIVE_NETWORK.key
    const kept = await storedIndexArtifact(scope, m.packHash)
    if (kept !== undefined) return ObjectLocator.parse(kept)
    // Rows are read only from this copy's own Platform chunks (its uploader's, under this repo),
    // and kept under that copy: never another copy's or an external mirror's, whose ranges are
    // anyone's. Any range that cannot be read sends the lookup to the whole read, which is
    // checked against the pack hash and may use every copy (`RangedLocator.rowsFor`).
    const copy = copyScope(repo, m)
    const readRange = gatherRanges(
      (ranges) => storedIndexRanges(copy, m.packHash, ranges),
      (start, end) => fetchPlatformRange(sdk, repo, m, start, end),
      (start, end, bytes) => keepIndexRange(copy, m.packHash, start, end, bytes),
    )
    // A Platform copy is read a chunk at a time whatever the range: read the index in chunks too.
    const granule = CHUNK_PAYLOAD_MAX
    const loadWhole = async (): Promise<Uint8Array> => (await wholeFragment(sdk, repo, m, progressKey)).asBytes()
    return RangedLocator.open(await readRange(0, FANOUT_LEN), { sizeBytes: m.sizeBytes, granule, readRange, loadWhole }) ?? ObjectLocator.parse(await loadWhole())
  })()
  opened.set(memo, open)
  open.catch(() => {
    if (opened.get(memo) === open) opened.delete(memo)
  })
  trimOldest(opened, OPENED_FRAGMENTS_KEPT)
  return open
}

/**
 * The merged index `repo`'s published fragments make over `space` (its live pack space): null
 * when it published none, `behind` when they cannot be trusted over this space (or will not
 * load). Coverage is the caller's: a fragment may index only part of the space.
 *
 * `ranged`: a fragment stored on Platform of {@link RANGED_INDEX_MIN_BYTES} or more is not
 * downloaded; the answer is then an {@link ObjectIndex} reading it a chunk at a time, and only when
 * the fragments cover `space` ({@link rangedCoverage}), so the caller needs no coverage check
 * of its own. Only Platform copies: their chunks come proof-checked from the fragment's uploader,
 * where an external mirror's range is anyone's and only a whole artifact is checked (its sha256).
 * `progressKey`: the repo whose code pages show a whole read's progress (a fork's, for its parent).
 */
async function publishedLocator(
  sdk: EvoSDK,
  repo: RepoRef,
  manifests: readonly PackManifest[],
  space: readonly PackManifest[],
  { ranged = false, progressKey = repoKey(repo) }: { readonly ranged?: boolean; readonly progressKey?: string } = {},
): Promise<ObjectLocator | ObjectIndex | null | 'behind'> {
  const fragments = locatorFragments(manifests)
  if (fragments.length === 0) return null

  // Every fragment must index a PREFIX of the current pack space, or the `packRef`s merged
  // from different fragments would mean different packs. Between repacks the live pack list
  // only grows at the end, so this holds; a repack breaks it and supersedes the fragments it
  // consolidated, so the only way to fail is a fragment published concurrently with a
  // repack. Checked from the manifest list alone, before any bytes are fetched.
  const reachOf = new Map<PackManifest, number>()
  for (const f of fragments) {
    // As of the fragment's first upload `(createdAt, id)`.
    const asOf = locatorPackSpace(manifests, { createdAt: f.createdAt, id: f.documentId })
    if (asOf.length > space.length) return 'behind'
    if (asOf.some((m, i) => m.packHash !== space[i]?.packHash)) return 'behind'
    reachOf.set(f, asOf.length)
  }

  // Oldest-first for a stable row order. Rows are keyed by `(oid, packRef)`, so the merge
  // result does not actually depend on it — `ObjectLocator.merge` explains why.
  const ordered = [...fragments].reverse()
  // A fragment that will not load or parse leaves an index that cannot answer for the
  // packs it was supposed to cover — the same situation as a missing one, and the same
  // honest answer: the raw packs are still readable, so route to the fallback clone. It
  // must not become a browse ERROR, which is what a rejection here would produce
  // (`loadBrowseContextCached` evicts the entry and `BrowseBoundary` renders `ErrorState`),
  // because that hides a repo the reader could perfectly well have served. Up to
  // MAX_LOCATOR_FRAGMENTS artifacts are fetched per resolve, so one transient `chunk`
  // query failure is enough to reach this.
  let locator: ObjectLocator
  try {
    let parts = await Promise.all(
      ordered.map((m) =>
        ranged && m.storage === 0 && m.sizeBytes >= RANGED_INDEX_MIN_BYTES ? openFragment(sdk, repo, m) : wholeFragment(sdk, repo, m, progressKey),
      ),
    )
    if (parts.some((p) => p instanceof RangedLocator)) {
      // Answered a chunk at a time. A ranged row naming a pack past the space fails its read
      // (`buildPackSource`); the whole parts' bounds are checked by `rangedCoverage`.
      const coverage = rangedCoverage(parts, ordered.map((f) => reachOf.get(f) ?? 0), space)
      if (coverage === 'covered') return new FragmentedIndex(parts)
      if (coverage === 'uncovered') return 'behind'
      parts = await Promise.all(parts.map((p) => (p instanceof RangedLocator ? p.loadWhole() : p)))
    }
    locator = ObjectLocator.merge(parts as ObjectLocator[])
  } catch {
    return 'behind'
  }
  // Out-of-range refs mean the fragments were built over a different pack space than the
  // one derived here — a prefix check cannot see this, a bounds check can.
  for (const r of locator.packRefsCovered()) {
    if (r >= space.length) return 'behind'
  }
  return locator
}

/** An ancestor of a fork whose pack list its resolve read: its history indexes serve the fork too. */
interface Ancestor {
  readonly repo: RepoRef
  readonly manifests: readonly PackManifest[]
}

/** How many forks up an index is looked for. A cycle cannot be written (`forkOf` names an older repo); the bound is cheap insurance. */
const MAX_FORK_DEPTH = 4

/**
 * `own` (a repo's own published index over `space`, or null) completed with what its ancestors
 * published (QW-023), each ancestor read pushed onto `lineage`. `own` when `repo` is not a fork
 * or nothing more can be used.
 */
async function withAncestors(
  sdk: EvoSDK,
  repo: RepoRef,
  own: ObjectLocator | null,
  space: readonly PackManifest[],
  lineage: Ancestor[],
  depth: number,
  /** The repo viewed (the fork): its code pages show the ancestors' index reads. */
  progressKey: string = repoKey(repo),
): Promise<ObjectLocator | null> {
  const inherited = depth < MAX_FORK_DEPTH ? await inheritedIndex(sdk, repo, space, lineage, depth, progressKey) : null
  if (inherited === null) return own
  return own === null ? inherited : ObjectLocator.merge([own, inherited])
}

/**
 * A fork's parent's index, remapped into the fork's pack space (QW-023). A fork records each
 * parent pack by reference (`lib/repo/fork.ts`), the same `packHash` and so the same bytes, but
 * the parent's fragments number packs by the PARENT's list. Each parent `packRef` is mapped to
 * the fork's position of the same pack, and the rows of packs the fork does not hold (pushed to
 * the parent since) are dropped, so a fork reads nothing it does not have. A parent that is a
 * fork itself contributes its own parent's the same way. Without this every visitor of a fork
 * rebuilt its whole index in the browser (the fallback clone).
 *
 * Null when `repo` is not a fork, no ancestor published an index this can trust, or none of it
 * is the fork's; a failed read is null too (the fallback clone is still correct), never an error.
 */
async function inheritedIndex(
  sdk: EvoSDK,
  repo: RepoRef,
  space: readonly PackManifest[],
  lineage: Ancestor[],
  depth: number,
  progressKey: string,
): Promise<ObjectLocator | null> {
  if (repo.visibility !== 'public') return null
  try {
    const parent = await readForkParent(sdk, repo)
    if (parent === null) return null
    const manifests = await readBrowseManifests(sdk, parent, { network: ACTIVE_NETWORK.network })
    lineage.push({ repo: parent, manifests })
    const parentSpace = locatorPackSpace(manifests)
    // Whole: a fork remaps every row of its parent's index into its own pack space.
    const published = await publishedLocator(sdk, parent, manifests, parentSpace, { progressKey })
    if (published === 'behind' || (published !== null && !(published instanceof ObjectLocator))) return null
    const full =
      published !== null && coversSpace(published, parentSpace) ? published : await withAncestors(sdk, parent, published, parentSpace, lineage, depth + 1, progressKey)
    if (full === null) return null
    const at = new Map(space.map((m, i) => [m.packHash.toLowerCase(), i]))
    const map = new Map<number, number>()
    parentSpace.forEach((m, i) => {
      const j = at.get(m.packHash.toLowerCase())
      if (j !== undefined) map.set(i, j)
    })
    if (map.size === 0) return null
    const locator = full.remapPacks(map)
    return locator.count === 0 ? null : locator
  } catch {
    return null
  }
}

/**
 * Give a context's reader the repository's history index ({@link historySource}): the file list's
 * commit column and the commit count read it instead of walking history. From the manifests the
 * resolve already read, so it costs nothing until a view loads an index. A fork also reads the
 * indexes of the ancestors its resolve read (`lineage`, nearest first): an index describes a tip
 * commit's history, the same in every repository holding it. (A fork whose own index covers all
 * its packs reads no ancestor, and so has only its own.)
 */
function attachRepoHistory(
  sdk: EvoSDK,
  repo: RepoRef,
  reader: BrowseReader,
  manifests: readonly PackManifest[],
  lineage: readonly Ancestor[],
): void {
  const own = historySource(manifests, (m) => loadArtifactBytes(sdk, repo, m))
  const inherited = lineage.reduceRight<HistorySource | null>(
    (older, a) => chainHistory(historySource(a.manifests, (m) => loadArtifactBytes(sdk, a.repo, m)), older),
    null,
  )
  attachHistory(reader.memoScope, chainHistory(own, inherited))
}

/**
 * The error a view gets for an object an in-browser clone does not hold, when some packs were
 * skipped: it names them and where they were looked for, instead of a bare "not in locator".
 */
export function missingObjectError(
  oidHex: string,
  unavailable: readonly UnavailablePack[],
): MissingObjectError {
  const where = unavailable
    .map((p) => `${p.packHash.slice(0, 12)}… (${p.hosts.length > 0 ? p.hosts.join(', ') : 'no fetchable mirror'})`)
    .join('; ')
  // Name the storage that actually failed: a fork's pack is read from its parent's chunks on
  // Platform (a `platform://` locator), not from anyone's external mirrors.
  const onPlatform = unavailable.some((p) => p.hosts.includes('platform'))
  const external = unavailable.some((p) => p.hosts.some((h) => h !== 'platform'))
  const source =
    onPlatform && !external
      ? "the parent repo's chunks on Platform"
      : onPlatform
        ? "the parent repo's chunks on Platform or external storage"
        : 'external storage'
  const n = unavailable.length
  return new MissingObjectError(
    `object ${oidHex.slice(0, 12)}… is not in any pack this browser could load. ` +
      `${n === 1 ? 'One pack' : `${n} packs`} could not be fetched from ${source} and may hold it: ${where}. ` +
      `Cloning with dash:// reads the same ${n === 1 ? 'pack' : 'packs'}; if ${onPlatform && !external ? 'those chunks are missing' : 'the storage is down'} it will fail the same way.`,
  )
}

/**
 * A reader of `repo` — over its published index, or an in-browser clone. A read of an object
 * `locator` does not index re-resolves the repo once ({@link readerAfterMiss}): the reader may
 * predate a push or a merge (L-08, L-09). `unavailable`: packs a partial clone could not fetch,
 * named by a miss the re-resolve does not answer. `sdk` null: no re-resolve (a restored clone
 * opened before the SDK connected).
 */
export function repoReader(
  sdk: EvoSDK | null,
  repo: RepoRef,
  locator: ObjectLocator | ObjectIndex,
  packs: PackSource,
  /** Each `packRef`'s pack (and its copies), so a read names the copy that served it (L-18). */
  space: readonly PackManifest[],
  unavailable: readonly UnavailablePack[] = [],
): BrowseReader {
  const key = repoKey(repo)
  const reader: BrowseReader = new BrowseReader(locator, packs, {
    onObject: objectObserver(key),
    // Bytes that never arrived: the views re-read once the connection is back (L-10).
    onUnreachable: () => noteReadOutage(key),
    onRead: (packRef, copy, view) => {
      const m = space[packRef]
      if (m === undefined) return
      const doc = copy === undefined ? undefined : (m.copies ?? [m])[copy]?.documentId
      noteViewPack(key, doc === undefined ? m.packHash : `${m.packHash}#${doc}`, view)
    },
    missingObject: unavailable.length > 0 ? (oid) => missingObjectError(oid, unavailable) : undefined,
    onMiss: sdk === null ? undefined : (oid) => readerAfterMiss(sdk, repo, reader, oid),
  })
  return reader
}

// ---------------------------------------------------------------------------
// Browse-context session cache
// ---------------------------------------------------------------------------

/**
 * One browse context per repo (`repoKey`) for the session (the locator-path analog of the
 * fallback-clone cache in `browse-fallback.ts`) — navigating between a repo's pages must
 * not re-fetch manifests, re-download the locator, or discard the reader's warm state.
 *
 * A `ready` state (locator published — content-addressed, effectively immutable) lives
 * {@link BROWSE_READY_TTL_MS}; `unindexed` / `no-packs` live only {@link BROWSE_RETRY_TTL_MS}
 * so a locator or first pack published out-of-band (CLI / relay — the web UI never
 * publishes packs) is noticed quickly. Rejected loads are evicted so a retry starts clean.
 */
const BROWSE_READY_TTL_MS = 5 * 60_000
const BROWSE_RETRY_TTL_MS = 60_000

/**
 * Age at which a live `ready` hit is still served, but refreshed behind it.
 *
 * A `ready` context used to be treated as effectively immutable — the locator is
 * content-addressed, so why re-read it? That stopped being true when pushes started
 * extending the index: the artifacts are immutable, the SET of live fragments is not. Held
 * for the full TTL, a context resolved before a push is paired with a ref list that
 * `useRepoHome` revalidates after 30 s, so the page shows a tip commit the reader's
 * fragments do not cover and `readObject` throws `object not in locator` — precisely the
 * failure the coverage check exists to turn into an honest `index-behind`. Those checks run
 * at resolve time, so the only way to see a push is to resolve again. Matched to
 * `HOME_REVALIDATE_MS` in `hooks/use-repo.ts` so the two cannot drift apart.
 */
const BROWSE_REVALIDATE_MS = 30_000

interface BrowseCacheEntry {
  at: number
  promise: Promise<BrowseState>
  settled?: BrowseState
  /**
   * With `settled`: when its pack list was last checked (it settled, or a re-resolve behind it
   * came back). Every read behind that was issued by then, so the next re-resolve takes only a
   * later one ({@link loadBrowseContext} `after`).
   */
  checkedAt?: number
  /** A re-resolve in flight behind this settled entry (a background revalidation, or a miss). */
  refresh?: Promise<BrowseState>
}
const browseCache = new Map<string, BrowseCacheEntry>()

// A private repo's entries are keyed `repoId#sessionId` and hold decrypted state: they go with
// the session, however it ends (lock, key change, retirement).
onPrivateSessionEnded((id) => {
  for (const k of [...browseCache.keys()]) if (k.endsWith(`#${id}`) || k.includes(`#${id}\0`)) browseCache.delete(k)
})

// This tab stored a pack or moved a ref (a browser merge into the base repo, a branch commit into
// a PR's source repo or fork, a fork) or published a release: the repo's views resolve again, so
// the PR page re-reads its head and the Code tab its tip through the new objects.
onRepoContentWritten((repo) => {
  // The pack list is read from the repo chrome store: its next read asks for what is new.
  staleRepoTimelines(repo)
  for (const k of [...browseCache.keys()]) if (k.startsWith(`${repo.repoId}#`)) invalidateBrowseContext(k)
  invalidateBrowseContext(repo.repoId)
})

function browseEntryLive(entry: BrowseCacheEntry): boolean {
  const ttl =
    entry.settled === undefined || entry.settled.kind === 'ready'
      ? BROWSE_READY_TTL_MS
      : BROWSE_RETRY_TTL_MS
  return Date.now() - entry.at < ttl
}

// Generations: how the views of a repo learn that its browse context changed under them.
const generations = new Map<string, number>()
const generationListeners = new Set<() => void>()

function bump(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  for (const listener of generationListeners) listener()
}

/**
 * How often this session had the views of a repo (`repoKey`) read its browse state again: an
 * explicit invalidate ("Try again", this tab's own write), or a read that missed and found a
 * newer pack list. `useBrowse` re-reads whenever it changes.
 *
 * A background revalidation that sees someone else's push replaces the cached context quietly,
 * without a bump: an open diff, file or half-typed review comment is not remounted under the
 * reader for a push it did not ask about. A view's own reads that the old reader cannot answer
 * reach the new context through its miss ({@link readerAfterMiss}), which does bump.
 */
export function browseGeneration(key: string): number {
  return generations.get(key) ?? 0
}

/** Run `listener` whenever some repo's {@link browseGeneration} changes. */
export function subscribeBrowseGeneration(listener: () => void): () => void {
  generationListeners.add(listener)
  return () => {
    generationListeners.delete(listener)
  }
}

/**
 * Drop a repo's cached browse context, by `repoKey`, and have every view of it resolve again:
 * an explicit reload, a "Try again", or the end of a write this tab made.
 */
export function invalidateBrowseContext(key: string): void {
  browseCache.delete(key)
  bump(key)
}

/** The cached settled browse state for a repo (`repoKey`), if still live — for first-paint seeding. */
export function peekBrowseState(key: string): BrowseState | undefined {
  const entry = browseCache.get(key)
  if (entry === undefined || !browseEntryLive(entry)) return undefined
  return entry.settled
}

/** Resolve `repo` into a new cache entry. */
function startEntry(sdk: EvoSDK, repo: RepoRef, key: string): BrowseCacheEntry {
  const entry: BrowseCacheEntry = { at: Date.now(), promise: loadBrowseContext(sdk, repo) }
  browseCache.set(key, entry)
  entry.promise
    .then((state) => {
      entry.settled = state
      entry.checkedAt = Date.now()
    })
    .catch(() => {
      if (browseCache.get(key) === entry) browseCache.delete(key)
    })
  return entry
}

/**
 * Resolve `repo` again behind a settled entry, joining a re-resolve already in flight. A state
 * that {@link supersedes} the cached one replaces it; any other keeps the entry and its warm
 * reader (the same pack list, or a lagging node's older one). Resolves with the state the cache
 * holds afterwards. `after`: only a timelines read issued after it answers ({@link loadBrowseContext}).
 */
function refreshEntry(sdk: EvoSDK, repo: RepoRef, key: string, hit: BrowseCacheEntry & { settled: BrowseState }, after: number): Promise<BrowseState> {
  if (hit.refresh !== undefined) return hit.refresh
  const refresh = loadBrowseContext(sdk, repo, { after })
    .then((state) => {
      // An explicit reload may have dropped the entry meanwhile: leave its successor alone.
      if (browseCache.get(key) !== hit) return state
      const now = Date.now()
      if (!supersedes(state, hit.settled)) {
        hit.checkedAt = now
        // Only a read that saw this very pack list counts as fresh: a lagging node's does not.
        if (manifestsOf(state).size === manifestsOf(hit.settled).size) hit.at = now
        return hit.settled
      }
      browseCache.set(key, { at: now, promise: Promise.resolve(state), settled: state, checkedAt: now })
      return state
    })
    .finally(() => {
      hit.refresh = undefined
    })
  hit.refresh = refresh
  return refresh
}

/** A live, settled cache entry for `key`, if there is one. */
function settledEntry(key: string): (BrowseCacheEntry & { settled: BrowseState }) | undefined {
  const hit = browseCache.get(key)
  return hit !== undefined && hit.settled !== undefined && browseEntryLive(hit) ? (hit as BrowseCacheEntry & { settled: BrowseState }) : undefined
}

/**
 * {@link loadBrowseContext} through the session cache (in-flight loads are joined).
 *
 * Stale-while-revalidate: a hit older than {@link BROWSE_REVALIDATE_MS} is still returned
 * immediately, and a fresh resolve starts behind it; a newer pack list it finds is what the next
 * view of the repo gets.
 */
export function loadBrowseContextCached(sdk: EvoSDK, repo: RepoRef): Promise<BrowseState> {
  const key = repoKey(repo)
  const hit = browseCache.get(key)
  if (hit === undefined || !browseEntryLive(hit)) return startEntry(sdk, repo, key).promise
  const settled = settledEntry(key)
  if (settled !== undefined && Date.now() - settled.at >= BROWSE_REVALIDATE_MS) {
    // A failure keeps serving the last good state; the TTL forces a fresh resolve. Any read issued
    // since the entry was last checked will do (the home's revalidation of a moment ago, D-11).
    refreshEntry(sdk, repo, key, settled, settled.checkedAt ?? Date.now()).catch(() => undefined)
  }
  return hit.promise
}

/**
 * How long a stale reader's misses share one re-resolve's answer: a walk meeting many objects the
 * repo does not hold (a fork's history, a merge check) costs one manifest read, not one per
 * object. Short, because "nothing newer" may have come from a node a block behind the write
 * that made the object: the next miss after it asks again. A failed resolve is not kept.
 */
export const MISS_REFRESH_MS = 5_000
const missRefreshes = new WeakMap<BrowseReader, { readonly at: number; readonly promise: Promise<BrowseReader | null> }>()

/**
 * A read of an object `stale`'s locator does not index. The context may predate a push, a merge,
 * a branch commit or a new index fragment (L-08, L-09): resolve the repo again, once, and hand
 * back the newer reader — or null when no newer pack list was found (the object is not there, or
 * the node answering is behind) or the resolve failed. Nothing is read when the cache already
 * holds a reader that has the object. A newer context found here is announced
 * ({@link browseGeneration}), so the repo's other views move to it too.
 */
async function readerAfterMiss(sdk: EvoSDK, repo: RepoRef, stale: BrowseReader, oidHex: string): Promise<BrowseReader | null> {
  const key = repoKey(repo)
  // The locator is immutable: a cached reader indexing the oid is not `stale`.
  const cached = peekBrowseState(key)
  if (cached?.kind === 'ready' && cached.context.reader !== stale) {
    const reader = cached.context.reader
    if ((await reader.locate(oidHex).catch(() => null)) !== null) return reader
  }
  const held = missRefreshes.get(stale)
  if (held !== undefined && Date.now() - held.at < MISS_REFRESH_MS) return held.promise
  const before = peekBrowseState(key)
  const resolveAgain = (): Promise<BrowseState> => {
    const hit = settledEntry(key)
    // A read issued now (or one in flight): the object may come from a push newer than any read
    // held, such as a PR head or a linked commit.
    if (hit !== undefined) return refreshEntry(sdk, repo, key, hit, Date.now())
    const pending = browseCache.get(key)
    // The first resolve is still in flight: it started after `stale` was made.
    if (pending !== undefined && browseEntryLive(pending)) return pending.promise
    return startEntry(sdk, repo, key).promise
  }
  const promise = resolveAgain().then(
    (state) => {
      if (state !== before && (before === undefined || supersedes(state, before))) bump(key)
      return state.kind === 'ready' && state.context.reader !== stale ? state.context.reader : null
    },
    () => {
      if (missRefreshes.get(stale)?.promise === promise) missRefreshes.delete(stale)
      return null
    },
  )
  missRefreshes.set(stale, { at: Date.now(), promise })
  return promise
}

/** Test hook: forget every cached browse context. */
export function resetBrowseCache(): void {
  browseCache.clear()
  openedFragments = new WeakMap()
}
