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
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { DOC, parseJsonList, type RepoRef } from './contract'
import { base64ToBytes, base64ToHex } from '../sdk'

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
    uris: parseJsonList(doc, 'uris'),
    tips: parsePackedHashes(doc, 'tips', 20),
    supersedes: parsePackedHashes(doc, 'supersedes', 32),
    createdAt: num('$createdAt'),
    documentId: typeof doc['$id'] === 'string' ? (doc['$id'] as string) : '',
  }
}

/** List pack manifests (newest first). */
export async function readPackManifests(
  sdk: EvoSDK,
  repo: RepoRef,
  limit = 100,
): Promise<PackManifest[]> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.packManifest,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  return documents.map(toManifest)
}

/** The newest manifest of a given kind (the current locator / flatIndex), or null. */
export async function readNewestManifestOfKind(
  sdk: EvoSDK,
  repo: RepoRef,
  kind: PackKind,
): Promise<PackManifest | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.packManifest,
    where: [['kind', '==', kind]],
    orderBy: [
      ['kind', 'asc'],
      ['$createdAt', 'desc'],
    ],
    limit: 1,
  })
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

/** The current flatIndex manifest (kind 2) — the full recursive tree listing. */
export function readNewestFlatIndexManifest(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<PackManifest | null> {
  return readNewestManifestOfKind(sdk, repo, PACK_KIND.FLAT_INDEX)
}
