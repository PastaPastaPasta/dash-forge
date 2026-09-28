/**
 * Blame (F-5): each line of a file at a commit, with the commit that last changed it, computed in
 * the browser over the file's first-parent history ({@link logPage} with a path, the same walk and
 * session memo as the History page), in the manner of `git blame --first-parent`.
 *
 * Not always git's answer: the line alignment is our Myers diff with git's change compaction on
 * top, not xdiff's own diff, so on some edits (a line that appears several times, moved around) a
 * line can be given to a different commit than git gives it; and a rename with edits is not
 * followed (git scores similarity; only exact renames are followed here). `git blame` is the
 * authoritative answer.
 *
 * Bounded: files over {@link BLAME_MAX_BYTES} are refused; at most {@link BLAME_MAX_VERSIONS}
 * versions are compared and {@link BLAME_MAX_COMMITS} commits examined, after which the lines
 * still open are attributed to the oldest version reached and the result says it is partial; each
 * comparison is the line diff's own bounded Myers. Between versions the walk yields to the event
 * loop and reports progress, and an AbortSignal stops it.
 */

import { ObjectTooLargeError } from '../browse'
import { BlameState, lineMap } from './blame-core'
import { diffTrees, historyWalker, type WalkOptions } from './commit-log'
import { decodeTextBlob, type CommitObject } from './git-objects'
import { commitVia, entryMode, entryOid, isFileMode, logPage, PATH_WALK_CAP, pathEntryAt } from './path-history'
import { readBlob, type ObjectReader } from './tree-nav'

/** Largest file blamed (the spec's ≤ 2 MiB). */
export const BLAME_MAX_BYTES = 2 * 1024 * 1024
/** Most versions of the file compared before the rest are attributed to the oldest reached. */
export const BLAME_MAX_VERSIONS = 200
/** Most commits the walk examines in all (a file untouched for years must not walk all history). */
export const BLAME_MAX_COMMITS = 10_000

/** A run of consecutive lines blamed on one commit. */
export interface BlameHunk {
  /** First line (1-based) and count. */
  readonly start: number
  readonly count: number
  readonly oid: string
}

export interface BlameResult {
  readonly lines: readonly string[]
  readonly hunks: readonly BlameHunk[]
  /** The commits the hunks name (and only those), with their commit objects (author, time, subject). */
  readonly commits: ReadonlyMap<string, CommitObject>
  /**
   * The walk stopped before every line reached the commit that added it (the version cap, the
   * commit budget, or a rename too large to look up): the oldest hunks may name a later commit than
   * the one that wrote them. `approximate`: a change too large to align blamed its lines on the
   * newer side.
   */
  readonly partial: boolean
  readonly approximate: boolean
  readonly versions: number
  /** Exact renames the walk followed, newest first. */
  readonly renames: readonly BlameRename[]
  /**
   * The commit that added the path also deleted a file of the same name elsewhere, with other
   * content: probably a rename with edits, which is not followed (the lines it brought are blamed
   * on it). Null otherwise.
   */
  readonly unfollowedRename: string | null
}

/** `commit` moved the file from `from` to `to` without changing it. */
export interface BlameRename {
  readonly commit: string
  readonly from: string
  readonly to: string
}

export interface BlameProgress {
  /** Versions of the file compared so far. */
  readonly versions: number
  /** Lines still without a commit. */
  readonly pending: number
  readonly total: number
}

type RefusedReason = 'too-large' | 'binary' | 'not-a-file'

const REFUSED: Readonly<Record<RefusedReason, string>> = {
  'too-large': `This file is over ${BLAME_MAX_BYTES / 1024 / 1024} MiB: blame it with git.`,
  binary: 'Binary files have no lines to blame.',
  'not-a-file': 'Not a file at this commit.',
}

export class BlameRefusedError extends Error {
  constructor(readonly reason: RefusedReason) {
    super(REFUSED[reason])
    this.name = 'BlameRefusedError'
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A `mode:oid` entry that is a file (not absent, a directory or a submodule). */
const isFileEntry = (entry: string | null): entry is string => entry !== null && isFileMode(entryMode(entry))

/**
 * A file version's text, or a refusal. Read through the page's reader, not the history walker: its
 * memo already holds the version the file view showed, and blobs gain nothing from read-ahead.
 */
async function textOf(reader: ObjectReader, entry: string): Promise<string> {
  let bytes: Uint8Array
  try {
    bytes = await readBlob(reader, entryOid(entry), BLAME_MAX_BYTES)
  } catch (e) {
    if (e instanceof ObjectTooLargeError) throw new BlameRefusedError('too-large')
    throw e
  }
  const text = decodeTextBlob(bytes)
  if (text === null) throw new BlameRefusedError('binary')
  return text
}

/**
 * Blame `path` at `tipOid`. `onProgress` is told after each version compared; `signal` stops the
 * walk (it rejects with the signal's reason).
 */
export async function blameFile(
  reader: ObjectReader,
  tipOid: string,
  path: string,
  {
    walker = historyWalker(reader),
    signal,
    onProgress,
    maxVersions = BLAME_MAX_VERSIONS,
    maxCommits = BLAME_MAX_COMMITS,
    pageCap = PATH_WALK_CAP,
  }: WalkOptions & {
    readonly onProgress?: (p: BlameProgress) => void
    readonly maxVersions?: number
    readonly maxCommits?: number
    /** Commits one History page examines (the History page's cap; smaller in tests). */
    readonly pageCap?: number
  } = {},
): Promise<BlameResult> {
  const entry = await pathEntryAt(reader, walker, tipOid, path)
  if (!isFileEntry(entry)) throw new BlameRefusedError('not-a-file')
  const tipText = await textOf(reader, entry)
  const state = new BlameState(tipText)
  // Every commit the walk met, so the hunks' owners can be looked up at the end.
  const seen = new Map<string, CommitObject>()
  let approximate = false
  let versions = 0
  let partial = false

  // The versions come from the path's History, page by page: the commits that changed it. The
  // newest of them is at or before the tip, so its text is the tip's.
  let start: string | null = tipOid
  let current: { oid: string; text: string; blob: string } | null = null
  let at = path
  const renames: BlameRename[] = []
  let unfollowedRename: string | null = null
  // A page stops at its own cap without filling up (a file untouched for thousands of commits);
  // the walk goes on from where it stopped, within the total commit budget.
  let examined = 0
  try {
    outer: while (start !== null && state.pending > 0) {
      if (examined >= maxCommits) {
        partial = true
        break
      }
      const page = await logPage(reader, start, { path: at, walker, signal, cap: Math.min(pageCap, maxCommits - examined) })
      examined += page.examined
      for (const e of page.entries) {
        signal?.throwIfAborted()
        seen.set(e.oid, e.commit)
        if (current === null) {
          current = { oid: e.oid, text: tipText, blob: entry }
        } else {
          // `current.oid` changed the file from this version's text to `current.text`. A version
          // that was a directory or a submodule there means `current.oid` made the file.
          const older = await pathEntryAt(reader, walker, e.oid, at)
          if (!isFileEntry(older)) break outer
          const text = await textOf(reader, older)
          if (state.step(current.oid, lineMap(text, current.text)).approximate) approximate = true
          current = { oid: e.oid, text, blob: older }
          versions += 1
          onProgress?.({ versions, pending: state.pending, total: state.lines.length })
          await yieldToEventLoop()
          if (versions >= maxVersions) {
            partial = true
            break outer
          }
        }
        if (state.pending === 0) break outer
      }
      start = page.next
      // The History ended at the commit that added the path: follow it back through an exact
      // rename there, as blame in git does (the same blob, deleted from another path by that commit).
      if (start === null && current !== null && state.pending > 0) {
        const from = await renamedFrom(reader, walker, current.oid, at, current.blob)
        if (from === 'unknown') partial = true
        else if ('path' in from) {
          renames.push({ commit: current.oid, from: from.path, to: at })
          at = from.path
          start = from.parent
        } else if (from.sameName !== null) {
          unfollowedRename = from.sameName
        }
      }
    }
  } finally {
    walker.flush?.()
  }
  // What is still open was added by the oldest version reached (exactly git's answer when the
  // walk reached the commit that added the file). No version at all: the path is unchanged in
  // every commit the capped walk examined, so the tip stands in, and the result says it is partial.
  if (current === null) {
    seen.set(tipOid, await commitVia(reader, walker, tipOid))
    current = { oid: tipOid, text: tipText, blob: entry }
    partial = true
  }
  state.finish(current.oid)
  onProgress?.({ versions, pending: 0, total: state.lines.length })
  const hunks = toHunks(state.owner as string[])
  const commits = new Map(hunks.map((h) => [h.oid, seen.get(h.oid) as CommitObject]))
  return { lines: state.lines, hunks, commits, partial, approximate, versions, renames, unfollowedRename }
}

/**
 * Where `commit` renamed `path` from, when it did so without changing it: a file its change
 * deleted whose blob is the one it added at `path` (preferring one with the same name, as rename
 * detection does). Otherwise `sameName`: a deleted file of the same name with other content (a
 * rename with edits, which similarity scoring would follow and this does not), or null.
 * `'unknown'`: the change is over the tree diff's cap.
 */
async function renamedFrom(
  reader: ObjectReader,
  walker: ObjectReader,
  commitOid: string,
  path: string,
  entry: string,
): Promise<{ readonly path: string; readonly parent: string } | { readonly sameName: string | null } | 'unknown'> {
  const commit = await commitVia(reader, walker, commitOid)
  const parent = commit.parents[0]
  if (parent === undefined) return { sameName: null }
  const diff = await diffTrees({ base: walker, head: walker }, (await commitVia(reader, walker, parent)).tree, commit.tree)
  const blob = entryOid(entry)
  const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
  const deleted = diff.changes.filter((c) => c.status === 'deleted' && c.baseMode !== null && isFileMode(c.baseMode))
  const exact = deleted.filter((c) => c.baseOid === blob)
  const source = exact.find((c) => baseName(c.path) === baseName(path)) ?? exact[0]
  if (source !== undefined) return { path: source.path, parent }
  if (diff.truncated) return 'unknown'
  return { sameName: deleted.find((c) => baseName(c.path) === baseName(path))?.path ?? null }
}

/** Consecutive lines with one owner, as hunks. */
export function toHunks(owner: readonly string[]): BlameHunk[] {
  const hunks: { start: number; count: number; oid: string }[] = []
  owner.forEach((oid, i) => {
    const last = hunks[hunks.length - 1]
    if (last?.oid === oid) last.count += 1
    else hunks.push({ start: i + 1, count: 1, oid })
  })
  return hunks
}
