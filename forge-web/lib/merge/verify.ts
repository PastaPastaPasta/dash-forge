/**
 * The safety net under the pack builder. Before anything is uploaded or any ref moves, prove
 * that every object the new tip needs beyond the base tip's history can be read, hash-verified,
 * from the merge pack or from the base repo's OWN reader. A merge must never move a branch to
 * objects nobody can fetch.
 *
 * The walk is the pack builder's (`newCommits` + `objectsToPack`), but with only the base tip as
 * "had". So for a same-repo PR the head's commits, trees and blobs are each read back from the
 * base repo, not assumed present because an index lists them: a writer can publish an index
 * row, or a pack, that does not hold what it claims. Everything reachable from the base tip is
 * the branch's existing history and is not re-proven. Commits and trees are checked as fsck
 * would on the way.
 *
 * `base` must be the base repo's own reader, never a fallback to the PR's source repo.
 */

import { BrowseReader, ObjectLocator, type GitObject } from '../browse'
import { preferring } from '../view/pull-diff'
import type { ObjectReader } from '../view/tree-nav'
import { newCommits, objectsToPack } from './objects'

/** Objects the walk may read before it gives up (and reports the merge as unverifiable). */
export const VERIFY_OBJECT_CAP = 200_000

class Missing extends Error {
  constructor(readonly oid: string) {
    super(`missing ${oid}`)
  }
}

/**
 * The oids the new tip needs that neither `pack` nor `base` can produce (empty: complete; the
 * walk stops at the first gap). Throws when the walk is too large to finish, which callers
 * treat as "not verified".
 */
export async function missingFromClosure(pack: Uint8Array, tip: string, baseTip: string, base: ObjectReader, cap = VERIFY_OBJECT_CAP): Promise<string[]> {
  const { indexPacks, memoryPackSource, serializeLocator, IndexTooLargeError } = await import('../browse/indexer')
  const rows =
    pack.length > 32
      ? await indexPacks([pack]).catch((e: unknown) => {
          throw e instanceof IndexTooLargeError ? new Error('This change is too large to check in the browser. Make it with dg instead.') : e
        })
      : []
  const packReader = rows.length > 0 ? new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack])) : null
  const inPack = new Set(rows.map((r) => r.oidHex))
  let reads = 0
  const reader: ObjectReader = {
    readObject: async (oid: string): Promise<GitObject> => {
      if (++reads > cap) throw new Error(`the pack check stopped at its ${cap}-read limit`)
      if (packReader !== null && inPack.has(oid)) return packReader.readObject(oid)
      try {
        return await base.readObject(oid)
      } catch {
        throw new Missing(oid)
      }
    },
  }
  try {
    const commits = await newCommits(reader, tip, baseTip === '' ? [] : [baseTip])
    await objectsToPack(reader, commits)
    return []
  } catch (e) {
    if (e instanceof Missing) return [e.oid]
    throw e
  }
}

/**
 * The readers a merge uses: `merge` reads the head's repo first and falls back to the base
 * repo, and `base` is the base repo alone (what {@link missingFromClosure} proves against).
 * Null until the base repo's OWN reader exists: nothing about the base is ever taken from the
 * PR's source repo, which its author controls.
 */
export function mergeReaders(baseOnly: ObjectReader | null, head: ObjectReader | null): { merge: ObjectReader; base: ObjectReader } | null {
  if (baseOnly === null) return null
  return { merge: head === null ? baseOnly : preferring(head, baseOnly), base: baseOnly }
}
