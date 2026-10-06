/**
 * Pack mirrors (UPDATE-1 `packMirror`, `forge-v2.md` §2, §9.1): the recorded mirrors of one of a
 * public repo's packs, read only when every copy its manifests name has failed, as a stand-in
 * copy whose addresses follow the shared read order (`lib/rules/pack-mirror.ts`, parity with
 * forge-core `rules::pack_mirror`). Its bytes are verified like any copy's: a mirror can only fail
 * to serve. One read of the records and one of the members, never on the happy path.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryDocuments, type PlainDocument } from '../sdk'
import { mirrorReadOrder, type MirrorRecord } from '../rules/pack-mirror'
import { num, str, stringArray, type RepoRef } from './contract'
import { readMemberships } from './members'
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

/**
 * The addresses to try for `manifest`'s pack, members' mirrors first, at most eight; empty for a
 * private repo, or when none is recorded. A failed read is none.
 */
export async function mirrorUrisOf(sdk: EvoSDK, repo: RepoRef, manifest: PackManifest): Promise<string[]> {
  if (repo.visibility !== 'public') return []
  try {
    const docs = await queryDocuments(
      sdk,
      repoSource(repo).repoQuery(DOC_PACK_MIRROR, { where: [['packHash', '==', packHashOperand(manifest.packHash)]], orderBy: [['$ownerId', 'asc']], limit: 100 }),
    )
    const records = docs.flatMap((d) => mirrorRecordOf(d) ?? [])
    if (records.length === 0) return []
    const members = await readMemberships(sdk, repo).catch(() => [])
    const role = new Map(members.map((m) => [m.identity, m.role]))
    return mirrorReadOrder({
      packHash: manifest.packHash,
      listed: [manifest.packHash],
      visibility: 'public',
      mirrors: records.map((r) => ({ ...r, ownerRole: role.get(r.owner) ?? null })),
    })
  } catch {
    return []
  }
}

/** A stand-in external copy of `manifest` at `uris` (its mirrors). */
export function mirrorCopy(manifest: PackManifest, uris: readonly string[]): PackManifest {
  return { ...manifest, storage: 1, uris, copies: undefined, documentId: `mirror:${manifest.packHash}` }
}
