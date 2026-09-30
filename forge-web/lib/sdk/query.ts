/**
 * evo-sdk query helpers — the browser read path.
 *
 * Wraps `sdk.documents.query` / `queryWithProof` with the two Platform facts that make or
 * break correctness on an active repo (verified in S0.8):
 *
 *  1. **byteArray where-operands must be base64 strings** (NOT Uint8Array, NOT base58 —
 *     base58 is for identifiers only). Every `refNameHash` / `packHash` / oid tip query
 *     encodes its operand with {@link bytesToBase64} / {@link hexToBase64}; results also
 *     come back base64. This is load-bearing — a raw-bytes operand silently returns nothing.
 *  2. **`in`-batches do NOT round-robin** — a single global `limit` is drawn in
 *     orderBy-traversal order, so one hot key starves all siblings (measured 9/9 starved).
 *     So a multi-key read is done per key, in parallel, not as one `in` batch.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// byteArray operand encoding (S0.8 — WASM needs base64)
// ---------------------------------------------------------------------------

/**
 * Encode raw bytes as a standard base64 string — the required wasm byteArray operand form.
 * Built 32 KiB at a time: a string grown one character per byte is slow on a multi-MiB image.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
  return btoa(parts.join(''))
}

/** Decode a base64 string (a query result operand) back to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode a hex string (e.g. a refNameHash / oid) as the base64 operand a wasm query needs. */
export function hexToBase64(hex: string): string {
  return bytesToBase64(hexToBytes(hex))
}

/** Decode a base64 operand/result back to a lowercase hex string. */
export function base64ToHex(b64: string): string {
  return bytesToHex(base64ToBytes(b64))
}

// ---------------------------------------------------------------------------
// Query shape (tuple form, matching the wasm-sdk / yappr convention)
// ---------------------------------------------------------------------------

/** A `where` comparison operator accepted by the document query engine. */
export type WhereOperator =
  | '=='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'startsWith'
  | 'contains'

/** A single `where` clause: `[field, operator, value]`. */
export type WhereClause = readonly [field: string, operator: WhereOperator, value: unknown]

/** A single `orderBy` clause: `[field, direction]`. Stored indexes are asc-only; */
/** `desc` is query-time reverse traversal of an index. */
export type OrderByClause = readonly [field: string, direction: 'asc' | 'desc']

/** A raw document query. `byteArray` operands in `where` must already be base64 (see above). */
export interface DocumentQuery {
  readonly dataContractId: string
  readonly documentTypeName: string
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  readonly limit?: number
  /** A document `$id` (base58) to page after. */
  readonly startAfter?: string
  readonly startAt?: string
}

/** A normalized document: system fields ($id/$ownerId base58, $createdAt number) + content. */
export type PlainDocument = Record<string, unknown>

// The SDK exposes two document serializers with DIFFERENT field encodings:
//   - `toObject()` → identifiers as raw `Uint8Array`, integers as `bigint`, byteArrays as
//     `Uint8Array`.
//   - `toJSON(platformVersion)` → identifiers as base58 strings, integers as JS numbers,
//     byteArrays as base64 strings.
// The whole forge-web read layer is written against the `toJSON` shape (`str()` expects base58,
// `num()` expects number, `byteFieldToHex`/skip-scan expect base64) — so normalization uses
// `toJSON`. A `platformVersion` is required; the service pins it from `sdk.version()` on connect
// (the value only selects DPP's serialization rules, which are stable for our field types).
let platformVersion = 1

/** The protocol version from which a `startAfter` page never skips rows tied with its cursor. */
const CURSOR_PADDED_FROM = 14

/**
 * Whether the network pages tie-safely by itself (protocol {@link CURSOR_PADDED_FROM}+), as far
 * as the SDK has seen: the version is learned from the first proved reply, which every paged
 * read has had by the time it needs its second page.
 *
 * Drive pads a cursor page only off the primary key and for types that are not `indexOnly`
 * (`pads_cursor_page`). Every tie-probed read here orders by `$createdAt` (never the primary key),
 * and none of the `indexOnly` forge types (`star`, `starBeat`, `follow`, `watch`) has an index
 * ending in `$createdAt`, the only shape {@link tieProbeAllowed} admits: the version alone decides.
 */
export function cursorPadded(): boolean {
  return platformVersion >= CURSOR_PADDED_FROM
}

/** Pin the DPP platform version used by {@link normalizeDocument}'s `toJSON`. */
export function setPlatformVersion(version: number): void {
  if (Number.isInteger(version) && version > 0) platformVersion = version
}

/**
 * Follow the version the SDK learned from its latest proved response. The service seeds its
 * contracts without a request, so the first page query, not the connect, is where evo-sdk
 * learns the network's version.
 */
export function followSdkVersion(sdk: EvoSDK): void {
  try {
    setPlatformVersion(sdk.version())
  } catch {
    // Keep the pinned version if the SDK cannot report one.
  }
}

interface DocumentLike {
  toJSON?: (platformVersion: number) => unknown
  toObject?: () => unknown
}

/** Normalize a wasm Document (or already-plain object) to a JSON-friendly record. */
export function normalizeDocument(doc: unknown): PlainDocument {
  const d = doc as DocumentLike
  let raw: unknown = doc
  if (typeof d.toJSON === 'function') raw = d.toJSON(platformVersion)
  else if (typeof d.toObject === 'function') raw = d.toObject()
  if (raw === null || typeof raw !== 'object') return {}
  return raw as PlainDocument
}

function mapToDocuments(response: Map<string, unknown> | unknown): PlainDocument[] {
  const out: PlainDocument[] = []
  if (response instanceof Map) {
    for (const v of response.values()) {
      if (v != null) out.push(normalizeDocument(v))
    }
  }
  return out
}

// The evo-sdk document facade param/return types resolve loosely (wasm-bindgen d.ts); we
// narrow through these local shapes rather than leaking `any` into call sites.
interface DocumentsFacadeLike {
  query: (q: DocumentQuery) => Promise<Map<string, unknown>>
  count: (q: DocumentQuery) => Promise<Map<string, bigint>>
  sum: (q: DocumentQuery, sumProperty: string) => Promise<Map<string, bigint>>
  ranked: (q: unknown) => Promise<{
    startingRank: bigint
    entries: ReadonlyArray<{ groupKeyHex: string; groupValue: unknown; value: bigint; rank: bigint }>
  }>
}
interface SdkLike {
  documents: DocumentsFacadeLike
}

function documentsOf(sdk: EvoSDK): DocumentsFacadeLike {
  return (sdk as unknown as SdkLike).documents
}

/** A proof-carrying read result: the documents plus whatever proof metadata the SDK returned. */
export interface ProofedDocuments {
  readonly documents: PlainDocument[]
  readonly proofMetadata: unknown
}

/**
 * Called when a read names a document type its contract does not have: a seeded contract may
 * be older than the network's. Resolves true when the contract was refreshed and the read may
 * be retried once. Set by the SDK service.
 */
type StaleContractHandler = (contractId: string) => Promise<boolean>
let staleContractHandler: StaleContractHandler | null = null

/** Install (or clear) the handler for reads against a possibly stale seeded contract. */
export function setStaleContractHandler(handler: StaleContractHandler | null): void {
  staleContractHandler = handler
}

function isUnknownDocumentType(e: unknown): boolean {
  let message = ''
  try {
    message = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
  } catch {
    return false
  }
  return /document type not found/i.test(message)
}

/**
 * Identical reads in flight, per SDK: a second caller of the same query joins the first
 * request instead of sending its own (two components of one page asking for the same owner's
 * name, two folds reading the same feed page at once). Only while the request is out, and only
 * among reads issued since this tab's last write ({@link noteSdkWrite}): a settled answer is
 * never served from here, and a read issued after a write never joins one issued before it.
 */
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>()

/** The key identical reads share, or null when the query cannot be keyed (never deduped then). */
function inFlightKey(kind: string, query: unknown): string | null {
  try {
    return `${kind}:${JSON.stringify(query)}`
  } catch {
    return null
  }
}

/** `read()`, or the read under `key` already in flight in `map` (dropped from it once it settles). */
export function shareInFlight<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const held = map.get(key)
  if (held !== undefined) return held
  const promise = read()
  map.set(key, promise)
  const done = (): void => {
    if (map.get(key) === promise) map.delete(key)
  }
  promise.then(done, done)
  return promise
}

/** Writes this tab made through each SDK: part of every dedupe key, so no read joins across one. */
const writeEpoch = new WeakMap<object, number>()

/** This tab's write through `sdk` settled: reads from now on do not join earlier ones. */
export function noteSdkWrite(sdk: EvoSDK): void {
  writeEpoch.set(sdk, (writeEpoch.get(sdk) ?? 0) + 1)
}

/** Run `read`, or join an identical one already in flight on `sdk`. */
function joinInFlight<T>(sdk: EvoSDK, kind: string, query: unknown, read: () => Promise<T>): Promise<T> {
  const key = inFlightKey(`${kind}@${writeEpoch.get(sdk) ?? 0}`, query)
  if (key === null) return read()
  const bySdk = inFlight.get(sdk) ?? new Map<string, Promise<unknown>>()
  inFlight.set(sdk, bySdk)
  return shareInFlight(bySdk, key, read) as Promise<T>
}

/** Raw query (no proof). Prefer {@link queryDocumentsWithProof} for trust-minimized reads. */
export async function queryDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<PlainDocument[]> {
  // Every caller gets its own array (the documents themselves are shared, read-only records).
  return [...(await joinInFlight(sdk, 'documents', query, () => readDocuments(sdk, query)))]
}

async function readDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<PlainDocument[]> {
  let response: Map<string, unknown>
  try {
    response = await documentsOf(sdk).query(query)
  } catch (e) {
    if (!isUnknownDocumentType(e) || !(await staleContractHandler?.(query.dataContractId))) throw e
    response = await documentsOf(sdk).query(query)
  }
  followSdkVersion(sdk)
  return mapToDocuments(response)
}

/**
 * Proof-verified query — the default forge-web read path.
 *
 * BROWSER-BUG FIX (found by the Playwright suite, invisible to node/jsdom): the explicit
 * `documents.queryWithProof(...)` facade in evo-sdk 4.0.0 **rejects in a real browser with a
 * wasm-bindgen object** (carries `__wbg_ptr`, not a JS `Error`), breaking every live read.
 * Per S0.3 the connection is `testnetTrusted()`/`mainnetTrusted()`, and a **trusted** connect
 * prefetches the quorum keys and **proof-verifies every plain `.query()` internally** — so the
 * explicit `*WithProof` variant is both redundant and buggy in-browser. This delegates to the
 * plain `.query()` (still trust-minimized, proofs on), which returns cleanly in the browser.
 * The `proofMetadata` field is retained for API compatibility (it was never consumed).
 */
export async function queryDocumentsWithProof(
  sdk: EvoSDK,
  query: DocumentQuery,
): Promise<ProofedDocuments> {
  return { documents: await queryDocuments(sdk, query), proofMetadata: null }
}

/**
 * Provable O(1) count over a countable index (`forge-v2.md` §2). Sums the grouped result
 * the SDK returns for `documents.count`. Use for star / follower / issue-total surfaces.
 * Point shapes only ({@link ungroupedRangeProblem}): a range count goes through
 * {@link countDocumentsGrouped} in its carrier form.
 */
export function countDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<number> {
  const problem = ungroupedRangeProblem(query)
  if (problem !== null) return Promise.reject(new Error(problem))
  return joinInFlight(sdk, 'count', query, () => readCount(sdk, query))
}

/** The operators that make a `where` a range (the aggregate walks a subtree, not a point). */
export const RANGE_OPERATORS: ReadonlySet<WhereOperator> = new Set(['>', '>=', '<', '<=', 'startsWith'])

/**
 * Why an aggregate (count or sum) of `query` without `groupBy` cannot be proved, or null. An
 * ungrouped range aggregate over a path that holds no document fails proof verification instead
 * of answering 0 (grovedb `verify_v1_leaf_chain`; measured on bonsia, #176
 * `rc1-empty-aggregates.mjs`): a new repo, or mainnet on day one, would show an error. Its carrier
 * form answers an empty map there: the leading `==` as `in [value]` plus the range, grouped by
 * that property (or grouped by the ranged property itself).
 */
export function ungroupedRangeProblem(query: DocumentQuery & { readonly groupBy?: readonly string[] }): string | null {
  if ((query.groupBy?.length ?? 0) > 0) return null
  const range = (query.where ?? []).find(([, op]) => RANGE_OPERATORS.has(op))
  return range === undefined
    ? null
    : `an ungrouped aggregate over a range (${range[0]} ${range[1]}) cannot be proved where nothing matches; group it (the \`in [x]\` carrier plus groupBy)`
}

async function readCount(sdk: EvoSDK, query: DocumentQuery): Promise<number> {
  const grouped = await documentsOf(sdk).count(query)
  let total = 0n
  if (grouped instanceof Map) {
    for (const v of grouped.values()) total += v
  }
  const n = Number(total)
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER
}

/** A read grouped by one property: `groupBy` on the query, one entry per group. */
export type GroupedQuery = DocumentQuery & { readonly groupBy: readonly string[] }

/**
 * Per-group proved counts (`documents.count` with `in` + `groupBy`): the SDK keys each entry by
 * the group value's tree-key encoding, hex. An absent group has no entry (read it as 0).
 */
export function countDocumentsGrouped(sdk: EvoSDK, query: GroupedQuery): Promise<Map<string, number>> {
  const problem = ungroupedRangeProblem(query)
  if (problem !== null) return Promise.reject(new Error(problem))
  return joinInFlight(sdk, 'countGrouped', query, async () => bigintMap(await documentsOf(sdk).count(query as DocumentQuery)))
}

/**
 * Per-group proved sums of `property` (`documents.sum`, a `summable` index; `in` + `groupBy`),
 * keyed like {@link countDocumentsGrouped}. An absent group has no entry (its sum is 0).
 */
export function sumDocumentsGrouped(sdk: EvoSDK, query: GroupedQuery, property: string): Promise<Map<string, number>> {
  const problem = ungroupedRangeProblem(query)
  if (problem !== null) return Promise.reject(new Error(problem))
  return joinInFlight(sdk, `sum:${property}`, query, async () => bigintMap(await documentsOf(sdk).sum(query as DocumentQuery, property)))
}

function bigintMap(m: Map<string, bigint> | unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (m instanceof Map) for (const [k, v] of m) out.set(String(k), Number(v))
  return out
}

/**
 * The unsigned integer a group key encodes (`encode_u8` … `encode_u64`: big-endian, top bit
 * flipped), whatever its width; null for a key that is not 1–8 bytes of hex.
 */
export function uintOfGroupKey(key: string): number | null {
  if (!/^(?:[0-9a-f]{2}){1,8}$/i.test(key)) return null
  let n = 0
  for (let i = 0; i < key.length; i += 2) {
    const b = Number.parseInt(key.slice(i, i + 2), 16) ^ (i === 0 ? 0x80 : 0)
    n = n * 256 + b
  }
  return Number.isSafeInteger(n) ? n : null
}

/** The tree-key encoding of an unsigned integer group value (`encode_u8` etc.): big-endian, top bit flipped. */
export function uintGroupKey(value: number, bytes: 1 | 2 | 4 = 1): string {
  const b = new Uint8Array(bytes)
  for (let i = bytes - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) b[i] = v & 0xff
  b[0] = (b[0] as number) ^ 0x80
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** A ranked (top-K) read: `documents.ranked` over a `rankedCountable` index (protocol 14). */
export interface RankedQuery {
  readonly dataContractId: string
  readonly documentTypeName: string
  /** The index's last property: the groups ranked. */
  readonly groupBy: string
  /** 1..100 (a hard ceiling the proof re-checks). */
  readonly limit: number
  /** A bucketed index's window: `oldest` (a near-full trailing range) or `newest`. */
  readonly timeRange?: { readonly field: string; readonly selector: 'newest' | 'oldest' }
}

/** One ranked group: its key (the group value's index encoding, hex), its value and count. */
export interface RankedEntry {
  /** The group's value as the query returns it (a base58 identifier for an id group). */
  readonly group: string
  /** The group key's raw index bytes, hex (a 32-byte id for an identifier group). */
  readonly keyHex: string
  readonly count: number
  /** 0-based rank. */
  readonly rank: number
}

export interface RankedPage {
  readonly entries: readonly RankedEntry[]
}

/**
 * The top groups of a ranked count index, highest first, proved (the verifier re-derives the
 * window of a `timeRange` selection from the quorum-signed time). Equal counts come back by
 * group key descending.
 */
export async function rankedDocuments(sdk: EvoSDK, query: RankedQuery): Promise<RankedPage> {
  const res = await documentsOf(sdk).ranked({
    dataContractId: query.dataContractId,
    documentTypeName: query.documentTypeName,
    groupBy: query.groupBy,
    aggregate: { type: 'count' },
    limit: query.limit,
    direction: 'desc',
    ...(query.timeRange ? { timeRange: [{ field: query.timeRange.field, selector: query.timeRange.selector }] } : {}),
  })
  return {
    entries: res.entries.map((e) => ({
      group: String(e.groupValue ?? ''),
      keyHex: e.groupKeyHex,
      count: Number(e.value),
      rank: Number(e.rank),
    })),
  }
}

/**
 * The all-ascending `orderBy` whose traversal, reversed, is exactly `query`'s — or null when
 * the order is already ascending or has no such equivalent. Parity: forge-core
 * `platform::ascending_equivalent`.
 *
 * A complete read pages with a `startAfter` cursor. The grovedb verifier in evo-sdk 4.2 checks
 * that every proof op matches the walk direction. Protocol-13 nodes answered a
 * descending page after a cursor with a proof that fails that check. It surfaced as
 * `packManifest` reads failing once a repo passed 100 manifests. Ascending pages verify, and
 * Drive's descending walk is the exact reverse of its ascending walk. Reversing also
 * reverses any clause that was already ascending, which is only harmless when an `==` filter
 * pins that clause's field, so any other mixed order is left as requested.
 */
export function ascendingEquivalent(query: DocumentQuery): OrderByClause[] | null {
  const orderBy = query.orderBy ?? []
  if (orderBy.every(([, direction]) => direction === 'asc')) return null
  const pinned = (field: string): boolean =>
    (query.where ?? []).some(([f, op]) => f === field && op === '==')
  if (orderBy.some(([field, direction]) => direction === 'asc' && !pinned(field))) return null
  return orderBy.map(([field]) => [field, 'asc'] as const)
}

/** Thrown when a read that must be complete could not be proven complete. */
export class IncompleteReadError extends Error {
  constructor(
    readonly documentTypeName: string,
    readonly fetched: number,
    reason: string,
  ) {
    super(`incomplete read of ${documentTypeName} after ${fetched} documents: ${reason}`)
    this.name = 'IncompleteReadError'
  }
}

/**
 * Page a query to exhaustion (the `query_all` pattern — parity with forge-core
 * `platform::query_all_documents`). Repeats the proof-verified query, advancing `startAfter`
 * past the last `$id` of each page, until a **short page** proves the end was reached. Used by
 * every read that MUST be complete: the deterministic folds (`resolve_ref`, the label and
 * review folds over `event`) are folds over a whole history, so a silently truncated input does not
 * degrade the answer — it produces a confidently wrong one (a closed issue that reads open,
 * a branch pinned at its 100th push).
 *
 * **A short page is the only accepted proof of completeness.** If the cursor cannot advance
 * (a row without a string `$id`) or the `maxPages` safety cap is hit, this THROWS
 * {@link IncompleteReadError} rather than returning what it has: a caller folding a partial
 * history cannot tell the difference between "no more events" and "I stopped early", and the
 * whole point of the rules layer is that every client resolves identically. Callers that
 * genuinely want a bounded window should use {@link queryDocumentsWithProof} with a `limit`
 * and present it as a window.
 *
 * `pageLimit` bounds each round-trip; `maxPages` is a hard safety cap on total rounds.
 */
/**
 * Whether a complete read can make its page boundaries tie-safe. Parity: forge-core
 * `platform::tie_probe_allowed`. The conditions: the order ends in `$createdAt` ascending,
 * every earlier order field is pinned by an `==` filter, and every filter is an `==` on some
 * other field. The index then ends in `$createdAt`, so an equality on the boundary timestamp
 * is a valid query on the same index.
 *
 * Why: on protocol 13, a `startAfter` cursor excludes the cursor's whole `$createdAt` key.
 * Documents created in the same block as a page's last row that sort after it would be
 * silently skipped. Protocol 14 bounds the cursor by document id and does not drop them.
 *
 * It needs the boundary row's `$createdAt`, which every forge-v2 history type requires.
 *
 * Only below protocol 14 ({@link CURSOR_PADDED_FROM}): there Drive lowers a `startAfter` as a
 * `startAt` on the cursor's own index key, continues within it by document id and strips the
 * cursor row (`rs-drive` `DriveDocumentQuery::pads_cursor_page`, gated on
 * `non_primary_key_path_query >= 1`, first set in protocol 14; proved the same way, and
 * covered by `compound_cursor_tests.rs`). The probe would be one more request per full page for
 * rows the next page returns anyway.
 */
export function tieProbeAllowed(query: DocumentQuery): boolean {
  const orderBy = query.orderBy ?? []
  const last = orderBy[orderBy.length - 1]
  if (last === undefined || last[0] !== '$createdAt' || last[1] !== 'asc') return false
  const where = query.where ?? []
  const pinned = (field: string): boolean => where.some(([f, op]) => f === field && op === '==')
  return (
    orderBy.slice(0, -1).every(([field, direction]) => direction === 'asc' && pinned(field)) &&
    where.every(([field, op]) => op === '==' && field !== '$createdAt')
  )
}

export async function queryAllDocuments(
  sdk: EvoSDK,
  query: DocumentQuery,
  opts: {
    readonly pageLimit?: number
    readonly maxPages?: number
    /**
     * The query's first page, already read elsewhere (a composite's sibling sub-query with
     * the same query and a `pageLimit` limit): a short one is the whole answer, a full one is
     * continued from its last row instead of being read again. Ascending queries only.
     */
    readonly firstPage?: readonly PlainDocument[]
  } = {},
): Promise<PlainDocument[]> {
  const pageLimit = opts.pageLimit ?? 100
  const maxPages = opts.maxPages ?? 1000
  // Page a descending read ascending and reverse it — see `ascendingEquivalent`.
  const ascending = ascendingEquivalent(query)
  if (opts.firstPage !== undefined && ascending !== null) throw new Error('firstPage continues an ascending query only')
  const paged = ascending === null ? query : { ...query, orderBy: ascending }
  const tieShape = tieProbeAllowed(paged)
  const out: PlainDocument[] = []
  const held = new Set<string>()
  const take = (rows: PlainDocument[]): void => {
    for (const d of rows) {
      const id = d['$id']
      if (typeof id === 'string') {
        if (held.has(id)) continue
        held.add(id)
      }
      out.push(d)
    }
  }
  const done = (): PlainDocument[] => (ascending === null ? out : out.reverse())
  let startAfter: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const documents =
      page === 0 && opts.firstPage !== undefined
        ? [...opts.firstPage]
        : (await queryDocumentsWithProof(sdk, { ...paged, limit: pageLimit, startAfter })).documents
    take(documents)
    if (documents.length < pageLimit) return done()
    const last = documents[documents.length - 1]
    const lastId = last?.['$id']
    if (typeof lastId !== 'string') {
      throw new IncompleteReadError(
        query.documentTypeName,
        out.length,
        'a full page ended on a document with no $id, so the cursor cannot advance',
      )
    }
    let cursor: string = lastId
    // Same-block rows past the boundary: read the boundary timestamp in full (see
    // `tieProbeAllowed`), then continue after the last of them.
    const createdAt = last?.['$createdAt']
    // Checked per boundary: the version is known once the first proved page has come back.
    if (tieShape && !cursorPadded() && typeof createdAt === 'number') {
      const { documents: tied } = await queryDocumentsWithProof(sdk, {
        ...paged,
        where: [...(paged.where ?? []), ['$createdAt', '==', createdAt]],
        limit: pageLimit,
      })
      if (tied.length >= pageLimit) {
        throw new IncompleteReadError(
          query.documentTypeName,
          out.length,
          `${pageLimit} or more documents share $createdAt ${createdAt}; the page boundary tie cannot be read completely`,
        )
      }
      const lastTied = tied[tied.length - 1]?.['$id']
      if (typeof lastTied === 'string') cursor = lastTied
      take(tied)
    }
    startAfter = cursor
  }
  throw new IncompleteReadError(
    query.documentTypeName,
    out.length,
    `the ${maxPages}-page safety cap was reached before a short page proved the end`,
  )
}
