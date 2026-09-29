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

import { ACTIVE_NETWORK, CHUNK_PAYLOAD_MAX, PACK_KIND } from '../constants'
import { loadIndexArtifact } from './index-cache'
import { attachHistory, historySource } from './history-source'
import {
  BrowseReader,
  FlatIndex,
  MissingObjectError,
  ObjectLocator,
  type PackSource,
} from '../browse'
import {
  CHUNK_QUERY_MAX,
  readPackCopies,
  packsOfKind,
  type AsOf,
  readNewestManifestOfKind,
  readBrowseManifests,
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
import { mapPooled } from './pool'
import { openPrivateArtifact, readPrivateRange } from './private-packs'
import { onPrivateSessionEnded } from '../repo/private-session'

/** Chunk queries in flight at once when one range spans more than a single query. */
const CHUNK_QUERY_POOL = 6

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
 * Chunks are content-addressed (`packHash` is the artifact's sha256) and immutable, so a
 * session-wide LRU is always safe. Entries hold the fetch PROMISE, so concurrent reads of
 * the same chunk dedupe to one query. Only resolved entries carry a size and count toward
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

/** Test hook: drop all cached chunks (and reset the byte budget). */
export function clearChunkCache(): void {
  chunkCache.clear()
  chunkCacheBytes = 0
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
      const { documents } = await queryDocumentsWithProof(
        sdk,
        source.chunkQuery(manifest.packHash, manifest.uploader, batch),
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
  // Keyed by network, repo and uploader, not the pack hash alone: every writer has its own copy
  // of a pack (`forge-v2.md` §4), and a hostile copy's chunks must never be served for an
  // honest one — nor one repo's for another's, nor one network's for another's. A fork reads
  // its parent's chunks under the parent's repo id, so the two share entries.
  const cachePrefix = `${ACTIVE_NETWORK.key}:${repoKey(repo)}:${manifest.uploader}:${packHashHex}`
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
    const batch = queryChunkBatch(sdk, repo, manifest, missing)
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
  ) {
    super(
      `pack ${packHash.slice(0, 12)}… could not be fetched from its storage (${
        hosts.length > 0 ? hosts.join(', ') : 'no browser-fetchable mirror recorded'
      }): ${reason}`,
    )
    this.name = 'PackUnavailableError'
  }
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

/** Why a URL failed: a timeout is worth one more sequential try, anything else is not. */
class FetchFailure extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message)
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
  const s = slot
  if (s.active >= PER_ORIGIN_CONCURRENCY) await new Promise<void>((resolve) => s.waiting.push(resolve))
  s.active += 1
  try {
    return await run()
  } finally {
    s.active -= 1
    s.waiting.shift()?.()
  }
}

/**
 * URLs that failed this session for a reason other than a timeout (connection refused, 404,
 * wrong bytes). A later pack naming the same mirror skips them rather than paying for the
 * same failure again. Keyed by URL, not host: one gateway may lack one CID and hold another.
 */
const deadUrls = new Set<string>()

/**
 * Mark `url` dead, unless the browser is offline: then nothing could have answered, and the
 * mirror must be tried again once the connection is back (L-10).
 */
function markDead(url: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  deadUrls.add(url)
}

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
      if (!resp.ok && resp.status !== 206) throw new FetchFailure(`HTTP ${resp.status}`, false)
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
          throw new FetchFailure('served more bytes than the manifest records', false)
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
): Promise<{ readonly live: string[]; readonly reasons: string[] }> {
  const verdicts = await Promise.all(
    urls.map(async (url) => {
      const gw = recorded.has(url) ? null : gatewayOf(url)
      return { url, down: gw === null ? null : await gatewayHealth(gw) }
    }),
  )
  const live: string[] = []
  const reasons = new Set<string>()
  for (const { url, down } of verdicts) {
    if (down === null) live.push(url)
    else reasons.add(gatewayDownReason(externalSourceName(url), down))
  }
  if (live.length === 0) return { live: [...urls], reasons: [] }
  return { live, reasons: [...reasons] }
}

/** An artifact's fetchable URLs, and those still worth trying (not failed this session, gateway up). */
async function mirrorUrls(
  manifest: PackManifest,
  gateways: readonly string[],
): Promise<{ readonly urls: string[]; readonly live: string[]; readonly downReasons: string[] }> {
  const urls = externalFetchUrls(manifest.uris, gateways)
  const { live, reasons } = await skipDeadGateways(
    urls.filter((u) => !deadUrls.has(u)),
    new Set(manifest.uris),
  )
  return { urls, live, downReasons: reasons }
}

/**
 * Fetch a contiguous range of an external artifact via HTTP Range, trying each fetchable
 * mirror in turn. `onServed` is told which URL answered, so the trust panel can name the host
 * bytes actually came from. A range cannot be hashed on its own: the reader re-hashes every
 * object it reconstructs from it.
 */
async function fetchExternalRange(
  manifest: PackManifest,
  start: number,
  end: number,
  gateways: readonly string[],
  onServed?: (uri: string) => void,
): Promise<Uint8Array> {
  const { urls, live, downReasons } = await mirrorUrls(manifest, gateways)
  let lastErr: unknown = downReasons.join('; ') || 'no browser-fetchable mirror'
  for (const url of live) {
    try {
      const buf = await fetchBody(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
      onServed?.(url)
      // Some hosts ignore Range and return the whole body — slice defensively.
      return buf.length > end - start ? buf.subarray(start, end) : buf
    } catch (e) {
      if (e instanceof FetchFailure && !e.timedOut) markDead(url)
      lastErr = e
    }
  }
  throw new PackUnavailableError(manifest.packHash, hostsOf(urls), false, errorText(lastErr))
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
  onServed?: (uri: string) => void,
  cancel?: AbortSignal,
): Promise<Uint8Array> {
  const { urls, live, downReasons } = await mirrorUrls(manifest, gateways)
  const want = manifest.packHash.toLowerCase()
  if (live.length === 0) {
    throw new PackUnavailableError(
      manifest.packHash,
      hostsOf(urls),
      false,
      urls.length === 0 ? 'nothing to try' : downReasons.join('; ') || 'every mirror already failed this session',
    )
  }
  let corrupt = false
  const reasons: string[] = [...downReasons]
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
        throw new FetchFailure('served bytes that do not match the manifest sha256', false)
      }
      return { url, bytes }
    } catch (e) {
      if (!winner.signal.aborted) {
        reasons.push(`${externalSourceName(url)}: ${errorText(e)}`)
        if (e instanceof FetchFailure && e.timedOut) timedOut.push(url)
        else markDead(url)
      }
      throw e
    }
  }

  try {
    const got = (await raceBounded(live, MIRROR_RACE_WIDTH, attempt, winner.signal)) ??
      (await firstSequential(timedOut, attempt, winner.signal))
    if (got !== null) {
      winner.abort()
      onServed?.(got.url)
      return got.bytes
    }
    if (cancel?.aborted) throw new Error('the in-browser clone was cancelled')
    throw new PackUnavailableError(manifest.packHash, hostsOf(urls), corrupt, reasons.join('; '))
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
  return { packHash: e.packHash, hosts: e.hosts, reason: e.reason, corrupt: e.corrupt }
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

/** A ranged reader over one artifact (platform chunks or external URIs), optionally one copy. */
export function artifactRangeFetch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): (start: number, end: number, copy?: number) => Promise<Uint8Array> {
  const readCopy = async (copy: PackManifest, start: number, end: number): Promise<Uint8Array> => {
    if (copy.storage !== 0) {
      // Chunks a `platform://` locator names first: on-chain, so no mirror can hold a browse
      // hostage. A range cannot be hashed on its own; the reader re-hashes what it builds.
      let lastErr: unknown
      for (const at of platformLocatorReads(repo, copy)) {
        try {
          const bytes = await fetchPlatformRange(sdk, at.repo, at.manifest, start, end)
          noteSource(repo, copy.packHash, undefined, copy.documentId)
          return bytes
        } catch (e) {
          lastErr = e
        }
      }
      const gateways = readGatewaysFor(repoKey(repo))
      if (lastErr !== undefined && externalFetchUrls(copy.uris, gateways).length === 0) {
        throw new PackUnavailableError(copy.packHash, ['platform'], false, errorText(lastErr))
      }
      return fetchExternalRange(copy, start, end, gateways, (uri) => noteSource(repo, copy.packHash, uri, copy.documentId))
    }
    const bytes = await fetchPlatformRange(sdk, repo, copy, start, end)
    noteSource(repo, copy.packHash, undefined, copy.documentId)
    return bytes
  }
  // A private repo's artifacts are sealed: the reader asks for PLAINTEXT ranges (locator rows
  // index plaintext offsets), mapped to sealed segments through the session's header cache.
  const session = repo.session
  const readPlain =
    session === undefined
      ? readCopy
      : (c: PackManifest, start: number, end: number) => readPrivateRange(session, c, (s, e) => readCopy(c, s, e), start, end)
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
    for (const c of copies) {
      try {
        return await readPlain(c, start, end)
      } catch (e) {
        lastErr = e
      }
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
 * throws {@link PackUnavailableError} when none does.
 */
export async function loadArtifactBytesProgress(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
  cancel?: AbortSignal,
): Promise<Uint8Array> {
  // A private repo: every copy's sealed bytes are checked against `packHash`, then its standing,
  // then decrypted; the plaintext is what the caller gets.
  const session = repo.session
  const open = async (copy: PackManifest): Promise<Uint8Array> => {
    const bytes = await loadOneCopy(sdk, repo, copy, onProgress, cancel)
    return session === undefined ? bytes : openPrivateArtifact(session, copy, bytes, manifest.copies ?? [copy])
  }
  const verified = (copy: PackManifest, bytes: Uint8Array): boolean =>
    session !== undefined || bytesToHex(sha256(bytes)) === copy.packHash.toLowerCase()
  if (manifest.copies === undefined) return open(manifest)
  // Every writer may hold a copy of a pack. Read them in `orderPackCopies` order
  // and keep the first whose bytes hash to `packHash`; a copy that does not, or that cannot
  // be read (a missing chunk, a dead mirror), is skipped (`forge-v2.md` §4 reader rule). A
  // pack no copy serves is unreadable.
  const failures: unknown[] = []
  for (const copy of manifest.copies) {
    try {
      const bytes = await open(copy)
      if (verified(copy, bytes)) return bytes
      failures.push(new Error(`copy ${copy.documentId.slice(0, 8)}… does not hash to the pack`))
    } catch (e) {
      // A cancelled load stops here: the next copy is not tried.
      if (cancel?.aborted) throw e
      failures.push(e)
    }
  }
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
): Promise<Uint8Array> {
  const total = manifest.sizeBytes
  if (total <= 0) return new Uint8Array(0)
  onProgress?.(0, total)
  if (manifest.storage !== 0) {
    const bytes = await loadExternalCopy(sdk, repo, manifest, onProgress, cancel)
    onProgress?.(total, total)
    return bytes
  }
  const out = await loadPlatformWhole(sdk, repo, manifest, onProgress, cancel)
  noteSource(repo, manifest.packHash)
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
        noteSource(repo, manifest.packHash)
        return bytes
      }
      corrupt = true
      reasons.push('platform: chunks do not match the manifest sha256')
    } catch (e) {
      if (cancel?.aborted) throw e
      reasons.push(`platform: ${errorText(e)}`)
    }
  }
  const gateways = readGatewaysFor(repoKey(repo))
  if (reasons.length === 0) return fetchExternalWhole(manifest, gateways, (uri) => noteSource(repo, manifest.packHash, uri), cancel)
  const unavailable = (hosts: readonly string[], why: readonly string[], bad: boolean): PackUnavailableError =>
    new PackUnavailableError(manifest.packHash, ['platform', ...hosts], corrupt || bad, [...reasons, ...why].join('; '))
  if (externalFetchUrls(manifest.uris, gateways).length === 0) throw unavailable([], [], false)
  try {
    return await fetchExternalWhole(manifest, gateways, (uri) => noteSource(repo, manifest.packHash, uri), cancel)
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
}

/** The assembled browse context for a repo, or a reason it is unavailable. */
export interface BrowseContext {
  readonly locator: ObjectLocator
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
  /** A read started now: a re-resolve must not be answered by the read it is checking. */
  { fresh = false }: { readonly fresh?: boolean } = {},
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
  const manifests = await readBrowseManifests(sdk, repo, { fresh, network: ACTIVE_NETWORK.network })
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

  const fragments = locatorFragments(manifests)
  if (fragments.length === 0) return behind('no-index')

  // Every fragment must index a PREFIX of the current pack space, or the `packRef`s merged
  // from different fragments would mean different packs. Between repacks the live pack list
  // only grows at the end, so this holds; a repack breaks it and supersedes the fragments it
  // consolidated, so the only way to fail is a fragment published concurrently with a
  // repack. Checked from the manifest list alone, before any bytes are fetched.
  for (const f of fragments) {
    // As of the fragment's first upload `(createdAt, id)`.
    const asOf = locatorPackSpace(manifests, { createdAt: f.createdAt, id: f.documentId })
    if (asOf.length > livePacks.length) return behind('index-behind')
    if (asOf.some((m, i) => m.packHash !== livePacks[i]?.packHash)) return behind('index-behind')
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
    // Fragments are content-addressed: a verified copy from an earlier visit is reused
    // instead of downloading the whole index on every page load (D-023).
    const parts = await Promise.all(
      ordered.map(async (m) =>
        ObjectLocator.parse(await loadIndexArtifact(ACTIVE_NETWORK.key, m.packHash, () => loadArtifactBytes(sdk, repo, m))),
      ),
    )
    locator = ObjectLocator.merge(parts)
  } catch {
    return behind('index-behind')
  }

  // Coverage: every pack in the space that HOLDS anything must be indexed by some fragment.
  // A gap means objects that exist on-chain are unreachable through the index — the honest
  // answer is the fallback clone, not a reader that throws on the first uncovered object.
  //
  // The `objectCount > 0` exemption is not a loophole: a zero-object pack contributes no
  // rows, so its packRef could never appear in `covered` and the repo would read as
  // index-behind forever. The push path no longer stores one (forge-core
  // `upload_push_pack`), but repos pushed by an older client can already carry one — a new
  // branch or tag at an already-stored commit packed nothing.
  const covered = locator.packRefsCovered()
  const complete = livePacks.every((m, i) => m.objectCount === 0 || covered.has(i))
  if (!complete) return behind('index-behind')
  // Out-of-range refs mean the fragments were built over a different pack space than the
  // one derived here — a prefix check cannot see this, a bounds check can.
  for (const r of covered) {
    if (r >= livePacks.length) return behind('index-behind')
  }

  // The packRef space is the current live pack set: the fragments cover all of it, and each
  // was built over a prefix of it, so every row's packRef means the same pack here.
  const packs = buildPackSource(sdk, repo, manifests)
  const reader = repoReader(sdk, repo, locator, packs, livePacks)
  attachRepoHistory(sdk, repo, reader, manifests)
  return { kind: 'ready', context: { locator, packs, reader }, manifests: ids }
}

/**
 * Give a context's reader the repository's history index ({@link historySource}): the file list's
 * commit column and the commit count read it instead of walking history. From the manifests the
 * resolve already read, so it costs nothing until a view loads an index.
 */
function attachRepoHistory(sdk: EvoSDK, repo: RepoRef, reader: BrowseReader, manifests: readonly PackManifest[]): void {
  attachHistory(reader.memoScope, historySource(manifests, (m) => loadArtifactBytes(sdk, repo, m)))
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
  locator: ObjectLocator,
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
 * holds afterwards.
 */
function refreshEntry(sdk: EvoSDK, repo: RepoRef, key: string, hit: BrowseCacheEntry & { settled: BrowseState }): Promise<BrowseState> {
  if (hit.refresh !== undefined) return hit.refresh
  const refresh = loadBrowseContext(sdk, repo, { fresh: true })
    .then((state) => {
      // An explicit reload may have dropped the entry meanwhile: leave its successor alone.
      if (browseCache.get(key) !== hit) return state
      if (!supersedes(state, hit.settled)) {
        // Only a read that saw this very pack list counts as fresh: a lagging node's does not.
        if (manifestsOf(state).size === manifestsOf(hit.settled).size) hit.at = Date.now()
        return hit.settled
      }
      browseCache.set(key, { at: Date.now(), promise: Promise.resolve(state), settled: state })
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
    // A failure keeps serving the last good state; the TTL forces a fresh resolve.
    refreshEntry(sdk, repo, key, settled).catch(() => undefined)
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
function readerAfterMiss(sdk: EvoSDK, repo: RepoRef, stale: BrowseReader, oidHex: string): Promise<BrowseReader | null> {
  const key = repoKey(repo)
  // The locator is immutable: a cached reader indexing the oid is not `stale`.
  const cached = peekBrowseState(key)
  if (cached?.kind === 'ready' && cached.context.reader.locate(oidHex) !== null) return Promise.resolve(cached.context.reader)
  const held = missRefreshes.get(stale)
  if (held !== undefined && Date.now() - held.at < MISS_REFRESH_MS) return held.promise
  const before = peekBrowseState(key)
  const resolveAgain = (): Promise<BrowseState> => {
    const hit = settledEntry(key)
    if (hit !== undefined) return refreshEntry(sdk, repo, key, hit)
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
}
