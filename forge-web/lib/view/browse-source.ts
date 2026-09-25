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

import { CHUNK_PAYLOAD_MAX, IPFS_GATEWAYS, PACK_KIND } from '../constants'
import {
  BrowseReader,
  FlatIndex,
  ObjectLocator,
  type PackSource,
  type RangeFetch,
} from '../browse'
import {
  liveGitPackManifests,
  liveLocatorManifests,
  readNewestManifestOfKind,
  readRepoPackManifests,
  repoKey,
  repoSource,
  type PackManifest,
  type RepoRef,
} from '../repo'
import { base64ToBytes, queryDocumentsWithProof } from '../sdk'
import { externalSourceName, noteContentCheck, objectObserver } from './content-checks'

/**
 * Platform's per-query document cap. A document query returns at most this many rows, so any
 * read spanning more than this must be split — see {@link queryChunkBatch}.
 */
const CHUNK_QUERY_MAX = 100

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
 * are queried (one batch — the `(packHash, seq)` index is unique per key, so no
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
  // Keyed by repo and uploader, not the pack hash alone: on forge-v2 every writer has its own
  // copy of a pack (`forge-v2.md` §4), and a hostile copy's chunks must never be served for
  // an honest one — nor one repo's for another's.
  const cachePrefix = `${repoKey(repo)}:${manifest.uploader}:${packHashHex}`
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
    reason: string,
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
 * browser cannot fetch (`s3://`, `platform://`) are skipped — an `s3://` locator always
 * travels with the bucket's public `https` URL, which is listed separately.
 */
export function externalFetchUrls(
  uris: readonly string[],
  gateways: readonly string[] = IPFS_GATEWAYS,
): string[] {
  const out: string[] = []
  for (const uri of uris) {
    if (/^https?:\/\//i.test(uri)) out.push(uri)
    const ipfs = /^ipfs:\/\/(.+)$/i.exec(uri)
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
  let slot = originSlots.get(origin)
  if (slot === undefined) {
    slot = { active: 0, waiting: [] }
    originSlots.set(origin, slot)
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

/** Test hook: forget the dead-URL list and the per-origin queues. */
export function resetExternalFetchState(): void {
  deadUrls.clear()
  originSlots.clear()
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
 * Fetch a contiguous range of an external artifact via HTTP Range, trying each fetchable
 * mirror in turn. `onServed` is told which URL answered, so the trust panel can name the host
 * bytes actually came from. A range cannot be hashed on its own: the reader re-hashes every
 * object it reconstructs from it.
 */
async function fetchExternalRange(
  manifest: PackManifest,
  start: number,
  end: number,
  onServed?: (uri: string) => void,
): Promise<Uint8Array> {
  const urls = externalFetchUrls(manifest.uris)
  let lastErr: unknown = 'no browser-fetchable mirror'
  for (const url of urls.filter((u) => !deadUrls.has(u))) {
    try {
      const buf = await fetchBody(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
      onServed?.(url)
      // Some hosts ignore Range and return the whole body — slice defensively.
      return buf.length > end - start ? buf.subarray(start, end) : buf
    } catch (e) {
      if (e instanceof FetchFailure && !e.timedOut) deadUrls.add(url)
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
  onServed?: (uri: string) => void,
  cancel?: AbortSignal,
): Promise<Uint8Array> {
  const urls = externalFetchUrls(manifest.uris)
  const want = manifest.packHash.toLowerCase()
  const live = urls.filter((u) => !deadUrls.has(u))
  if (live.length === 0) {
    throw new PackUnavailableError(
      manifest.packHash,
      hostsOf(urls),
      false,
      urls.length === 0 ? 'nothing to try' : 'every mirror already failed this session',
    )
  }
  let corrupt = false
  const reasons: string[] = []
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
        else deadUrls.add(url)
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

/** Record in the repo's content-check ledger where an artifact's bytes came from. */
function noteSource(repo: RepoRef, uri?: string): void {
  noteContentCheck(repoKey(repo), {
    source: uri === undefined ? 'platform' : externalSourceName(uri),
  })
}

/** A {@link RangeFetch} over one artifact (platform chunks or external URIs). */
export function artifactRangeFetch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): RangeFetch {
  const readCopy = async (copy: PackManifest, start: number, end: number): Promise<Uint8Array> => {
    if (copy.storage !== 0) {
      return fetchExternalRange(copy, start, end, (uri) => noteSource(repo, uri))
    }
    const bytes = await fetchPlatformRange(sdk, repo, copy, start, end)
    noteSource(repo)
    return bytes
  }
  return async (start: number, end: number) => {
    // forge-v2: a range cannot be hashed on its own (the reader re-hashes every object it
    // builds from it), but a copy that cannot serve the range at all falls through to the
    // next one in `orderPackCopies` order.
    const copies = manifest.copies ?? [manifest]
    let lastErr: unknown
    for (const copy of copies) {
      try {
        return await readCopy(copy, start, end)
      } catch (e) {
        lastErr = e
      }
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
  if (manifest.copies === undefined) return loadOneCopy(sdk, repo, manifest, onProgress, cancel)
  // forge-v2: every writer may hold a copy of a pack. Read them in `orderPackCopies` order
  // and keep the first whose bytes hash to `packHash`; a copy that does not, or that cannot
  // be read (a missing chunk, a dead mirror), is skipped (`forge-v2.md` §4 reader rule). A
  // pack no copy serves is unreadable.
  const failures: unknown[] = []
  for (const copy of manifest.copies) {
    try {
      const bytes = await loadOneCopy(sdk, repo, copy, onProgress, cancel)
      if (bytesToHex(sha256(bytes)) === copy.packHash.toLowerCase()) return bytes
      failures.push(new Error(`copy ${copy.documentId.slice(0, 8)}… does not hash to the pack`))
    } catch (e) {
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
    const bytes = await fetchExternalWhole(manifest, (uri) => noteSource(repo, uri), cancel)
    onProgress?.(total, total)
    return bytes
  }
  const out = new Uint8Array(total)
  for (let at = 0; at < total; at += DOWNLOAD_WINDOW) {
    const end = Math.min(at + DOWNLOAD_WINDOW, total)
    out.set(await fetchPlatformRange(sdk, repo, manifest, at, end), at)
    onProgress?.(end, total)
  }
  noteSource(repo)
  return out
}

/**
 * Order git-pack manifests into the canonical `packRef` space.
 *
 * PACKREF ORDERING (VERIFIED / corrected): the objectLocator's `packRef` is "an index into
 * the manifest's pack list" (forge-core `pack/locator.rs`), but no explicit pack list is
 * stored on-chain — so reader and writer must share a *deterministic* ordering of the kind-0
 * pack manifests. The platform total order is `($createdAt, $id)` (data-contracts §2.3, §4),
 * so packs are sorted **oldest-first by `($createdAt, documentId)`** — NOT by reversing the
 * `$createdAt desc` query result, which drops the `$id` tiebreak on equal timestamps and is
 * wrong past one page. When the owning locator's publish time is known, the list is bounded to
 * packs that existed at/before it (`createdAt <= asOf`): a locator only indexes packs present
 * when it was built, and later incremental packs are outside its `packRef` space.
 */
export function orderGitPacks(
  gitPacks: readonly PackManifest[],
  asOf?: number,
): PackManifest[] {
  const bounded = asOf === undefined ? [...gitPacks] : gitPacks.filter((m) => m.createdAt <= asOf)
  return bounded.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : a.documentId < b.documentId
        ? -1
        : a.documentId > b.documentId
          ? 1
          : 0,
  )
}

/**
 * The pack list a locator's `packRef` indexes — THE normative definition, shared by both
 * clients and by whatever publishes a locator.
 *
 * `packRef` is "an index into the manifest's pack list", but no pack list is stored on-chain,
 * so reader and writer must derive the same one. It is: **the LIVE kind-0 packs as of the
 * locator's `$createdAt`, oldest-first by `($createdAt, $id)`.** Three parts, each
 * load-bearing:
 *
 * * *as of the locator* — a locator only indexes packs that existed when it was built; later
 *   incremental packs are outside its space.
 * * *live* — a repack consolidates several packs into one and marks the originals
 *   `supersedes`. Counting superseded packs would leave every index shifted by however many
 *   of them happened to survive, and whether they survive is incidental: `repack` deletes
 *   only the CALLER's own manifests, so in a multi-author repo some remain. Liveness is
 *   computed within the as-of bound, so a later repack cannot retroactively change what an
 *   older locator meant.
 * * *oldest-first by `($createdAt, $id)`* — the platform total order, not a reversed `desc`
 *   query, which drops the `$id` tiebreak on equal timestamps.
 *
 * This used to differ between the two browse paths: the indexed path counted ALL kind-0
 * packs while the fallback counted live ones, so the two disagreed about which bytes
 * `packRef 0` meant — a valid offset in the wrong pack, undetectable downstream.
 */
export function locatorPackSpace(
  manifests: readonly PackManifest[],
  asOf?: number,
): PackManifest[] {
  const bounded = asOf === undefined ? manifests : manifests.filter((m) => m.createdAt <= asOf)
  return orderGitPacks(liveGitPackManifests(bounded))
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
  asOf?: number,
): PackSource {
  const ordered = locatorPackSpace(manifests, asOf)
  return {
    async fetchRange(packRef: number, start: number, end: number): Promise<Uint8Array> {
      const manifest = ordered[packRef]
      if (!manifest) throw new Error(`packRef ${packRef} out of range (${ordered.length} packs)`)
      return artifactRangeFetch(sdk, repo, manifest)(start, end)
    },
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
  const flatManifest = await readNewestManifestOfKind(sdk, repo, PACK_KIND.FLAT_INDEX)
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
  | { readonly kind: 'ready'; readonly context: BrowseContext }
  | {
      readonly kind: 'unindexed'
      readonly reason: UnindexedReason
      readonly livePacks: PackManifest[]
      readonly totalSizeBytes: number
    }
  | { readonly kind: 'no-packs' }

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
export async function loadBrowseContext(sdk: EvoSDK, repo: RepoRef): Promise<BrowseState> {
  // ONE snapshot, deliberately. `readPackManifests` applies no `kind` filter and is now
  // complete, so every index fragment is already in this list — and reading packs and
  // fragments separately would be actively wrong: a repack committing between the two
  // queries pairs a post-repack index with a pre-repack pack list, and `packRef` then
  // resolves to the wrong pack silently. That is the same misalignment the completeness fix
  // exists to prevent, reintroduced through the back door.
  const manifests = await readRepoPackManifests(sdk, repo)
  const livePacks = locatorPackSpace(manifests)
  if (livePacks.length === 0) return { kind: 'no-packs' }
  const totalSizeBytes = livePacks.reduce((s, m) => s + m.sizeBytes, 0)
  const behind = (reason: UnindexedReason): BrowseState => ({
    kind: 'unindexed',
    reason,
    livePacks,
    totalSizeBytes,
  })

  const fragments = liveLocatorManifests(manifests)
  if (fragments.length === 0) return behind('no-index')

  // Every fragment must index a PREFIX of the current pack space, or the `packRef`s merged
  // from different fragments would mean different packs. Between repacks the live pack list
  // only grows at the end, so this holds; a repack breaks it and supersedes the fragments it
  // consolidated, so the only way to fail is a fragment published concurrently with a
  // repack. Checked from the manifest list alone, before any bytes are fetched.
  for (const f of fragments) {
    const asOf = locatorPackSpace(manifests, f.createdAt)
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
    const parts = await Promise.all(
      ordered.map(async (m) => ObjectLocator.parse(await loadArtifactBytes(sdk, repo, m))),
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
  const reader = new BrowseReader(locator, packs, { onObject: objectObserver(repoKey(repo)) })
  return { kind: 'ready', context: { locator, packs, reader } }
}

// ---------------------------------------------------------------------------
// Browse-context session cache
// ---------------------------------------------------------------------------

/**
 * One browse context per contract for the session (the locator-path analog of the
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
  /** A background refresh is in flight for this entry (see `loadBrowseContextCached`). */
  revalidating?: boolean
}
const browseCache = new Map<string, BrowseCacheEntry>()

function browseEntryLive(entry: BrowseCacheEntry): boolean {
  const ttl =
    entry.settled === undefined || entry.settled.kind === 'ready'
      ? BROWSE_READY_TTL_MS
      : BROWSE_RETRY_TTL_MS
  return Date.now() - entry.at < ttl
}

/** Drop a repo's cached browse context (e.g. on an explicit home reload). */
export function invalidateBrowseContext(key: string): void {
  browseCache.delete(key)
}

/** The cached settled browse state for a contract, if still live — for first-paint seeding. */
export function peekBrowseState(key: string): BrowseState | undefined {
  const entry = browseCache.get(key)
  if (entry === undefined || !browseEntryLive(entry)) return undefined
  return entry.settled
}

/**
 * {@link loadBrowseContext} through the session cache (in-flight loads are joined).
 *
 * Stale-while-revalidate: a hit older than {@link BROWSE_REVALIDATE_MS} is still returned
 * immediately, and a fresh resolve starts behind it so the next read sees any push since.
 */
export function loadBrowseContextCached(sdk: EvoSDK, repo: RepoRef): Promise<BrowseState> {
  const key = repoKey(repo)
  const hit = browseCache.get(key)
  if (hit !== undefined && browseEntryLive(hit)) {
    const stale = hit.settled !== undefined && Date.now() - hit.at >= BROWSE_REVALIDATE_MS
    if (stale && !hit.revalidating) {
      hit.revalidating = true
      const next = loadBrowseContext(sdk, repo)
      next
        .then((state) => {
          // Only replace an entry this refresh still owns — an explicit reload may have
          // dropped it, and a newer resolve must not be clobbered by an older one.
          if (browseCache.get(key) !== hit) return
          browseCache.set(key, { at: Date.now(), promise: next, settled: state })
        })
        .catch(() => {
          // Keep serving the last good state; the TTL will force a fresh resolve.
          hit.revalidating = false
        })
    }
    return hit.promise
  }
  const entry: BrowseCacheEntry = { at: Date.now(), promise: loadBrowseContext(sdk, repo) }
  browseCache.set(key, entry)
  entry.promise
    .then((state) => {
      entry.settled = state
    })
    .catch(() => {
      if (browseCache.get(key) === entry) browseCache.delete(key)
    })
  return entry.promise
}
