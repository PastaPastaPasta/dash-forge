/**
 * Push-side chain writes for forge-v2 repos: `packManifest` and Platform `chunk` documents,
 * shaped exactly as forge-core writes them (`RepoService::write_pack_manifest`,
 * `backends/platform.rs::encode_chunk_doc`, `pack::split`), so a pack the browser records is
 * read by the CLI and vice versa.
 *
 * Every write is member-gated at consensus (`ownerRefersTo` maintainer or writer) and
 * idempotent here: the unique indexes are `(repoId, $ownerId, packHash)` for a manifest and
 * `(repoId, $ownerId, packHash, seq)` for a chunk, so each checks the signer's own copy first
 * and a duplicate-unique refusal (a lost answer to an earlier attempt) counts as done.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { hexToBytes } from '@noble/hashes/utils.js'

import { CHUNK_FIELDS, FIELD_MAX, MANIFEST_MAX_URIS, MANIFEST_URI_MAX_LEN } from '../constants'
import { decodeIdentifier } from '../auth/base58'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  createDocumentIdempotent,
  hexToBase64,
  previewCredits,
  queryDocumentsWithProof,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, type RepoRef } from './contract'
import { repoSource } from './source'

/** The fields of a `packManifest` (forge-core `PackManifestInput`). */
export interface PackManifestInput {
  /** Hex SHA-256 of the artifact. */
  readonly packHash: string
  /** 0 git pack | 1 objectLocator | 2 flatIndex. */
  readonly kind: number
  readonly sizeBytes: number
  readonly objectCount: number
  /** Platform chunk documents holding a copy (0 when none). */
  readonly chunkCount: number
  /** 0 = chunks on Platform, 1 = external only. */
  readonly storage: 0 | 1
  /** Where the bytes are: a `platform://` locator first when chunks exist, then public URLs. */
  readonly uris: readonly string[]
  /** flatIndex only: the tip commit oids it indexes (hex). */
  readonly tips?: readonly string[]
  /** Hex pack hashes this one supersedes. */
  readonly supersedes?: readonly string[]
}

/** Why `uris` does not fit the manifest's typed array, or null (`uris` ≤ 8 × ≤ 300 bytes). */
export function manifestUrisProblem(uris: readonly string[]): string | null {
  if (uris.length === 0) return 'no confirmed copy recorded any URI; refusing to write a manifest nothing can read'
  if (uris.length > MANIFEST_MAX_URIS) return `a manifest holds at most ${MANIFEST_MAX_URIS} URIs`
  if (uris.some((u) => new TextEncoder().encode(u).length > MANIFEST_URI_MAX_LEN)) return `a manifest URI holds at most ${MANIFEST_URI_MAX_LEN} bytes`
  return null
}

function concatHex(list: readonly string[], width: number): Uint8Array {
  const out = new Uint8Array(list.length * width)
  list.forEach((h, i) => {
    const b = hexToBytes(h)
    if (b.length !== width) throw new Error(`expected ${width}-byte entries, got ${b.length}`)
    out.set(b, i * width)
  })
  return out
}

/** The result for a manifest this signer already recorded (nothing spent). */
function alreadyRecorded(documentId: string): WriteResult {
  return { documentId, confirmed: true, cost: previewCredits(0), actualCredits: 0 }
}

function isDuplicate(e: unknown): boolean {
  return e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE
}

/** The signer's own manifest of `packHash` in `repo` (the unique slot), or null. */
export async function findOwnManifest(sdk: EvoSDK, repo: RepoRef, ownerId: string, packHashHex: string): Promise<string | null> {
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(DOC.packManifest, {
      where: [
        ['$ownerId', '==', ownerId],
        ['packHash', '==', hexToBase64(packHashHex)],
      ],
      limit: 1,
    }),
  )
  const id = documents[0]?.['$id']
  return typeof id === 'string' ? id : null
}

/**
 * Write a `packManifest` (member-gated). Returns the signer's manifest id: an existing one
 * (nothing spent) when this signer already recorded the pack.
 */
export async function writePackManifest(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: PackManifestInput,
  intent?: string,
): Promise<WriteResult> {
  const problem = manifestUrisProblem(input.uris)
  if (problem) throw new Error(problem)
  const existing = await findOwnManifest(sdk, repo, auth.identityId, input.packHash)
  if (existing !== null) return alreadyRecorded(existing)
  const data: Record<string, unknown> = {
    repoId: decodeIdentifier(repo.repoId),
    packHash: hexToBytes(input.packHash),
    kind: input.kind,
    sizeBytes: input.sizeBytes,
    objectCount: input.objectCount,
    chunkCount: input.chunkCount,
    storage: input.storage,
    offsetIndexParts: 0,
    uris: [...input.uris],
  }
  if (input.tips && input.tips.length > 0) data['tips'] = concatHex(input.tips, 20)
  if (input.supersedes && input.supersedes.length > 0) data['supersedes'] = concatHex(input.supersedes, 32)
  try {
    return await createDocumentIdempotent(sdk, auth, { contractId: repo.forge.core, documentType: DOC.packManifest, data, ...(intent ? { intent } : {}) })
  } catch (e) {
    if (!isDuplicate(e)) throw e
    const id = await findOwnManifest(sdk, repo, auth.identityId, input.packHash)
    if (id === null) throw e
    return alreadyRecorded(id)
  }
}

/** One chunk: its seq and up to three ≤ 4,900-byte fields (forge-core `pack::split`). */
export interface Chunk {
  readonly seq: number
  readonly fields: readonly Uint8Array[]
}

/** Split `bytes` into chunks exactly as forge-core `pack::split` does. */
export function splitChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = []
  let fields: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += FIELD_MAX) {
    fields.push(bytes.subarray(at, at + FIELD_MAX))
    if (fields.length === CHUNK_FIELDS) {
      chunks.push({ seq: chunks.length, fields })
      fields = []
    }
  }
  if (fields.length > 0) chunks.push({ seq: chunks.length, fields })
  return chunks
}

/** The seqs of `packHash` the signer already stored in `repo`. */
async function storedSeqs(sdk: EvoSDK, repo: RepoRef, ownerId: string, packHashHex: string, total: number): Promise<Set<number>> {
  const have = new Set<number>()
  const source = repoSource(repo)
  for (let start = 0; start < total; start += 100) {
    const seqs = Array.from({ length: Math.min(100, total - start) }, (_, i) => start + i)
    const { documents } = await queryDocumentsWithProof(sdk, source.chunkQuery(packHashHex, ownerId, seqs))
    for (const d of documents) {
      const raw = d['seq']
      const n = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : -1
      if (n >= 0) have.add(n)
    }
  }
  return have
}

/**
 * Store `bytes` as the signer's `chunk` documents in `repo` (resumable: seqs already on chain
 * are skipped, so a retry after an interruption pays only for what is missing). Returns the
 * `platform://<core>/<repoId>/<owner>/<packHash>` locator a manifest records.
 */
export async function putPlatformChunks(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  bytes: Uint8Array,
  packHashHex: string,
  /** `written`: chunks this call itself created (0 on the first report, before any write). */
  onProgress?: (done: number, total: number, written: number) => void,
): Promise<{ locator: string; chunkCount: number }> {
  const chunks = splitChunks(bytes)
  const have = await storedSeqs(sdk, repo, auth.identityId, packHashHex, chunks.length)
  const R = decodeIdentifier(repo.repoId)
  const hash = hexToBytes(packHashHex)
  let done = have.size
  let written = 0
  onProgress?.(done, chunks.length, written)
  for (const chunk of chunks) {
    if (have.has(chunk.seq)) continue
    const data: Record<string, unknown> = { repoId: R, packHash: hash, seq: chunk.seq }
    chunk.fields.forEach((f, i) => {
      data[`d${i}`] = new Uint8Array(f)
    })
    try {
      await createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: DOC.chunk,
        data,
        intent: `chunk:${repo.repoId}:${packHashHex}:${chunk.seq}`,
      })
      written += 1
    } catch (e) {
      if (!isDuplicate(e)) throw e
    }
    done += 1
    onProgress?.(done, chunks.length, written)
  }
  return { locator: `platform://${repo.forge.core}/${repo.repoId}/${auth.identityId}/${packHashHex}`, chunkCount: chunks.length }
}
