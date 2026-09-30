/**
 * Push-side chain writes for forge-v2 repos: `packManifest`, Platform `chunk` documents and
 * ref updates (`refUpdate` / `protectedRefUpdate`),
 * shaped exactly as forge-core writes them (`RepoService::write_pack_manifest`,
 * `backends/platform.rs::encode_chunk_doc`, `pack::split`), so a pack the browser records is
 * read by the CLI and vice versa.
 *
 * Every write is member-gated at consensus (`ownerRefersTo` maintainer or writer) and
 * idempotent here: the unique indexes are `(repoId, $ownerId, packHash)` for a manifest and
 * `(repoId, $ownerId, packHash, seq)` for a chunk, so each checks the signer's own copy first
 * and a duplicate-unique refusal (a lost answer to an earlier attempt) counts as done.
 *
 * RC1 (R-09/R-10/R-11, R-01, R-02): `packHash` is an identifier (`pack-hash.ts`), a manifest
 * carries no `offsetIndexParts` and must satisfy `storageShape` / `kindShape` / `sizeNonNeg`
 * ({@link manifestShapeProblem}), a ref update names an RC1-legal ref with 20- or 32-byte oids
 * ({@link refUpdateData}) and carries the repo's `vis` stamp. Each is pre-checked here, so
 * nothing is signed that consensus refuses.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils.js'

import { isRc1OidHex, isRc1RefName, matchesProtected } from '../rules'
import { isContentHash } from '../rules/oid'
import { readConfigBundle } from './config'
import { invalidateRepoFeed } from './issues'

import {
  CHUNK_FIELDS,
  CHUNK_PAYLOAD_MAX,
  FIELD_MAX,
  MANIFEST_MAX_URIS,
  MANIFEST_SIZE_MAX,
  MANIFEST_URI_MAX_LEN,
  PACK_KIND,
} from '../constants'
import { decodeIdentifier } from '../auth/base58'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  createDocumentIdempotent,
  previewCredits,
  queryDocumentsWithProof,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { DOC, withVis, type RepoRef } from './contract'
import { packHashOperand } from './pack-hash'
import { refusedAtBroadcast, retryAfterLag } from './lag-retry'
import { privateWriter, sealForRepo, sealedIntent } from './private-writes'
import { repoSource } from './source'
import { assertNoPlaintext } from './writes'

/** The manifest rule that counts its chunks (RC1 R-09). */
const PLATFORM_CHUNKS_RULE: ReadonlySet<string> = new Set(['platformChunks'])

/** The fields of a `packManifest` (forge-core `PackManifestInput`). */
export interface PackManifestInput {
  /** Hex SHA-256 of the artifact (written as a 32-byte identifier). */
  readonly packHash: string
  /** 0 git pack | 1 objectLocator | 2 flatIndex | 3 history index | 4 release assets (`PACK_KIND`). */
  readonly kind: number
  /** The artifact's byte length: 0 to 1 TiB. */
  readonly sizeBytes: number
  readonly objectCount: number
  /** Platform chunk documents holding a copy (0 when none). */
  readonly chunkCount: number
  /** 0 = chunks on Platform, 1 = external only. */
  readonly storage: 0 | 1
  /** Where the bytes are: a `platform://` locator first when chunks exist, then public URLs. */
  readonly uris: readonly string[]
  /**
   * The tip commit oids it indexes (hex, all one width: 40 or 64 digits): a flatIndex's tip, a
   * history index's `[tip]` or `[tip, baseTip]` (RC1 requires one or two for kind 3).
   */
  readonly tips?: readonly string[]
  /** Hex pack hashes this one supersedes. */
  readonly supersedes?: readonly string[]
}

/** A ref this tab moved, when the write that changed a repo's content was a ref update. */
export interface MovedRef {
  readonly refName: string
  readonly newOid: string
}

type ContentListener = (repo: RepoRef, moved?: MovedRef) => void
const contentListeners = new Set<ContentListener>()

/**
 * Run `listener` after this tab records a pack, moves a ref or publishes a release in a repo:
 * the browse plane's cached context of it (`lib/view/browse-source.ts`) and the repo home's refs
 * (`hooks/use-repo.ts`) no longer describe what is stored. `moved` names the ref a ref update
 * moved, and where to.
 */
export function onRepoContentWritten(listener: ContentListener): () => void {
  contentListeners.add(listener)
  return () => {
    contentListeners.delete(listener)
  }
}

/** Tell the {@link onRepoContentWritten} listeners that `repo`'s stored content changed. */
export function repoContentWritten(repo: RepoRef, moved?: MovedRef): void {
  // Called from the writes' `finally`: a listener that throws must neither stop the others nor
  // replace the write's own result or error (a landed write retried as failed).
  for (const listener of contentListeners) {
    try {
      listener(repo, moved)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('repoContentWritten listener failed', e)
    }
  }
}

/** Why `uris` does not fit the manifest's typed array, or null (`uris` ≤ 8 × ≤ 300 bytes). */
export function manifestUrisProblem(uris: readonly string[]): string | null {
  if (uris.length === 0) return 'no confirmed copy recorded any URI; refusing to write a manifest nothing can read'
  if (uris.length > MANIFEST_MAX_URIS) return `a manifest holds at most ${MANIFEST_MAX_URIS} URIs`
  if (uris.some((u) => new TextEncoder().encode(u).length > MANIFEST_URI_MAX_LEN)) return `a manifest URI holds at most ${MANIFEST_URI_MAX_LEN} bytes`
  return null
}

/**
 * Why `input` would be refused by the RC1 `packManifest` rules, or null: `packHash` a 32-byte
 * hash, `sizeNonNeg` (0 to 1 TiB), `storageShape` (a Platform copy's size fits its chunks, an
 * external-only one has none) and `kindShape` (a history index's tips are one or two oids; every
 * list entry whole). `platformChunks` (the chunks 0..n−1 exist) holds by construction: a manifest
 * is written only after its chunks are confirmed.
 */
export function manifestShapeProblem(input: PackManifestInput): string | null {
  if (!isContentHash(input.packHash)) return 'a pack hash is a 32-byte SHA-256 (64 hex digits)'
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MANIFEST_SIZE_MAX) {
    return 'a pack manifest records a size of 0 bytes to 1 TiB'
  }
  if (input.storage === 0 && input.sizeBytes > input.chunkCount * CHUNK_PAYLOAD_MAX) {
    return `a Platform copy of ${input.sizeBytes} bytes needs more than ${input.chunkCount} chunks`
  }
  if (input.storage === 1 && input.chunkCount !== 0) return 'an external-only copy records no Platform chunks'
  const tips = input.tips ?? []
  if (tips.some((t) => !isRc1OidHex(t) || t.length !== tips[0]?.length)) return 'manifest tips are oids of one width (20 or 32 bytes)'
  if (input.kind === PACK_KIND.HISTORY_INDEX && !(tips.length === 1 || tips.length === 2)) {
    return 'a history index names its tip, and at most one base tip'
  }
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
        // An identifier: base58, like `repoId`.
        ['packHash', '==', packHashOperand(packHashHex)],
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
  const problem = manifestUrisProblem(input.uris) ?? manifestShapeProblem(input)
  if (problem) throw new Error(problem)
  const existing = await findOwnManifest(sdk, repo, auth.identityId, input.packHash)
  if (existing !== null) return alreadyRecorded(existing)
  const data: Record<string, unknown> = {
    repoId: decodeIdentifier(repo.repoId),
    // An identifier: its 32 raw bytes, as `decodeIdentifier` gives `repoId`'s.
    packHash: hexToBytes(input.packHash),
    kind: input.kind,
    sizeBytes: input.sizeBytes,
    objectCount: input.objectCount,
    chunkCount: input.chunkCount,
    storage: input.storage,
    uris: [...input.uris],
  }
  if (input.tips && input.tips.length > 0) data['tips'] = concatHex(input.tips, (input.tips[0] as string).length / 2)
  if (input.supersedes && input.supersedes.length > 0) data['supersedes'] = concatHex(input.supersedes, 32)
  try {
    // `platformChunks` counts the chunks just written: a node a block behind refuses the manifest
    // at the broadcast check until it has applied them, so that (free) refusal is retried after
    // about a block. One inside a block is judged on current state: the chunks really are missing.
    return await retryAfterLag(
      () => createDocumentIdempotent(sdk, auth, { contractId: repo.forge.core, documentType: DOC.packManifest, data, ...(intent ? { intent } : {}) }),
      PLATFORM_CHUNKS_RULE,
      undefined,
      refusedAtBroadcast,
    )
  } catch (e) {
    if (!isDuplicate(e)) throw e
    const id = await findOwnManifest(sdk, repo, auth.identityId, input.packHash)
    if (id === null) throw e
    return alreadyRecorded(id)
  } finally {
    repoContentWritten(repo)
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
// ---------------------------------------------------------------------------
// Ref updates (forge-core `RepoService::write_ref_update`): `refNameHash = sha256(refName)`,
// `refName`, `newOid`, `force`, and `prevOid` when the expected prior tip is known. A ref
// matching the current `protectedPatterns` goes to the maintainer-gated
// `protectedRefUpdate`; a plain `refUpdate` for it would be inert under the as-of rule.
// ---------------------------------------------------------------------------

/** A ref update to write. */
export interface RefUpdateInput {
  readonly refName: string
  /** The new tip, hex; all zeros deletes the ref. */
  readonly newOid: string
  /** The tip this update expects to replace (divergence detection), hex. */
  readonly prevOid?: string
  readonly force?: boolean
}

/** `sha256(refName)` — the indexed key of every ref update. */
export function refNameHash(refName: string): Uint8Array {
  return sha256(new TextEncoder().encode(refName))
}

/**
 * The ref-update document data (without `repoId` and the `vis` stamp) forge-core writes. Refuses
 * before signing what RC1 consensus would: a ref name outside `$defs.refName` or ending in
 * `.lock` ({@link isRc1RefName}, which also keeps a line-injecting name from every clone's git),
 * and an oid that is not 20 or 32 bytes (`oidWidth`; a delete's zero oid has its ref's width).
 */
export function refUpdateData(input: RefUpdateInput): Record<string, unknown> {
  if (!isRc1RefName(input.refName)) throw new Error(`illegal ref name ${JSON.stringify(input.refName)}`)
  if (!isRc1OidHex(input.newOid)) throw new Error(`a ref's new tip must be a 20- or 32-byte oid, not ${JSON.stringify(input.newOid)}`)
  if (input.prevOid && !isRc1OidHex(input.prevOid)) {
    throw new Error(`a ref's previous tip must be a 20- or 32-byte oid, not ${JSON.stringify(input.prevOid)}`)
  }
  const data: Record<string, unknown> = {
    refNameHash: refNameHash(input.refName),
    refName: input.refName,
    newOid: hexToBytes(input.newOid),
    force: input.force ?? false,
  }
  if (input.prevOid) data['prevOid'] = hexToBytes(input.prevOid)
  return data
}

/** Which type a ref update must be, from the repo's current protected patterns. */
export function refUpdateType(refName: string, protectedPatterns: readonly string[]): 'refUpdate' | 'protectedRefUpdate' {
  return matchesProtected(refName, protectedPatterns) ? DOC.protectedRefUpdate : DOC.refUpdate
}

/**
 * Move `refName` in `repo`: a `protectedRefUpdate` (maintainers only) when the ref matches
 * the current protected patterns, else a `refUpdate` (maintainers and writers). The patterns
 * are read fresh unless the caller passes them.
 */
export async function writeRefUpdate(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: RefUpdateInput,
  options: { readonly intent?: string; readonly protectedPatterns?: readonly string[] } = {},
): Promise<WriteResult & { readonly documentType: 'refUpdate' | 'protectedRefUpdate' }> {
  let data = refUpdateData(input)
  let documentType: 'refUpdate' | 'protectedRefUpdate'
  if (repo.visibility === 'private') {
    // Sealed patterns: only a member reading the repo can route, on a fresh session's config.
    if (repo.session === undefined) throw new Error("a private repo's protected branches are sealed: read it as a member before moving a ref")
    const writer = await privateWriter(sdk, auth, repo)
    documentType = refUpdateType(input.refName, options.protectedPatterns ?? writer.protectedPatterns)
    data = await sealForRepo(sdk, auth, repo, documentType, data, writer)
    options = { ...options, ...(options.intent !== undefined ? { intent: sealedIntent(options.intent, writer.keys) } : {}) }
  } else {
    // The complete config timeline's newest well-formed config: the one the rules apply.
    const patterns = options.protectedPatterns ?? (await readConfigBundle(sdk, repo)).config?.protectedPatterns ?? []
    documentType = refUpdateType(input.refName, patterns)
  }
  assertNoPlaintext(repo, documentType, data)
  let moved: MovedRef | undefined
  try {
    const r = await createDocumentIdempotent(sdk, auth, {
      contractId: repo.forge.core,
      documentType,
      // The stamp goes on after sealing: it is plaintext on chain, never part of `enc`.
      data: { repoId: decodeIdentifier(repo.repoId), ...withVis(repo.visibility, documentType, data) },
      ...(options.intent ? { intent: options.intent } : {}),
    })
    moved = { refName: input.refName, newOid: input.newOid.toLowerCase() }
    return { ...r, documentType }
  } finally {
    invalidateRepoFeed(repo)
    repoContentWritten(repo, moved)
  }
}

