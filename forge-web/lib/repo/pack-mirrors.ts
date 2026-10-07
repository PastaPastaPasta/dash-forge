/**
 * Pack mirrors (UPDATE-1 `packMirror`, `forge-v2.md` §2, §9.1): the recorded mirrors of one of a
 * public repo's packs, read only when every copy its manifests name has failed, as a stand-in
 * copy whose addresses follow the shared read order (`lib/rules/pack-mirror.ts`, parity with
 * forge-core `rules::pack_mirror`). Its bytes are verified like any copy's: a mirror can only fail
 * to serve. Never read on the happy path; read once per pack in a session.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import { queryDocuments, type PlainDocument, type WhereClause } from '../sdk'
import { mirrorReadOrder, type MirrorRecord } from '../rules/pack-mirror'
import { num, str, stringArray, type RepoRef } from './contract'
import { readRoleOracle } from './members'
import { packHashHex, packHashOperand } from './pack-hash'
import type { PackManifest } from './packs'
import { repoSource } from './source'

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
 * `pack_mirror::mirrors_of`).
 */
async function readMirrorUris(sdk: EvoSDK, repo: RepoRef, packHash: string, network: Network): Promise<string[]> {
  const oracle = await readRoleOracle(sdk, repo, network)
  const members = [...new Set(oracle.memberships.map((m) => m.identity))].sort()
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
