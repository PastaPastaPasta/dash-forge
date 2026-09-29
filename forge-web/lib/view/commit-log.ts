/**
 * Commit log + tree diff (view glue) — walk history and compute per-file changes over the
 * browse plane. Each commit/tree is a ranged, hash-verified object read; the log follows first
 * parent, and the diff compares two trees level by level with a node cap so a huge commit
 * can't runaway-fetch. Line-level patches over the resulting change set live in `file-diff.ts`.
 */

import { MissingObjectError, MODE_GITLINK, MODE_TREE, type GitObject } from '../browse'
import { commitSubject, type CommitObject, type TagObject, type TreeEntry } from './git-objects'
import { mapPooled } from './pool'
import { ObjectTypeError, peelToCommit, readCommit, readTree, type ObjectReader, type Peeled } from './tree-nav'

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
  /** The full oid, when the URL named the commit by a short id (or by a tag). */
  readonly oid: string
  /** The annotated tags the URL's id was peeled through to reach the commit (outermost first). */
  readonly tags: readonly TagObject[]
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
    /** For `not-a-commit`: what the id names instead (`tree`, `blob`), when known. */
    readonly actual?: GitObject['type'],
    /** For `not-a-commit`: the id names an annotated tag of that object. */
    readonly viaTag = false,
  ) {
    super(
      kind === 'invalid'
        ? `"${input}" is not a commit id: use 4 to 40 hexadecimal characters`
        : kind === 'not-found'
          ? `No commit ${input} in this repo`
          : kind === 'not-a-commit'
            ? `${input} ${viaTag ? 'is a tag of' : 'names'} ${nounOf(actual)} in this repo, not a commit`
            : `${input} is ambiguous: ${candidates.length > 1 && candidates.length < AMBIGUOUS_SHOWN ? candidates.length : 'several'} objects start with it; use more characters`,
    )
    this.name = 'CommitIdError'
  }
}

/** How a non-commit object reads in a sentence. */
function nounOf(type: GitObject['type'] | undefined): string {
  return type === 'blob' ? 'a file' : type === 'tree' ? 'a directory' : 'an object'
}

const AMBIGUOUS_SHOWN = 5

/** The slice of a reader short-id resolution needs (a `BrowseReader`). */
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
 * locator's sorted OID index. Only commits and annotated tags (which peel to one) count: a
 * prefix shared by one commit and one blob resolves to the commit, as `git show <prefix>^{commit}`
 * does. The result may be a tag's id: peel it ({@link peelToCommit}).
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
  let other: GitObject['type'] | undefined
  let unreadable: unknown = null
  for (const oid of matches) {
    try {
      const type = await typeOf(oid)
      if (type === 'commit' || type === 'tag') commits.push(oid)
      else other ??= type ?? undefined
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
  throw new CommitIdError('not-a-commit', input, [], other)
}

/** "No such commit", unless packs are missing, in which case it may be in one of those. */
function notFound(reader: PrefixReader, input: string): Error {
  return reader.incomplete
    ? new MissingObjectError(`No commit ${input} in the packs this browser could load; some of this repo's packs could not be fetched, and it may be in one of them.`)
    : new CommitIdError('not-found', input)
}

export async function loadCommitChanges(reader: PrefixReader, id: string): Promise<CommitChanges> {
  const named = await resolveCommitOid(reader, id)
  let peeled: Peeled
  let commit: CommitObject
  try {
    // A tag's id (the tags list, a release) shows the commit it names, as `git show` does.
    peeled = await peelToCommit(reader, named)
    commit = await readCommit(reader, peeled.oid)
  } catch (e) {
    // A well-formed full id the repo does not hold: say so, not "object not in locator". A
    // partial clone's own error already names the packs it could not load; keep it.
    if (e instanceof MissingObjectError) throw e
    if (reader.locate?.(named) === null) throw notFound(reader, id)
    if (e instanceof ObjectTypeError) throw new CommitIdError('not-a-commit', id, [], e.actual, e.oid !== named)
    throw e
  }
  const parent = commit.parents[0]
  const parentTree = parent ? (await readCommit(reader, parent)).tree : null
  const diff = await diffTrees({ base: reader, head: reader }, parentTree, commit.tree)
  return { commit, oid: peeled.oid, tags: peeled.tags, ...diff }
}

/** The commit that last changed a directory entry, for the file list's lazy commit column. */
export interface LastCommit {
  readonly oid: string
  readonly subject: string
  /** Author time (ms). */
  readonly when: number
}

/**
 * How far one step of the commit column's history walk looks (first parent), when no history
 * index answers. An entry no walked commit changed reads "not changed since <the oldest walked
 * commit's date>", and "Search older history" walks this many more.
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
 * Where a history walk stands: the commit it will compare next, so a later step ("Search older
 * history") continues from there instead of starting over.
 */
export interface WalkCursor {
  readonly oid: string
  readonly commit: CommitObject
  /** Its tree's entries at the listed directory (`mode:oid` by name), or null where it has none. */
  readonly here: ReadonlyMap<string, string> | null
}

/** What one step of {@link lastCommitsForDir} found. */
export interface DirWalk {
  /** Each settled name's last commit. */
  readonly found: Map<string, LastCommit>
  /** Where to continue, or null when the walk reached the root (or the directory's creation). */
  readonly next: WalkCursor | null
  /** Author time (ms) of the oldest commit this step compared. */
  readonly oldestWhen: number
  /** The tip a history index covered, where the walk stopped to let the index answer. */
  readonly indexTip: string | null
}

/**
 * For each entry of the tree at `dirPath` (`''` = root), the newest first-parent commit whose
 * change touched it, walking at most `limit` commits from `tipOid` (or from `from`, a previous
 * step's cursor). Names no commit in the window changed are absent (older history is not guessed
 * at). Each step reads one commit and the trees along `dirPath`, through a read-ahead walker;
 * the reader memoizes objects, so shared subtrees cost once. `onFound` is told the answer so far
 * each time a step settles more names, so a view can fill in as the walk goes.
 *
 * `stopAt(oid)`: the walk stops BEFORE comparing a commit a history index covers (it returns that
 * commit as `indexTip`), so only the commits between the index's tip and `tipOid` are read.
 */
export async function lastCommitsForDir(
  reader: ObjectReader,
  tipOid: string,
  dirPath: string,
  names: readonly string[],
  opts: WalkOptions & {
    readonly limit?: number
    readonly onFound?: (found: ReadonlyMap<string, LastCommit>) => void
    readonly from?: WalkCursor
    readonly stopAt?: (oid: string) => boolean
  } = {},
): Promise<Map<string, LastCommit>> {
  return (await walkDir(reader, tipOid, dirPath, names, opts)).found
}

/** {@link lastCommitsForDir}, reporting where the walk stopped. */
export async function walkDir(
  reader: ObjectReader,
  tipOid: string,
  dirPath: string,
  names: readonly string[],
  {
    limit = LAST_COMMIT_WALK,
    onFound,
    walker = historyWalker(reader),
    signal,
    from,
    stopAt,
  }: WalkOptions & {
    readonly limit?: number
    readonly onFound?: (found: ReadonlyMap<string, LastCommit>) => void
    readonly from?: WalkCursor
    readonly stopAt?: (oid: string) => boolean
  } = {},
): Promise<DirWalk> {
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
  const found = new Map<string, LastCommit>()
  const open = new Set(names)
  let oldestWhen = 0
  try {
    let oid = from?.oid ?? tipOid
    let commit = from?.commit ?? (await readCommit(walker, tipOid))
    let here = from !== undefined ? from.here : await dirOf(commit.tree)
    for (let steps = 0; here !== null && open.size > 0; steps++) {
      signal?.throwIfAborted()
      if (stopAt?.(oid)) return { found, next: { oid, commit, here }, oldestWhen, indexTip: oid }
      if (steps >= limit) return { found, next: { oid, commit, here }, oldestWhen, indexTip: null }
      oldestWhen = commit.author.when
      const parentOid = commit.parents[0]
      const parent = parentOid !== undefined ? await readCommit(walker, parentOid) : null
      const there = parent !== null ? await dirOf(parent.tree) : null
      const before = found.size
      for (const name of [...open]) {
        if (here.get(name) !== there?.get(name)) {
          found.set(name, { oid, subject: commitSubject(commit.message), when: commit.author.when })
          open.delete(name)
        }
      }
      if (found.size > before) onFound?.(new Map(found))
      if (parent === null || parentOid === undefined) break
      oid = parentOid
      commit = parent
      here = there
    }
    return { found, next: null, oldestWhen, indexTip: null }
  } finally {
    walker.flush?.()
  }
}

/**
 * The commit column of a listing (L-41): each entry's last commit, `done` once the lookup has
 * stopped, and `failed` when it stopped on an error.
 *
 * `source`: `index` when the push-time history index answered every name (no walk), `walk`
 * otherwise. After a walk, `olderThan` is the date bound of every name still without a commit
 * ("not changed since"), and `more` continues the walk {@link LAST_COMMIT_WALK} commits further.
 */
export interface LastCommitColumn {
  readonly found: ReadonlyMap<string, LastCommit>
  readonly done: boolean
  readonly failed: boolean
  readonly source?: 'index' | 'walk'
  /** Author time (ms) of the oldest commit walked, when names are still open. */
  readonly olderThan?: number
  /** Walk further back; absent when history is exhausted or every name is settled. */
  readonly more?: () => void
}

/**
 * The push-time history index as the column and the count read it (a `HistorySource`): which
 * tips an index covers, and the index of one of them.
 */
export interface IndexedHistory {
  covers(tip: string): boolean
  load(tip: string): Promise<{ readonly paths: ReadonlyMap<string, LastCommit>; readonly commitCount: number }>
}

/**
 * The column of the listing of `dirPath` at `tipOid`, reporting each state to `onState`,
 * starting empty.
 *
 * 1. A history index covering `tipOid` answers every name: no walk at all.
 * 2. Otherwise the walk runs from `tipOid` and stops at the first commit an index covers; the
 *    index answers the names the walk did not settle. Only the commits in between are read.
 * 3. Otherwise the walk takes {@link LAST_COMMIT_WALK} steps, and `more` continues it.
 *
 * A failed step keeps what it found before the failure. Nothing is reported once `signal`
 * aborts.
 */
export function walkCommitColumn(
  reader: ObjectReader,
  tipOid: string,
  names: readonly string[],
  onState: (state: LastCommitColumn) => void,
  {
    walker,
    signal,
    limit = LAST_COMMIT_WALK,
    dirPath = '',
    history = null,
  }: WalkOptions & { readonly limit?: number; readonly dirPath?: string; readonly history?: IndexedHistory | null } = {},
): Promise<void> {
  const found = new Map<string, LastCommit>()
  const report = (state: Omit<LastCommitColumn, 'found'>): void => {
    if (signal?.aborted !== true) onState({ found: new Map(found), ...state })
  }
  const pathOf = (name: string): string => (dirPath === '' ? name : `${dirPath}/${name}`)
  const fromIndex = async (tip: string, open: readonly string[]): Promise<void> => {
    if (history === null || open.length === 0) return
    const { paths } = await history.load(tip)
    for (const name of open) {
      const c = paths.get(pathOf(name))
      if (c !== undefined) found.set(name, c)
    }
  }
  report({ done: false, failed: false })

  const step = async (from: WalkCursor | undefined): Promise<void> => {
    const open = names.filter((n) => !found.has(n))
    // A continued walk is under way again: its open cells read as pending, and no second
    // `more` is offered while it runs.
    if (from !== undefined) report({ done: false, failed: false, source: 'walk' })
    try {
      if (from === undefined && history?.covers(tipOid) === true) {
        await fromIndex(tipOid, open)
        report({ done: true, failed: false, source: 'index' })
        return
      }
      const walked = await walkDir(reader, tipOid, dirPath, open, {
        limit,
        walker,
        signal,
        ...(from !== undefined ? { from } : {}),
        ...(history !== null ? { stopAt: (oid: string) => history.covers(oid) } : {}),
        onFound: (next) => {
          for (const [k, v] of next) found.set(k, v)
          report({ done: false, failed: false, source: 'walk' })
        },
      })
      for (const [k, v] of walked.found) found.set(k, v)
      if (walked.indexTip !== null) {
        await fromIndex(walked.indexTip, names.filter((n) => !found.has(n)))
        report({ done: true, failed: false, source: 'walk' })
        return
      }
      const stillOpen = names.some((n) => !found.has(n))
      const next = walked.next
      report({
        done: true,
        failed: false,
        source: 'walk',
        ...(stillOpen ? { olderThan: walked.oldestWhen } : {}),
        ...(stillOpen && next !== null ? { more: () => void step(next) } : {}),
      })
    } catch {
      report({ done: true, failed: true, source: 'walk' })
    }
  }
  return step(undefined)
}

/**
 * The ref bar's `n commits`. `exact`: the count is every commit reachable from the tip, as
 * `git rev-list --count` gives it (a history index said so). Otherwise it is a lower bound shown
 * as `n+`: first-parent commits counted up to `cap`, or an index's count plus the commits walked
 * since its tip when one of them was a merge (a merge brings in commits the walk does not see).
 */
export interface CommitCount {
  readonly count: number
  readonly capped: boolean
  /** Counted by a history index (the pusher's claim), not only by walking. */
  readonly fromIndex?: boolean
}

/**
 * Count the commits of `tipOid`: from a history index covering it (exact), else by walking
 * first-parent at most `cap` commits and stopping at a commit an index covers (its count plus
 * the commits walked, exact when none of them is a merge).
 */
export async function countCommits(
  reader: ObjectReader,
  tipOid: string,
  cap = 1000,
  {
    walker = historyWalker(reader),
    signal,
    history,
  }: WalkOptions & { readonly history?: IndexedHistory | null } = {},
): Promise<CommitCount> {
  let count = 0
  let merges = false
  let oid: string | undefined = tipOid
  const seen = new Set<string>()
  try {
    while (oid !== undefined && count < cap && !seen.has(oid)) {
      signal?.throwIfAborted()
      if (history?.covers(oid) === true) {
        const base = (await history.load(oid)).commitCount
        return { count: base + count, capped: merges, fromIndex: true }
      }
      seen.add(oid)
      count += 1
      const commit = await readCommit(walker, oid)
      if (commit.parents.length > 1) merges = true
      oid = commit.parents[0]
    }
  } finally {
    walker.flush?.()
  }
  return { count, capped: oid !== undefined && count >= cap }
}
