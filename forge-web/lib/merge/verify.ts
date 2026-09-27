/**
 * The safety net under the pack builder: before anything is uploaded or any ref moves, prove
 * that every object reachable from the new tip is either in the merge pack or already in the
 * base repo. A merge must never move a branch to objects nobody can fetch.
 *
 * The walk descends only through objects the pack carries. An object the base repo already
 * holds is not descended into: the base repo's packs are self-contained (every pack a reader
 * accepts is), so its closure is there too. Presence in the base is asked of its browse index
 * (`locate`), which costs no download; a reader without one is asked to read the object.
 * The base's index is the snapshot the page loaded, so anything pushed to it since then counts
 * as missing: the check can refuse a good merge, never pass a broken one.
 */

import { BrowseReader, MODE_GITLINK, ObjectLocator } from '../browse'
import { parseCommit, parseTree } from '../view/git-objects'
import type { ObjectReader } from '../view/tree-nav'

/** Objects the walk may visit before it gives up (and reports the merge as unverifiable). */
export const VERIFY_OBJECT_CAP = 200_000

/**
 * Oids reachable from `tip` that are in neither `pack` nor `base` (empty: complete). Throws
 * when the walk is too large to finish, which callers treat as "not verified".
 */
export async function missingFromClosure(pack: Uint8Array, tip: string, base: ObjectReader, cap = VERIFY_OBJECT_CAP): Promise<string[]> {
  const { indexPacks, memoryPackSource, serializeLocator } = await import('../browse/indexer')
  const rows = pack.length > 32 ? await indexPacks([pack]) : []
  const inPack = new Set(rows.map((r) => r.oidHex))
  const packReader = rows.length > 0 ? new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack])) : null
  const inBase = async (oid: string): Promise<boolean> => {
    if (base.locate) return base.locate(oid) !== null
    try {
      await base.readObject(oid)
      return true
    } catch {
      return false
    }
  }

  const missing: string[] = []
  const seen = new Set<string>()
  const stack = [tip]
  while (stack.length > 0) {
    const oid = stack.pop() as string
    if (seen.has(oid)) continue
    seen.add(oid)
    if (seen.size > cap) throw new Error(`the pack check stopped at its ${cap}-object limit`)
    if (!inPack.has(oid) || packReader === null) {
      if (!(await inBase(oid))) missing.push(oid)
      continue
    }
    const obj = await packReader.readObject(oid)
    if (obj.type === 'commit') {
      const c = parseCommit(obj.bytes)
      stack.push(c.tree, ...c.parents)
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) if (e.mode !== MODE_GITLINK) stack.push(e.oid)
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(new TextDecoder().decode(obj.bytes))
      if (m) stack.push(m[1] as string)
    }
  }
  return missing
}
