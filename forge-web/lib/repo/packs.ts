/**
 * packManifest reads — locating browse-plane artifacts (`forge-v2.md` §4).
 *
 * `packManifest.kind`: 0 = git pack, 1 = objectLocator, 2 = flatIndex, 3 = history index,
 * 4 = release assets (`PACK_KIND`). Every reader selects its kind ({@link packsOfKind}), so a
 * kind it does not know (an asset manifest's JSON) is never read as a pack. The `(kind,
 * $createdAt desc)` index lets a reader grab the newest locator / flatIndex in one query.
 * The manifest's `uris` (external) or platform `chunk` documents (storage 0) carry the
 * actual bytes the browse reader range-fetches.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'

import { DEFAULT_NETWORK, PACK_KIND, STORAGE, type Network, type PackKind } from '../constants'
import { repoTimelines } from './chrome'
import { queryAllDocuments, queryDocumentsWithProof, sumDocumentsGrouped, uintOfGroupKey, type PlainDocument } from '../sdk'
import { v2PackList, type Role } from '../rules/v2'
import { DOC, str, stringArray, type RepoRef } from './contract'
import { base64ToBytes } from '../sdk'
import { readRoleOracle } from './members'
import { packHashHex, packHashOperand } from './pack-hash'
import { blockHeightOf } from './private-content'
import { repoSource } from './source'

/** A parsed `packManifest`. */
export interface PackManifest {
  /** SHA-256 of the pack, lowercase hex (an identifier on chain: see `pack-hash.ts`). */
  readonly packHash: string
  /** 0 git pack | 1 objectLocator | 2 flatIndex | 3 history index | 4 release assets. */
  readonly kind: PackKind
  readonly sizeBytes: number
  readonly objectCount: number
  readonly chunkCount: number
  /** 0 platform | 1 external. */
  readonly storage: number
  /** External fetch URIs (empty when storage = platform). */
  readonly uris: readonly string[]
  /** For flatIndex (kind 2): the tip it indexes; for a history index (kind 3), `[tip]` or `[tip, baseTip]`. */
  readonly tips: readonly string[]
  /** Pack hashes this manifest supersedes. */
  readonly supersedes: readonly string[]
  /** Consensus `$createdAt` (ms) — the primary key for the packRef total order. */
  readonly createdAt: number
  /** Document `$id` (base58) — the `($createdAt, $id)` tiebreak. */
  readonly documentId: string
  /** `$createdAtBlockHeight` (the late-content rule of a private repo reads it). */
  readonly createdAtBlockHeight?: number
  /**
   * The manifest's `$ownerId` — who uploaded this copy. Chunks are keyed by it
   * (`(repoId, $ownerId, packHash, seq)`), so a chunk read must name it.
   */
  readonly uploader: string
  /**
   * Every writer's copy of this pack, in the order a reader tries them (`orderPackCopies`:
   * current maintainers, then writers, then everyone else; each by `($createdAt, $id)`), this
   * manifest first. A read falls through to the next copy when one cannot be read or does not
   * verify (`forge-v2.md` §4). Absent on a raw manifest row.
   */
  readonly copies?: readonly PackManifest[]
  /** Raw copies: the uploader's current role (null: not a member). */
  readonly ownerRole?: Role | null
}

/**
 * Parse a packed byteArray field (concatenated fixed-width entries, surfaced as base64:
 * `tips` = 20-byte oids, `supersedes` = 32-byte pack hashes) into hex strings; `[]` when
 * absent or malformed.
 */
function parsePackedHashes(doc: PlainDocument, field: string, entryLen: number): string[] {
  const v = doc[field]
  if (typeof v === 'string' && v.length > 0) {
    try {
      const bytes = base64ToBytes(v)
      if (bytes.length > 0 && bytes.length % entryLen === 0) {
        const out: string[] = []
        for (let i = 0; i < bytes.length; i += entryLen) {
          out.push(bytesToHex(bytes.subarray(i, i + entryLen)))
        }
        return out
      }
    } catch {
      /* not base64 */
    }
  }
  return []
}

function toManifest(doc: PlainDocument): PackManifest {
  const height = blockHeightOf(doc)
  const num = (f: string): number => (typeof doc[f] === 'number' ? (doc[f] as number) : 0)
  return {
    packHash: packHashHex(doc['packHash']),
    kind: num('kind') as PackKind,
    sizeBytes: num('sizeBytes'),
    objectCount: num('objectCount'),
    chunkCount: num('chunkCount'),
    storage: num('storage'),
    uris: stringArray(doc, 'uris') ?? [],
    tips: parsePackedHashes(doc, 'tips', 20),
    supersedes: parsePackedHashes(doc, 'supersedes', 32),
    createdAt: num('$createdAt'),
    documentId: str(doc, '$id'),
    uploader: str(doc, '$ownerId'),
    ...(height !== undefined ? { createdAtBlockHeight: height } : {}),
  }
}

/**
 * List **every** pack manifest, newest first.
 *
 * Completeness is load-bearing for a nastier reason than staleness. A locator addresses
 * pack bytes by `packRef` = the pack's index in first-upload `($createdAt, $id)` order (see
 * {@link packsOfKind}). Drop the oldest manifests — which is exactly what a capped
 * newest-first page does once a repo passes one page — and every `packRef` shifts: lookups
 * then read a valid offset in the WRONG pack and return corrupt objects, with nothing in the
 * reader able to detect the misalignment. The fallback-clone path degrades the same way,
 * cloning an incomplete object set because a still-live base pack fell out of the window.
 *
 * Callers needing the current locator / flatIndex should use
 * {@link readNewestManifestOfKind}, whose `(kind, $createdAt desc) limit 1` index lookup does
 * not depend on manifest volume at all. Parity: forge-core `read_pack_manifests`.
 */
export async function readPackManifests(sdk: EvoSDK, repo: RepoRef): Promise<PackManifest[]> {
  const documents = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.packManifest, { orderBy: [['$createdAt', 'desc']] }),
  )
  return documents.map(toManifest)
}

/** Bytes of git packs stored for a repo, by where they live ({@link readGitPackBytes}). */
export interface GitPackBytes {
  /** `storage` 0: in `chunk` documents on Platform. */
  readonly platform: number
  /** `storage` 1: at the manifests' external URIs. */
  readonly external: number
}

/**
 * The stored size of a repo's git packs (kind 0), on Platform and external: the closest to
 * GitHub's repo size, which also counts the git objects rather than the checkout. One proved
 * grouped sum of `sizeBytes` on `packManifest.bytes` (`(repoId, storage, kind)`, `summable`; RC1
 * O-05), which covers only a query binding all three: `storage in [0, 1]` grouped by `storage`,
 * `kind == 0`. It counts every manifest: a pack a later push superseded, and each member's copy.
 */
export async function readGitPackBytes(sdk: EvoSDK, repo: RepoRef): Promise<GitPackBytes> {
  const sums = await sumDocumentsGrouped(
    sdk,
    {
      ...repoSource(repo).repoQuery(DOC.packManifest, {
        where: [['storage', 'in', [STORAGE.PLATFORM, STORAGE.EXTERNAL]], ['kind', '==', PACK_KIND.GIT_PACK]],
        orderBy: [['storage', 'asc']],
      }),
      groupBy: ['storage'],
    },
    'sizeBytes',
  )
  // Keys decoded whatever the integer's width (`uintOfGroupKey`), as the kind counts are.
  const out = { platform: 0, external: 0 }
  for (const [key, bytes] of sums) {
    const storage = uintOfGroupKey(key)
    if (storage === STORAGE.PLATFORM) out.platform += bytes
    else if (storage === STORAGE.EXTERNAL) out.external += bytes
  }
  return out
}

/** A `(createdAt, id)` bound; a bare `$createdAt` includes every document of that time. */
export type AsOf = number | { readonly createdAt: number; readonly id: string }

/**
 * The pack list of one `kind` (`v2PackList`, `forge-v2.md` §4) over raw manifest
 * copies that carry their uploader's role ({@link readRepoPackManifests}), in `packRef`
 * order. Each entry is the representative copy's manifest, positioned at the pack's first
 * upload (`createdAt` / `documentId` are the first upload's), with every usable copy in the
 * order a reader tries them. Superseded packs stay in the list, in place: a hash proves a
 * pack's bytes, not that it holds everything it claims to replace.
 */
export function packsOfKind(
  copies: readonly PackManifest[],
  kind: number,
  asOf?: AsOf,
): (PackManifest & { readonly superseded: boolean })[] {
  const byId = new Map(copies.map((m) => [m.documentId, m]))
  const bound = asOf === undefined ? null : typeof asOf === 'number' ? { createdAt: asOf, id: '\uffff' } : asOf
  const listed = v2PackList(
    copies.map((m) => ({
      id: m.documentId,
      packHash: m.packHash.toLowerCase(),
      kind: m.kind,
      createdAt: m.createdAt,
      ownerRole: m.ownerRole ?? null,
      sizeBytes: m.sizeBytes,
      objectCount: m.objectCount,
      chunkCount: m.chunkCount,
      supersedes: m.supersedes.map((h) => h.toLowerCase()),
      verified: null,
    })),
    bound,
  )
  return listed
    .filter((p) => p.kind === kind)
    .map((p) => {
      const ranked = p.copies.map((id) => byId.get(id) as PackManifest)
      const rep = ranked[0] as PackManifest
      return {
        ...rep,
        createdAt: p.first.createdAt,
        documentId: p.first.id,
        copies: ranked,
        superseded: p.superseded,
      }
    })
}

/**
 * Every pack manifest of a repo, newest first, as raw copies — each tagged with its
 * uploader's current role so {@link packsOfKind} can rank them.
 */
export async function readRepoPackManifests(sdk: EvoSDK, repo: RepoRef): Promise<PackManifest[]> {
  const [manifests, oracle] = await Promise.all([
    readPackManifests(sdk, repo),
    readRoleOracle(sdk, repo),
  ])
  return manifests.map((m) => ({ ...m, ownerRole: oracle.currentRole(m.uploader) }))
}

/**
 * {@link readRepoPackManifests} for a browse context: a public repo's manifests come from the
 * repo chrome store ({@link repoTimelines}: the home's own read when it is a few seconds old, else
 * one request for what is new), and the membership from the cache that read seeded. `after`: a
 * re-resolve of a pack list read by then (after a miss or a push): only a read issued after it
 * answers (the home's revalidation of a moment ago, else a new one), never the read it checks.
 */
export async function readBrowseManifests(
  sdk: EvoSDK,
  repo: RepoRef,
  { after, network = DEFAULT_NETWORK }: { readonly after?: number; readonly network?: Network } = {},
): Promise<PackManifest[]> {
  const timelines = await repoTimelines(sdk, repo, { network, ...(after === undefined ? {} : { issuedAfter: after }) })
  if (timelines === null) return readRepoPackManifests(sdk, repo)
  const oracle = await readRoleOracle(sdk, repo, network)
  // Newest first, as `readPackManifests` answers (the store holds them oldest first).
  return [...timelines.packManifest].reverse().map((d) => {
    const m = toManifest(d)
    return { ...m, ownerRole: oracle.currentRole(m.uploader) }
  })
}

/**
 * Every writer's copy of `packHash` (`(repoId, packHash)` index), ranked for
 * reading, as one manifest with `copies` — or null when no copy claims `kind`. Independent of
 * how many other packs the repo holds.
 */
export async function readPackCopies(
  sdk: EvoSDK,
  repo: RepoRef,
  hashHex: string,
  kind: number,
  /**
   * Drop copies of any other kind before ranking (a sealed release's asset list, which only
   * TLV 21 names: a co-writer's other-kind copy of the same hash must not outrank and hide it).
   */
  onlyKind = false,
): Promise<PackManifest | null> {
  const [documents, oracle] = await Promise.all([
    queryAllDocuments(
      sdk,
      repoSource(repo).repoQuery(DOC.packManifest, {
        where: [['packHash', '==', packHashOperand(hashHex)]],
      }),
    ),
    readRoleOracle(sdk, repo),
  ])
  const copies = documents
    .map(toManifest)
    .filter((m) => !onlyKind || m.kind === kind)
    .map((m) => ({ ...m, ownerRole: oracle.currentRole(m.uploader) }))
  return packsOfKind(copies, kind)[0] ?? null
}

/** The newest manifest of a given kind (the current locator / flatIndex), or null. */
export async function readNewestManifestOfKind(
  sdk: EvoSDK,
  repo: RepoRef,
  kind: PackKind,
): Promise<PackManifest | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(DOC.packManifest, {
      where: [['kind', '==', kind]],
      orderBy: [
        ['kind', 'asc'],
        ['$createdAt', 'desc'],
      ],
      limit: 1,
    }),
  )
  const doc = documents[0]
  return doc === undefined ? null : toManifest(doc)
}

/** The current objectLocator manifest (kind 1) — the size-independent object index. */
export function readNewestLocatorManifest(sdk: EvoSDK, repo: RepoRef): Promise<PackManifest | null> {
  return readNewestManifestOfKind(sdk, repo, PACK_KIND.OBJECT_LOCATOR)
}

/** The current flatIndex manifest (kind 2) — the full recursive tree listing. */
export function readNewestFlatIndexManifest(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<PackManifest | null> {
  return readNewestManifestOfKind(sdk, repo, PACK_KIND.FLAT_INDEX)
}
