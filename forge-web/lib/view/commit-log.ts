/**
 * Commit log + tree diff (view glue) — walk history and compute per-file changes over the
 * browse plane. Each commit/tree is a ranged, hash-verified object read; the log follows first
 * parent, and the diff recursively compares two trees with a node cap so a huge commit can't
 * runaway-fetch. Line-level diffs are intentionally out of this pass (blob view shows content).
 */

import type { BrowseReader } from '../browse'
import { commitSubject, parseCommit, parseTree, type CommitObject, type TreeEntry } from './git-objects'

/** One entry in a rendered commit log. */
export interface LogEntry {
  readonly oid: string
  readonly subject: string
  readonly commit: CommitObject
}

/** Walk the first-parent history from `tipOid`, up to `limit` commits. */
export async function walkLog(reader: BrowseReader, tipOid: string, limit = 30): Promise<LogEntry[]> {
  const out: LogEntry[] = []
  let oid: string | undefined = tipOid
  const seen = new Set<string>()
  while (oid && out.length < limit && !seen.has(oid)) {
    seen.add(oid)
    const obj = await reader.readObject(oid)
    if (obj.type !== 'commit') break
    const commit = parseCommit(obj.bytes)
    out.push({ oid, subject: commitSubject(commit.message), commit })
    oid = commit.parents[0]
  }
  return out
}

/** A single file change in a commit. */
export interface FileChange {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted'
  readonly oid: string
}

const DIFF_NODE_CAP = 2000

async function readTreeMap(
  reader: BrowseReader,
  treeOid: string | null,
): Promise<Map<string, TreeEntry>> {
  const map = new Map<string, TreeEntry>()
  if (!treeOid) return map
  try {
    const obj = await reader.readObject(treeOid)
    if (obj.type !== 'tree') return map
    for (const e of parseTree(obj.bytes)) map.set(e.name, e)
  } catch {
    // A tree not in the locator (e.g. a deleted subtree) yields no entries.
  }
  return map
}

const isDir = (e: TreeEntry | undefined): boolean => e?.mode === 0o40000

/**
 * Recursively diff two trees, collecting file-level changes. `baseTreeOid` may be null (a root
 * commit) → everything under `headTreeOid` is "added"; `headTreeOid` may be null (a deleted
 * subtree). Bounded by {@link DIFF_NODE_CAP}.
 */
export async function diffTrees(
  reader: BrowseReader,
  baseTreeOid: string | null,
  headTreeOid: string | null,
  prefix = '',
  budget = { n: DIFF_NODE_CAP },
): Promise<FileChange[]> {
  if (budget.n <= 0) return []
  const changes: FileChange[] = []
  const [base, head] = await Promise.all([
    readTreeMap(reader, baseTreeOid),
    readTreeMap(reader, headTreeOid),
  ])

  const names = new Set<string>([...base.keys(), ...head.keys()])
  for (const name of names) {
    if (budget.n <= 0) break
    const b = base.get(name)
    const h = head.get(name)
    const path = prefix ? `${prefix}/${name}` : name

    if (b && h && b.oid === h.oid) continue
    if (isDir(b) || isDir(h)) {
      budget.n -= 1
      const sub = await diffTrees(
        reader,
        isDir(b) ? (b?.oid ?? null) : null,
        isDir(h) ? (h?.oid ?? null) : null,
        path,
        budget,
      )
      changes.push(...sub)
      continue
    }
    budget.n -= 1
    if (b && !h) changes.push({ path, status: 'deleted', oid: b.oid })
    else if (!b && h) changes.push({ path, status: 'added', oid: h.oid })
    else if (b && h) changes.push({ path, status: 'modified', oid: h.oid })
  }
  changes.sort((a, b2) => a.path.localeCompare(b2.path))
  return changes
}
