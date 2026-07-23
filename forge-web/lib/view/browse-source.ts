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

import { CHUNK_PAYLOAD_MAX, PACK_KIND } from '../constants'
import {
  BrowseReader,
  FlatIndex,
  ObjectLocator,
  type PackSource,
  type RangeFetch,
} from '../browse'
import {
  readPackManifests,
  type PackManifest,
  type RepoRef,
} from '../repo'
import { base64ToBytes, hexToBase64, queryDocumentsWithProof } from '../sdk'
import { DOC } from '../repo'

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
 */
async function fetchPlatformRange(
  sdk: EvoSDK,
  contractId: string,
  packHashHex: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const firstSeq = Math.floor(start / CHUNK_PAYLOAD_MAX)
  const lastSeq = Math.floor((end - 1) / CHUNK_PAYLOAD_MAX)
  const seqs: number[] = []
  for (let s = firstSeq; s <= lastSeq; s++) seqs.push(s)

  const packHashB64 = hexToBase64(packHashHex)
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: contractId,
    documentTypeName: DOC.chunk,
    where: [
      ['packHash', '==', packHashB64],
      ['seq', 'in', seqs],
    ],
    orderBy: [
      ['packHash', 'asc'],
      ['seq', 'asc'],
    ],
    limit: 100,
  })

  const bySeq = new Map<number, Uint8Array>()
  for (const doc of documents) {
    const raw = doc['seq']
    const seq = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : -1
    if (seq >= 0) bySeq.set(seq, chunkPayload(doc))
  }

  const out = new Uint8Array(end - start)
  for (const seq of seqs) {
    const payload = bySeq.get(seq)
    if (!payload) throw new Error(`missing chunk seq ${seq} for pack ${packHashHex.slice(0, 12)}`)
    const chunkStart = seq * CHUNK_PAYLOAD_MAX
    const from = Math.max(start, chunkStart) - chunkStart
    const to = Math.min(end, chunkStart + payload.length) - chunkStart
    if (to > from) out.set(payload.subarray(from, to), chunkStart + from - start)
  }
  return out
}

/** Fetch a contiguous range of an external artifact via HTTP Range. */
async function fetchExternalRange(
  uris: readonly string[],
  start: number,
  end: number,
): Promise<Uint8Array> {
  let lastErr: unknown
  for (const uri of uris) {
    try {
      const resp = await fetch(uri, { headers: { Range: `bytes=${start}-${end - 1}` } })
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`)
      const buf = new Uint8Array(await resp.arrayBuffer())
      // Some hosts ignore Range and return the whole body — slice defensively.
      return buf.length > end - start ? buf.subarray(start, end) : buf
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`no external URI served the range: ${String(lastErr)}`)
}

/** A {@link RangeFetch} over one artifact (platform chunks or external URIs). */
export function artifactRangeFetch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): RangeFetch {
  return (start: number, end: number) =>
    manifest.storage === 0
      ? fetchPlatformRange(sdk, repo.contractId, manifest.packHash, start, end)
      : fetchExternalRange(manifest.uris, start, end)
}

/** Load a whole artifact's bytes (small artifacts: locator ~101 KB, flatIndex). */
export async function loadArtifactBytes(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): Promise<Uint8Array> {
  if (manifest.sizeBytes <= 0) return new Uint8Array(0)
  const fetchRange = artifactRangeFetch(sdk, repo, manifest)
  return fetchRange(0, manifest.sizeBytes)
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
function orderGitPacks(
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
 * A {@link PackSource} over a repo's git-pack manifests (kind 0), indexed by `packRef` = the
 * pack's position in oldest-first `($createdAt, $id)` order (see {@link orderGitPacks}).
 * `asOf` bounds the pack list to those published at/before the owning locator's `$createdAt`.
 */
export function buildPackSource(
  sdk: EvoSDK,
  repo: RepoRef,
  gitPacks: readonly PackManifest[],
  asOf?: number,
): PackSource {
  const ordered = orderGitPacks(gitPacks, asOf)
  return {
    async fetchRange(packRef: number, start: number, end: number): Promise<Uint8Array> {
      const manifest = ordered[packRef]
      if (!manifest) throw new Error(`packRef ${packRef} out of range (${ordered.length} packs)`)
      return artifactRangeFetch(sdk, repo, manifest)(start, end)
    },
  }
}

/** The assembled browse context for a repo, or a reason it is unavailable. */
export interface BrowseContext {
  readonly locator: ObjectLocator
  readonly packs: PackSource
  readonly reader: BrowseReader
}

/**
 * Load the newest flatIndex artifact (full recursive tree listing), or `null` if the repo
 * has not published one. Used by deep tree-browse and filename search — never the cold home.
 */
export async function loadFlatIndex(sdk: EvoSDK, repo: RepoRef): Promise<FlatIndex | null> {
  const manifests = await readPackManifests(sdk, repo, 100)
  const flatManifest = manifests.find((m) => m.kind === PACK_KIND.FLAT_INDEX)
  if (!flatManifest) return null
  const bytes = await loadArtifactBytes(sdk, repo, flatManifest)
  return FlatIndex.parse(bytes)
}

/**
 * Assemble a repo's browse context: newest objectLocator + a pack source over its git packs.
 * Returns `null` when the repo has not published a locator (degrade-gracefully signal).
 */
export async function loadBrowseContext(sdk: EvoSDK, repo: RepoRef): Promise<BrowseContext | null> {
  const manifests = await readPackManifests(sdk, repo, 100)
  const locatorManifest = manifests.find((m) => m.kind === PACK_KIND.OBJECT_LOCATOR)
  if (!locatorManifest) return null
  const gitPacks = manifests.filter((m) => m.kind === PACK_KIND.GIT_PACK)
  const locatorBytes = await loadArtifactBytes(sdk, repo, locatorManifest)
  const locator = ObjectLocator.parse(locatorBytes)
  // Bound the packRef space to packs that existed when this locator was published.
  const packs = buildPackSource(sdk, repo, gitPacks, locatorManifest.createdAt)
  const reader = new BrowseReader(locator, packs)
  return { locator, packs, reader }
}
