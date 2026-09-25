/**
 * packManifest reads — locating browse-plane artifacts (data-contracts §2.3).
 *
 * `packManifest.kind`: 0 = git pack, 1 = objectLocator, 2 = flatIndex. The `(kind,
 * $createdAt desc)` index lets a reader grab the newest locator / flatIndex in one query.
 * The manifest's `uris` (external) or platform `chunk` documents (storage 0) carry the
 * actual bytes the browse reader range-fetches.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'

import { PACK_KIND, type PackKind } from '../constants'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { compareKey } from '../rules'
import { orderPackCopies, type Role } from '../rules/v2'
import { DOC, parseJsonList, type RepoRef } from './contract'
import { base64ToBytes, base64ToHex } from '../sdk'
import { readRoleOracle } from './members'
import { repoSource } from './source'

/** A parsed `packManifest`. */
export interface PackManifest {
  /** SHA-256 of the pack, hex. */
  readonly packHash: string
  /** 0 git pack | 1 objectLocator | 2 flatIndex. */
  readonly kind: PackKind
  readonly sizeBytes: number
  readonly objectCount: number
  readonly chunkCount: number
  /** 0 platform | 1 external. */
  readonly storage: number
  /** External fetch URIs (empty when storage = platform). */
  readonly uris: readonly string[]
  /** For flatIndex (kind 2): the tip commit oids it indexes. */
  readonly tips: readonly string[]
  /** Pack hashes this manifest supersedes. */
  readonly supersedes: readonly string[]
  /** Consensus `$createdAt` (ms) — the primary key for the packRef total order. */
  readonly createdAt: number
  /** Document `$id` (base58) — the `($createdAt, $id)` tiebreak (data-contracts §2.3). */
  readonly documentId: string
  /**
   * The manifest's `$ownerId` — who uploaded this copy. On forge-v2 chunks are keyed by it
   * (`(repoId, $ownerId, packHash, seq)`), so a chunk read must name it.
   */
  readonly uploader: string
  /**
   * forge-v2: every writer's copy of this pack, in the order a reader tries them
   * (`orderPackCopies`: current maintainers, then writers, then everyone else; each by
   * `($createdAt, $id)`), this manifest first. A whole-pack download falls through to the
   * next copy when one does not verify against `packHash` (`forge-v2.md` §4). Absent on v1,
   * where `packHash` is unique.
   */
  readonly copies?: readonly PackManifest[]
}

/**
 * Parse a packed byteArray field (concatenated fixed-width entries, surfaced as base64 —
 * data-contracts §2.3: `tips` = 20-byte oids, `supersedes` = 32-byte pack hashes) into
 * hex strings. Falls back to the legacy JSON-in-string list shape.
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
      /* not base64 — fall through to the legacy JSON-list shape */
    }
  }
  return parseJsonList(doc, field)
}

function toManifest(doc: PlainDocument): PackManifest {
  const num = (f: string): number => (typeof doc[f] === 'number' ? (doc[f] as number) : 0)
  const packHashRaw = doc['packHash']
  let packHash = ''
  if (typeof packHashRaw === 'string') {
    try {
      packHash = base64ToHex(packHashRaw)
    } catch {
      packHash = packHashRaw
    }
  }
  return {
    packHash,
    kind: num('kind') as PackKind,
    sizeBytes: num('sizeBytes'),
    objectCount: num('objectCount'),
    chunkCount: num('chunkCount'),
    storage: num('storage'),
    // v1: JSON-in-string; forge-v2: a typed string array. parseJsonList reads both.
    uris: parseJsonList(doc, 'uris'),
    tips: parsePackedHashes(doc, 'tips', 20),
    supersedes: parsePackedHashes(doc, 'supersedes', 32),
    createdAt: num('$createdAt'),
    documentId: typeof doc['$id'] === 'string' ? (doc['$id'] as string) : '',
    uploader: typeof doc['$ownerId'] === 'string' ? (doc['$ownerId'] as string) : '',
  }
}

/**
 * List **every** pack manifest, newest first.
 *
 * Completeness is load-bearing for a nastier reason than staleness. A locator addresses
 * pack bytes by `packRef` = the pack's index in oldest-first `($createdAt, $id)` order (see
 * {@link orderGitPacks}). Drop the oldest manifests — which is exactly what a capped
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

/**
 * forge-v2: fold every writer's manifest of a pack into one entry per `packHash`
 * (`forge-v2.md` §4 front-running rule). Each pack is represented by its first copy in
 * `orderPackCopies` order (uploader's current role, then `($createdAt, $id)`), carrying all
 * copies in that order for whole-pack fallbacks. `supersedes` is honoured from the
 * representative copy only. Its position in the manifest list (and so in a locator's
 * `packRef` space) is the pack's FIRST upload by `($createdAt, $id)`, which a later copy
 * cannot move.
 *
 * A copy's bytes are not verified here: the browse reader re-hashes every object it reads,
 * and whole-pack reads verify `packHash` and fall through to the next copy.
 */
export function selectPackCopies(
  manifests: readonly PackManifest[],
  roleOf: (identity: string) => Role | null,
): PackManifest[] {
  const byHash = new Map<string, PackManifest[]>()
  for (const m of manifests) {
    const key = m.packHash.toLowerCase()
    const group = byHash.get(key)
    if (group === undefined) byHash.set(key, [m])
    else group.push(m)
  }
  const out: PackManifest[] = []
  for (const group of byHash.values()) {
    const first = [...group].sort((a, b) => compareKey(
      { id: a.documentId, createdAt: a.createdAt },
      { id: b.documentId, createdAt: b.createdAt },
    ))[0] as PackManifest
    const byId = new Map(group.map((m) => [m.documentId, m]))
    const ordered = orderPackCopies(
      group.map((m) => ({
        id: m.documentId,
        packHash: m.packHash,
        ownerRole: roleOf(m.uploader),
        createdAt: m.createdAt,
      })),
    ).map((c) => byId.get(c.id) as PackManifest)
    const best = ordered[0] as PackManifest
    out.push({
      ...best,
      createdAt: first.createdAt,
      documentId: first.documentId,
      copies: ordered,
    })
  }
  // Newest first, like the list it came from.
  return out.sort((a, b) =>
    -compareKey({ id: a.documentId, createdAt: a.createdAt }, { id: b.documentId, createdAt: b.createdAt }),
  )
}

/**
 * Every pack manifest a reader should use, newest first: v1 as stored; forge-v2 with each
 * pack's writer copies folded by {@link selectPackCopies} against the repo's current
 * membership.
 */
export async function readRepoPackManifests(sdk: EvoSDK, repo: RepoRef): Promise<PackManifest[]> {
  if (repo.kind === 'v1') return readPackManifests(sdk, repo)
  const [manifests, oracle] = await Promise.all([
    readPackManifests(sdk, repo),
    readRoleOracle(sdk, repo),
  ])
  return selectPackCopies(manifests, (id) => oracle.currentRole(id))
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

/**
 * The live (non-superseded) kind-0 git packs among `manifests` — mirror of forge-core
 * `repo.rs::live_kind0_manifests`: kind-0 manifests whose `packHash` no manifest (of any
 * kind) lists in its `supersedes`. Single pass, non-transitive.
 */
export function liveGitPackManifests(manifests: readonly PackManifest[]): PackManifest[] {
  const superseded = new Set<string>()
  for (const m of manifests) {
    for (const h of m.supersedes) superseded.add(h.toLowerCase())
  }
  return manifests.filter(
    (m) => m.kind === PACK_KIND.GIT_PACK && !superseded.has(m.packHash.toLowerCase()),
  )
}

/**
 * The live (non-superseded) `objectLocator` manifests among `manifests`, NEWEST-FIRST — the
 * index fragments a reader merges. Mirror of forge-core `repo.rs::live_locator_manifests`.
 *
 * There is normally more than one: a push publishes a locator over just the pack it stored,
 * so the index accumulates fragments between repacks (see forge-core
 * `RepoService::publish_push_locator` for why it is published that way). A repack — or a
 * push that folds them — supersedes the fragments it consolidates.
 */
export function liveLocatorManifests(manifests: readonly PackManifest[]): PackManifest[] {
  const superseded = new Set<string>()
  for (const m of manifests) {
    for (const h of m.supersedes) superseded.add(h.toLowerCase())
  }
  return manifests
    .filter(
      (m) => m.kind === PACK_KIND.OBJECT_LOCATOR && !superseded.has(m.packHash.toLowerCase()),
    )
    .sort((a, b) =>
      a.createdAt !== b.createdAt
        ? b.createdAt - a.createdAt
        : a.documentId < b.documentId
          ? 1
          : a.documentId > b.documentId
            ? -1
            : 0,
    )
}

/** The current flatIndex manifest (kind 2) — the full recursive tree listing. */
export function readNewestFlatIndexManifest(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<PackManifest | null> {
  return readNewestManifestOfKind(sdk, repo, PACK_KIND.FLAT_INDEX)
}
