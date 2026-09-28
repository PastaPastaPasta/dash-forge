/**
 * Commit log + tree diff (view glue) — walk history and compute per-file changes over the
 * browse plane. Each commit/tree is a ranged, hash-verified object read; the log follows first
 * parent, and the diff compares two trees level by level with a node cap so a huge commit
 * can't runaway-fetch. Line-level patches over the resulting change set live in `file-diff.ts`.
 */

import { MissingObjectError, MODE_GITLINK, MODE_TREE, type BrowseReader, type GitObject } from '../browse'
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
  /** The full oid, when the URL named the commit by a short id. */
  readonly oid: string
}

/**
 * Load a commit and diff it against its first parent — `git show --first-parent` semantics,
 * so a merge commit shows what it brought into the branch it was made on.
 */
/** Why a commit id in a URL names no single commit. */
export class CommitIdError extends Error {
  constructor(
    readonly kind: 'invalid' | 'not-found' | 'not-a-commit' | 'ambiguous',
    readonly input: string,
    /** For `ambiguous`: some of the commits the prefix matches. */
    readonly candidates: readonly string[] = [],
  ) {
    super(
      kind === 'invalid'
        ? `"${input}" is not a commit id: use 4 to 40 hexadecimal characters`
        : kind === 'not-found'
          ? `No commit ${input} in this repo`
          : kind === 'not-a-commit'
            ? `${input} names a file or directory in this repo, not a commit`
            : `${input} is ambiguous: ${candidates.length > 1 && candidates.length < AMBIGUOUS_SHOWN ? candidates.length : 'several'} objects start with it; use more characters`,
    )
    this.name = 'CommitIdError'
  }
}

const AMBIGUOUS_SHOWN = 5

/** The slice of a reader short-id resolution needs (a {@link BrowseReader}). */
export interface PrefixReader extends ObjectReader {
  findByPrefix?(prefix: string, limit?: number): string[]
  /** An object's type from its entry header, or null for a delta entry. */
  objectType?(oidHex: string): Promise<GitObject['type'] | null>
  /** Some of the repo's packs are missing (a partial clone): absent ids may still exist. */
  readonly incomplete?: boolean
}

/** Short-id candidates examined; a prefix matching more is reported ambiguous. */
const PREFIX_SCAN = 16

/**
 * Resolve a commit id as git does: a full 40-hex oid as is, or an unambiguous prefix of at
 * least 4 hex digits (odd lengths too — the 7-character form the UI shows) through the
 * locator's sorted OID index. Only commits count: a prefix shared by one commit and one blob
 * resolves to the commit, as `git show <prefix>^{commit}` does.
 */
export async function resolveCommitOid(reader: PrefixReader, input: string): Promise<string> {
  const id = input.trim().toLowerCase()
  if (!/^[0-9a-f]{4,40}$/.test(id)) throw new CommitIdError('invalid', input)
  if (id.length === 40) return id
  const matches = reader.findByPrefix?.(id, PREFIX_SCAN) ?? []
  if (matches.length === 0) throw notFound(reader, input)
  // Only the entry header is read per candidate: a short id matching a 40 MB blob must not
  // download it just to learn it is not a commit.
  const typeOf = (oid: string): Promise<GitObject['type'] | null> =>
    reader.objectType ? reader.objectType(oid) : reader.readObject(oid).then((o) => o.type)
  const commits: string[] = []
  let unreadable: unknown = null
  for (const oid of matches) {
    try {
      if ((await typeOf(oid)) === 'commit') commits.push(oid)
    } catch (e) {
      unreadable = e
    }
  }
  if (commits.length === 1 && matches.length < PREFIX_SCAN) return commits[0] as string
  if (commits.length > 1 || matches.length >= PREFIX_SCAN) {
    throw new CommitIdError('ambiguous', input, commits.slice(0, AMBIGUOUS_SHOWN))
  }
  // No match is a commit. If some could not even be read, that is the real answer.
  if (unreadable !== null) throw unreadable
  throw new CommitIdError('not-a-commit', input)
}

/** "No such commit", unless packs are missing, in which case it may be in one of those. */
function notFound(reader: PrefixReader, input: string): Error {
  return reader.incomplete
    ? new MissingObjectError(`No commit ${input} in the packs this browser could load; some of this repo's packs could not be fetched, and it may be in one of them.`)
    : new CommitIdError('not-found', input)
}

export async function loadCommitChanges(reader: PrefixReader, id: string): Promise<CommitChanges> {
  const oid = await resolveCommitOid(reader, id)
  let commit: CommitObject
  try {
    commit = await readCommit(reader, oid)
  } catch (e) {
    // A well-formed full id the repo does not hold: say so, not "object not in locator". A
    // partial clone's own error already names the packs it could not load; keep it.
    if (e instanceof MissingObjectError) throw e
    if (reader.locate?.(oid) === null) throw notFound(reader, id)
    if (e instanceof Error && / is not a commit$/.test(e.message)) throw new CommitIdError('not-a-commit', id)
    throw e
  }
  const parent = commit.parents[0]
  const parentTree = parent ? (await readCommit(reader, parent)).tree : null
  const diff = await diffTrees({ base: reader, head: reader }, parentTree, commit.tree)
  return { commit, oid, ...diff }
}

/** The commit that last changed a directory entry, for the file list's lazy commit column. */
export interface LastCommit {
  readonly oid: string
  readonly subject: string
  /** Author time (ms). */
  readonly when: number
}

/**
 * How far back the commit column looks (first parent). An entry no commit in the window changed
 * is left out of the answer, and the view says it is older than the window (L-41) rather than
 * guessing at older history.
 */
export const LAST_COMMIT_WALK = 400

/**
 * A reader for walks over many commits: the reader's own read-ahead walker when it has one (one
 * ranged read per block of neighbouring commits, not one per commit), else the reader. Pass one
 * walker to several walks of the same history (the repo home's commit count and commit column)
 * so they share its blocks instead of each fetching them.
 */
export function historyWalker(reader: ObjectReader): ObjectReader & { flush?(): void } {
  return reader.forHistoryWalk?.() ?? reader
}

/** Options of a history walk. */
export interface WalkOptions {
  /** The walker to read through ({@link historyWalker}); default: a new one for this walk. */
  readonly walker?: ObjectReader & { flush?(): void }
  /** Stops the walk (it rejects with the signal's reason) before its next step. */
  readonly signal?: AbortSignal
}

/**
 * For each entry of the tree at `dirPath` (`''` = root), the newest first-parent commit whose
 * change touched it, walking at most `limit` commits. Names no commit in the window changed are
 * absent (older history is not guessed at). Each step reads one commit and the trees along
 * `dirPath`, through a read-ahead walker; the reader memoizes objects, so shared subtrees cost
 * once. `onFound` is told the answer so far each time a step settles more names, so a view can
 * fill in as the walk goes.
 */
export async function lastCommitsForDir(
  reader: ObjectReader,
  tipOid: string,
  dirPath: string,
  names: readonly string[],
  {
    limit = LAST_COMMIT_WALK,
    onFound,
    walker = historyWalker(reader),
    signal,
  }: WalkOptions & { readonly limit?: number; readonly onFound?: (found: ReadonlyMap<string, LastCommit>) => void } = {},
): Promise<Map<string, LastCommit>> {
  const segments = dirPath.split('/').filter((s) => s !== '')
  const dirOf = async (treeOid: string): Promise<Map<string, string> | null> => {
    let oid = treeOid
    for (const seg of segments) {
      const next = (await readTree(walker, oid)).find((e) => e.name === seg && e.mode === MODE_TREE)
      if (!next) return null
      oid = next.oid
    }
    return new Map((await readTree(walker, oid)).map((e) => [e.name, `${e.mode}:${e.oid}`]))
  }
  const out = new Map<string, LastCommit>()
  const open = new Set(names)
  try {
    let oid = tipOid
    let commit = await readCommit(walker, tipOid)
    let here = await dirOf(commit.tree)
    for (let steps = 0; here !== null && open.size > 0 && steps < limit; steps++) {
      signal?.throwIfAborted()
      const parentOid = commit.parents[0]
      const parent = parentOid !== undefined ? await readCommit(walker, parentOid) : null
      const there = parent !== null ? await dirOf(parent.tree) : null
      const before = out.size
      for (const name of [...open]) {
        if (here.get(name) !== there?.get(name)) {
          out.set(name, { oid, subject: commitSubject(commit.message), when: commit.author.when })
          open.delete(name)
        }
      }
      if (out.size > before) onFound?.(new Map(out))
      if (parent === null || parentOid === undefined) break
      oid = parentOid
      commit = parent
      here = there
    }
    return out
  } finally {
    walker.flush?.()
  }
}

/**
 * First-parent commits reachable from `tipOid`, counting at most `cap` (the ref bar's
 * `n commits`; `capped` means there are at least that many).
 */
export async function countCommits(
  reader: ObjectReader,
  tipOid: string,
  cap = 1000,
  { walker = historyWalker(reader), signal }: WalkOptions = {},
): Promise<{ count: number; capped: boolean }> {
  let count = 0
  let oid: string | undefined = tipOid
  const seen = new Set<string>()
  try {
    while (oid !== undefined && count < cap && !seen.has(oid)) {
      signal?.throwIfAborted()
      seen.add(oid)
      count += 1
      oid = (await readCommit(walker, oid)).parents[0]
    }
  } finally {
    walker.flush?.()
  }
  return { count, capped: oid !== undefined && count >= cap }
}
