/**
 * Pack mirrors (UPDATE-1 `packMirror`, `forge-v2.md` §2, §9.1): the recorded mirrors of one of a
 * public repo's packs, read only when every copy its manifests name has failed, as a stand-in
 * copy whose addresses follow the shared read order (`lib/rules/pack-mirror.ts`, parity with
 * forge-core `rules::pack_mirror`). Its bytes are verified like any copy's: a mirror can only fail
 * to serve. Never read on the happy path; read once per pack in a session.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { hexToBytes } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import { DEFAULT_NETWORK, type Network } from '../constants'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  queryAllDocuments,
  queryDocuments,
  type DeleteResult,
  type PlainDocument,
  type WhereClause,
  type WriteAuth,
} from '../sdk'
import { checkMirrorUris, mirrorReadOrder, type MirrorRecord, type UriCheck } from '../rules/pack-mirror'
import { asIdentifierString, num, str, stringArray, type RepoRef } from './contract'
import { readRoleOracle } from './members'
import { packHashHex, packHashOperand } from './pack-hash'
import type { PackManifest } from './packs'
import { contractOf, repoSource } from './source'

/** forge-core's pack mirror type. */
export const DOC_PACK_MIRROR = 'packMirror'

/** A `packMirror` document as the read order reads it (`ownerRole` filled in by the caller). */
export function mirrorRecordOf(doc: PlainDocument): (MirrorRecord & { readonly owner: string }) | null {
  const packHash = packHashHex(doc['packHash'])
  const uris = stringArray(doc, 'uris') ?? []
  if (packHash === '' || uris.length === 0) return null
  return { id: str(doc, '$id'), owner: str(doc, '$ownerId'), ownerRole: null, createdAt: num(doc, '$createdAt'), packHash, kind: num(doc, 'kind'), uris }
}

/** Records one read returns at most, and identities one `in` clause names at most. */
const PAGE = 100

/** Each pack's mirror addresses, read once per session (`network:core:repo:pack`). */
const memo = new Map<string, Promise<string[]>>()

/** Forget every pack's mirror addresses (a new session; tests). */
export function resetMirrorUris(): void {
  memo.clear()
  byOwner.clear()
}

/**
 * The addresses to try for `manifest`'s pack, members' mirrors first, at most eight; empty for a
 * private repo, or when none is recorded. Read once per pack in a session; a failed read is none,
 * and is read again next time.
 */
export function mirrorUrisOf(sdk: EvoSDK, repo: RepoRef, manifest: PackManifest, network: Network = DEFAULT_NETWORK): Promise<string[]> {
  if (repo.visibility !== 'public') return Promise.resolve([])
  const key = `${network}:${repo.forge.core}:${repo.repoId}:${manifest.packHash.toLowerCase()}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const read = readMirrorUris(sdk, repo, manifest.packHash, network).catch(() => {
    if (memo.get(key) === read) memo.delete(key)
    return []
  })
  memo.set(key, read)
  return read
}

/**
 * Every member's record of the pack (by writer: no number of strangers' records can push a
 * member's out), then one page of everyone's, in the shared read order (forge-core
 * `pack_mirror::mirrors_of`). A bot's records are read like a stranger's (review-rev41 M-4;
 * forge-core `repo::trusted_member`).
 */
async function readMirrorUris(sdk: EvoSDK, repo: RepoRef, packHash: string, network: Network): Promise<string[]> {
  const oracle = await readRoleOracle(sdk, repo, network)
  const members = [...new Set(oracle.memberships.map((m) => m.identity))].filter((id) => oracle.currentRole(id) !== 'bot').sort()
  const source = repoSource(repo)
  const byHash: WhereClause = ['packHash', '==', packHashOperand(packHash)]
  const query = (where: readonly WhereClause[]) =>
    queryDocuments(sdk, source.repoQuery(DOC_PACK_MIRROR, { where, orderBy: [['$ownerId', 'asc']], limit: PAGE }))
  const reads: Promise<PlainDocument[]>[] = []
  for (let at = 0; at < members.length; at += PAGE) reads.push(query([byHash, ['$ownerId', 'in', members.slice(at, at + PAGE)]]))
  reads.push(query([byHash]))
  const seen = new Set<string>()
  const records = (await Promise.all(reads)).flat().flatMap((d) => {
    const r = mirrorRecordOf(d)
    if (r === null || seen.has(r.id)) return []
    seen.add(r.id)
    return [r]
  })
  if (records.length === 0) return []
  return mirrorReadOrder({
    packHash,
    listed: [packHash],
    visibility: 'public',
    mirrors: records.map((r) => ({ ...r, ownerRole: oracle.currentRole(r.owner) })),
  })
}

/** A stand-in external copy of `manifest` at `uris` (its mirrors). */
export function mirrorCopy(manifest: PackManifest, uris: readonly string[]): PackManifest {
  return { ...manifest, storage: 1, uris, copies: undefined, documentId: `mirror:${manifest.packHash}` }
}

/** One of the signer's own `packMirror` records. */
export interface OwnMirror {
  readonly id: string
  readonly repoId: string
  readonly packHash: string
  readonly kind: number
  readonly uris: readonly string[]
}

function problemWords(check: Exclude<UriCheck, { readonly kind: number }>): string {
  const which = check.index === undefined ? '' : `address ${check.index + 1}: `
  switch (check.problem) {
    case 'none': return 'give at least one address'
    case 'tooMany': return 'a mirror holds at most 4 addresses'
    case 'length': return `${which}an address is 1-300 characters`
    case 'address': return `${which}use an https:// URL without a user name or password, or ipfs://<CID>`
    case 'ipfsPath': return `${which}an ipfs:// address is the bare CID, no path`
    case 'duplicate': return `${which}the same address twice`
    case 'mixedKinds': return 'one mirror holds https addresses or IPFS addresses, not both'
  }
}

/** Why a record of `uris` would be refused, in words, or null. Parity: forge-core `uri_problem_words`. */
export function mirrorUrisProblem(uris: readonly string[]): string | null {
  const check = checkMirrorUris(uris)
  return 'kind' in check ? null : problemWords(check)
}

/** Each owner's records in a forge, read once per session (`contract:owner`) until a pin or unpin changes them. */
const byOwner = new Map<string, Promise<OwnMirror[]>>()

/** Forget `owner`'s records (after they pin or unpin). */
export function forgetMirrorsBy(owner: string): void {
  for (const key of byOwner.keys()) if (key.endsWith(`:${owner}`)) byOwner.delete(key)
}

/**
 * Every mirror `owner` recorded in `repo`'s forge (the `byOwner` index), oldest first, kept to
 * `repo`. Parity: forge-core `pack_mirror::mirrors_by`.
 */
export async function mirrorsBy(sdk: EvoSDK, repo: RepoRef, owner: string): Promise<OwnMirror[]> {
  const contract = contractOf(repo.forge, DOC_PACK_MIRROR)
  const key = `${contract}:${owner}`
  let all = byOwner.get(key)
  if (all === undefined) {
    const read = queryAllDocuments(sdk, { dataContractId: contract, documentTypeName: DOC_PACK_MIRROR, where: [['$ownerId', '==', owner]], orderBy: [['$createdAt', 'asc']] }).then((docs) =>
      docs.flatMap((d) => {
        const r = mirrorRecordOf(d)
        return r === null ? [] : [{ id: r.id, repoId: asIdentifierString(d['repoId']), packHash: r.packHash, kind: r.kind, uris: r.uris }]
      }),
    )
    read.catch(() => {
      if (byOwner.get(key) === read) byOwner.delete(key)
    })
    byOwner.set(key, read)
    all = read
  }
  return (await all).filter((m) => m.repoId === repo.repoId)
}

/**
 * Record a mirror of `packHash` at `uris` as the signer: one per pack each, public repositories
 * only. A record the signer already holds (the unique slot) is not an error. Parity: forge-core
 * `pack_mirror::record_mirror`.
 */
export async function recordMirror(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, packHash: string, uris: readonly string[], intent?: string): Promise<void> {
  if (repo.visibility !== 'public') throw new Error("a private repository's packs are sealed to its members: mirrors are for public repositories")
  const check = checkMirrorUris(uris)
  if (!('kind' in check)) throw new Error(problemWords(check))
  try {
    await createDocumentIdempotent(sdk, auth, {
      contractId: contractOf(repo.forge, DOC_PACK_MIRROR),
      documentType: DOC_PACK_MIRROR,
      data: { repoId: decodeIdentifier(repo.repoId), packHash: hexToBytes(packHash.toLowerCase()), kind: check.kind, uris: [...uris] },
      ...(intent ? { intent } : {}),
    })
  } catch (e) {
    if (!(e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE)) throw e
  }
}

/** Delete the signer's mirror record `id`. Parity: forge-core `pack_mirror::delete_mirror`. */
export function deleteMirror(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, id: string): Promise<DeleteResult> {
  return deleteDocumentIdempotent(sdk, auth, { contractId: contractOf(repo.forge, DOC_PACK_MIRROR), documentType: DOC_PACK_MIRROR, documentId: id, repo: repo.repoId })
}
