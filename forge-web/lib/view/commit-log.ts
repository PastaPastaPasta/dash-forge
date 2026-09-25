/**
 * Commit log + tree diff (view glue) — walk history and compute per-file changes over the
 * browse plane. Each commit/tree is a ranged, hash-verified object read; the log follows first
 * parent, and the diff compares two trees level by level with a node cap so a huge commit
 * can't runaway-fetch. Line-level patches over the resulting change set live in `file-diff.ts`.
 */

import { MODE_GITLINK, MODE_TREE, type BrowseReader } from '../browse'
import { commitSubject, parseCommit, type CommitObject, type TreeEntry } from './git-objects'
import { mapPooled } from './pool'
import { readCommit, readTree, type ObjectReader } from './tree-nav'

/**
 * Where each side of a comparison reads its objects. A commit diff reads both from one repo;
 * a PR reads its base from the target repo and its head from the contract the head was pushed
 * to (`sourceContractId`), which is usually a different one.
 */
export interface DiffSides {
  readonly base: ObjectReader
  readonly head: ObjectReader
}

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

/** A single file change between two trees. */
export interface FileChange {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted'
  /** The blob (or gitlink commit) on each side; null on the side where the path is absent. */
  readonly baseOid: string | null
  readonly headOid: string | null
  /** The tree-entry mode on each side (e.g. `0o100644`); null where the path is absent. */
  readonly baseMode: number | null
  readonly headMode: number | null
  /** The object most useful for a compact summary (head, or base for a deletion). */
  readonly oid: string
}

/** A tree comparison. `truncated` means the node cap stopped it before every path was seen. */
export interface TreeDiff {
  readonly changes: FileChange[]
  readonly truncated: boolean
}

const DIFF_NODE_CAP = 2000
/** Tree reads in flight at once while walking changed subtrees. */
const TREE_READ_POOL = 6

async function readTreeMap(reader: ObjectReader, treeOid: string | null): Promise<Map<string, TreeEntry>> {
  // A tree that cannot be read is an error, not an empty directory: treating it as empty
  // would report every file under it as added or deleted.
  const entries = treeOid ? await readTree(reader, treeOid) : []
  return new Map(entries.map((e) => [e.name, e]))
}

const isDir = (e: TreeEntry | undefined): boolean => e?.mode === MODE_TREE

/** Whether an entry is a gitlink (submodule): its oid names a commit in another repo. */
export const isGitlink = (mode: number | null): boolean => mode === MODE_GITLINK

function fileChange(path: string, b: TreeEntry | undefined, h: TreeEntry | undefined): FileChange {
  return {
    path,
    status: b && h ? 'modified' : b ? 'deleted' : 'added',
    baseOid: b?.oid ?? null,
    headOid: h?.oid ?? null,
    baseMode: b?.mode ?? null,
    headMode: h?.mode ?? null,
    oid: (h ?? b)?.oid ?? '',
  }
}

/** A pair of trees still to compare, at `path`. */
interface TreePair {
  readonly path: string
  readonly base: string | null
  readonly head: string | null
}

/**
 * Diff two trees into file-level changes. `baseTreeOid` may be null (a root commit: every
 * path under head is added) and so may `headTreeOid` (everything deleted). Base trees are read
 * through `sides.base` and head trees through `sides.head`.
 *
 * Covers what a reviewer would otherwise miss: a mode-only change (`chmod +x`) is `modified`
 * with equal oids, and a path that switched between file and directory yields both the file's
 * deletion or addition and the directory's contents.
 *
 * Walks level by level, reading each level's changed subtrees through a small pool. The
 * {@link DIFF_NODE_CAP} budget is spent in path order, so when a huge comparison is
 * `truncated` the same paths are listed on every load, whatever order the reads land in.
 */
export async function diffTrees(
  sides: DiffSides,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Promise<TreeDiff> {
  const changes: FileChange[] = []
  let budget = DIFF_NODE_CAP
  let truncated = false
  let level: TreePair[] = [{ path: '', base: baseTreeOid, head: headTreeOid }]

  while (level.length > 0 && !truncated) {
    const read = await mapPooled(level, TREE_READ_POOL, (pair) =>
      Promise.all([readTreeMap(sides.base, pair.base), readTreeMap(sides.head, pair.head)]),
    )
    const next: TreePair[] = []
    for (let i = 0; i < level.length && !truncated; i++) {
      const pair = level[i] as TreePair
      const [base, head] = read[i] as [Map<string, TreeEntry>, Map<string, TreeEntry>]
      for (const name of [...new Set([...base.keys(), ...head.keys()])].sort()) {
        const b = base.get(name)
        const h = head.get(name)
        if (b && h && b.oid === h.oid && b.mode === h.mode) continue
        if (budget <= 0) {
          truncated = true
          break
        }
        budget -= 1
        const path = pair.path ? `${pair.path}/${name}` : name
        if (isDir(b) || isDir(h)) {
          // A file on the side that is not a directory is its own change.
          if (b && !isDir(b)) changes.push(fileChange(path, b, undefined))
          if (h && !isDir(h)) changes.push(fileChange(path, undefined, h))
          next.push({ path, base: isDir(b) ? (b?.oid ?? null) : null, head: isDir(h) ? (h?.oid ?? null) : null })
        } else {
          changes.push(fileChange(path, b, h))
        }
      }
    }
    level = next
  }
  changes.sort((a, b) => a.path.localeCompare(b.path))
  return { changes, truncated }
}

/** A commit and its change set against its first parent (everything added for a root). */
export interface CommitChanges extends TreeDiff {
  readonly commit: CommitObject
}

/**
 * Load a commit and diff it against its first parent — `git show --first-parent` semantics,
 * so a merge commit shows what it brought into the branch it was made on.
 */
export async function loadCommitChanges(reader: ObjectReader, oid: string): Promise<CommitChanges> {
  const commit = await readCommit(reader, oid)
  const parent = commit.parents[0]
  const parentTree = parent ? (await readCommit(reader, parent)).tree : null
  const diff = await diffTrees({ base: reader, head: reader }, parentTree, commit.tree)
  return { commit, ...diff }
}
