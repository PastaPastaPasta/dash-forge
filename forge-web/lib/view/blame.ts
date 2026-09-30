/**
 * Blame (F-5): each line of a file at a commit, with the commit that last changed it, computed in
 * the browser over the file's first-parent history ({@link pathVersions}: the push-time history
 * index's list of the file's versions when one covers the commit, else the same walk and session
 * memo as the History page), in the manner of `git blame --first-parent`. With the index, each
 * version is one blob read (a few read ahead at once) and no commit or tree is read.
 *
 * Renames are followed as git blame follows them: where the history of the path ends at the commit
 * that added it, that commit's own rename detection (`git diff -M`, {@link detectRenames}: exact,
 * then 50% similar) names the file it came from, and the walk goes on there. When the change is too
 * large for this browser to check (its tree diff or rename read budget), the lines stay unresolved
 * rather than being given the adding commit (QW-005: dash's validation.cpp, renamed from main.cpp
 * with edits, had 921 lines on the rename). Not always git's answer otherwise: the line alignment
 * is a port of xdiff's with git's change compaction, so on rare edits a line can go to another
 * commit than git gives it. `git blame` is the authoritative answer.
 *
 * Bounded: files over {@link BLAME_MAX_BYTES} are refused; a run compares at most
 * {@link BLAME_MAX_VERSIONS} versions and examines {@link BLAME_MAX_COMMITS} commits. When it stops
 * there, the lines still open are left unattributed ({@link BlameHunk.unresolved}: last changed by
 * the oldest version reached or an older commit), never given that version's commit as if it were
 * theirs (QW-005: 3,098 of dash's validation.cpp lines once were), and the result's cursor
 * continues the walk from there. Each comparison is the line diff's own bounded Myers. Between
 * versions the walk yields to the event loop and reports progress, and an AbortSignal stops it.
 */

import { ObjectTooLargeError } from '../browse'
import { BlameState, lineMap } from './blame-core'
import { diffTrees, historyWalker, type LogEntry, type PrefixReader, type WalkOptions } from './commit-log'
import { decodeTextBlob } from './git-objects'
import { commitVia, entryMode, entryOid, isFileMode, logEntryOf, PATH_WALK_CAP, pathEntryAt, pathVersions } from './path-history'
import { detectRenames } from './renames'
import { readBlob, type ObjectReader } from './tree-nav'

/** Largest file blamed (the spec's ≤ 2 MiB). */
export const BLAME_MAX_BYTES = 2 * 1024 * 1024
/** Most versions of the file one run compares (the rest wait, unresolved, for "Continue"). */
export const BLAME_MAX_VERSIONS = 200
/** Most commits the walk examines in all (a file untouched for years must not walk all history). */
export const BLAME_MAX_COMMITS = 10_000
/** Versions whose blobs are read ahead while one is compared, when the history index names them. */
const BLAME_READ_AHEAD = 4

/** A run of consecutive lines blamed on one commit. */
export interface BlameHunk {
  /** First line (1-based) and count. */
  readonly start: number
  readonly count: number
  readonly oid: string
  /**
   * Not attributed: the walk stopped at `oid`'s version of the file ({@link BlameResult.boundary})
   * with these lines in it, so `oid` or an older commit last changed them. Which one is not known
   * until the walk goes on ({@link BlameResult.cursor}); `oid` is not their commit.
   */
  readonly unresolved?: true
}

/** Why a walk stopped with lines still unattributed. */
export type BlameStop =
  /** It compared its {@link BLAME_MAX_VERSIONS} versions (it can go on). */
  | 'versions'
  /** It examined its {@link BLAME_MAX_COMMITS} commits (it can go on). */
  | 'commits'
  /** Its signal stopped it (it can go on). */
  | 'stopped'
  /** It reached the commit that added the path, a change too large to check for a rename (it cannot go on). */
  | 'rename'

/** Where a walk stopped with lines still unattributed. */
export interface BlameBoundary {
  /** The oldest version reached: each unattributed line is in it, so it or an older commit last changed the line. */
  readonly oid: string
  readonly reason: BlameStop
  /** Lines still unattributed. */
  readonly lines: number
}

export interface BlameResult {
  readonly lines: readonly string[]
  readonly hunks: readonly BlameHunk[]
  /** The commits the hunks name (and only those): author, time and subject. */
  readonly commits: ReadonlyMap<string, LogEntry>
  /**
   * The walk stopped before every line reached the commit that last changed it: those lines are
   * {@link BlameHunk.unresolved}, never given a commit (QW-005), and `boundary` says where and why.
   */
  readonly partial: boolean
  readonly boundary: BlameBoundary | null
  /** Continues the walk from where it stopped (`blameFile`'s `resume`); null when it cannot go on. */
  readonly cursor: BlameCursor | null
  /** A change too large to align blamed its lines on the newer side. */
  readonly approximate: boolean
  readonly versions: number
  /** The renames the walk followed, newest first. */
  readonly renames: readonly BlameRename[]
}

/**
 * Where a stopped walk stands, to continue it (opaque to callers). It is never changed: a walk
 * continued from it steps a copy, so a continuation that fails leaves it as it was.
 */
export interface BlameCursor {
  readonly tipOid: string
  readonly path: string
  readonly tip: Omit<Version, 'oid'>
  readonly state: BlameState
  /** The oldest version compared (the lines still open are in its text), or null before the first. */
  readonly current: Version | null
  /** Where the next page of the path's versions starts (`current.oid` itself, skipped, when the walk stopped mid-page). */
  readonly start: string
  /** The path at `start` (an older name, past a followed rename). */
  readonly at: string
  readonly renames: readonly BlameRename[]
  readonly seen: ReadonlyMap<string, LogEntry>
  readonly approximate: boolean
  readonly versions: number
  readonly examined: number
}

/** A version of the file: the commit that made it, its text, and its `mode:oid`. */
interface Version {
  readonly oid: string
  readonly text: string
  readonly blob: string
}

/** `commit` moved the file from `from` to `to` (with or without edits, as `git diff -M` pairs them). */
export interface BlameRename {
  readonly commit: string
  readonly from: string
  readonly to: string
}

export interface BlameProgress {
  /** Commits examined so far while looking for the file's versions (none while the history index lists them). */
  readonly examined: number
  /** Versions the push-time history index listed so far, in this run (none: the history is walked). */
  readonly indexed: number
  /** Versions of the file compared so far (over every run of a continued walk). */
  readonly versions: number
  /** The most versions this run compares before it stops: the versions it started from plus its cap. */
  readonly versionLimit: number
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
 * A blame run stopped by its signal, carrying what it had attributed so far (L-23): the lines of
 * the versions compared are final; the rest are {@link BlameHunk.unresolved} at the oldest version
 * reached, and its `cursor` continues the walk.
 */
export class BlameStoppedError extends Error {
  constructor(readonly partial: BlameResult | null) {
    super('blame stopped')
    this.name = 'BlameStoppedError'
  }
}

/**
 * Blame `path` at `tipOid`. `onProgress` is told as the history is searched (commits examined)
 * and after each version compared; `signal` stops the walk, rejecting with a
 * {@link BlameStoppedError} that carries the partial result. `resume`: a partial result's
 * {@link BlameResult.cursor}, to go on from where that walk stopped (with this run's caps).
 */
export async function blameFile(
  reader: PrefixReader,
  tipOid: string,
  path: string,
  {
    walker = historyWalker(reader),
    signal,
    onProgress,
    maxVersions = BLAME_MAX_VERSIONS,
    maxCommits = BLAME_MAX_COMMITS,
    pageCap = PATH_WALK_CAP,
    resume,
  }: WalkOptions & {
    readonly onProgress?: (p: BlameProgress) => void
    readonly maxVersions?: number
    readonly maxCommits?: number
    /** Commits one History page examines (the History page's cap; smaller in tests). */
    readonly pageCap?: number
    readonly resume?: BlameCursor
  } = {},
): Promise<BlameResult> {
  if (resume !== undefined && (resume.tipOid !== tipOid || resume.path !== path)) throw new Error('the blame to continue is of another file or commit')
  let tip: BlameCursor['tip']
  if (resume === undefined) {
    const entry = await pathEntryAt(reader, walker, tipOid, path)
    if (!isFileEntry(entry)) throw new BlameRefusedError('not-a-file')
    tip = { text: await textOf(reader, entry), blob: entry }
  } else {
    tip = resume.tip
  }
  const state = resume?.state.clone() ?? new BlameState(tip.text)
  // Every commit the walk met, so the hunks' owners can be looked up at the end.
  const seen = new Map<string, LogEntry>(resume?.seen)
  // Versions' texts read ahead (the index names versions before they are compared, so their reads
  // overlap). Each is dropped once compared: at most BLAME_READ_AHEAD texts are held, not a page.
  const texts = new Map<string, Promise<string>>()
  const textFor = (blob: string): Promise<string> => {
    let t = texts.get(blob)
    if (t === undefined) {
      t = textOf(reader, blob)
      // A read ahead that fails is reported when its version is reached, not before.
      t.catch(() => undefined)
      texts.set(blob, t)
    }
    return t
  }
  let approximate = resume?.approximate ?? false
  let versions = resume?.versions ?? 0
  const versionLimit = versions + maxVersions
  // Why the walk stopped with lines open: null while it goes on, and when it reached their commits.
  let stop: BlameStop | null = null

  // The versions come from the path's History, page by page: the commits that changed it. The
  // newest of them is at or before the tip, so its text is the tip's.
  let start: string | null = resume?.start ?? tipOid
  let current: Version | null = resume?.current ?? null
  // The tip stood in for a version no capped walk found: a continuation still looks for the first.
  let standIn = false
  let at = resume?.at ?? path
  // Where a continuation starts: `start` between pages; mid-page, the version compared last.
  let resumeAt: string | null = start
  const renames: BlameRename[] = [...(resume?.renames ?? [])]
  // A page stops at its own cap without filling up (a file untouched for thousands of commits);
  // the walk goes on from where it stopped, within this run's commit budget.
  let examined = 0
  let indexed = 0
  const examinedBefore = resume?.examined ?? 0
  const report = (searched: number): void =>
    onProgress?.({ examined: examinedBefore + examined + searched, indexed, versions, versionLimit, pending: state.pending, total: state.lines.length })
  // The tip as the oldest version reached, when no version was found (every line unresolved there).
  const standInTip = async (): Promise<Version> => {
    seen.set(tipOid, logEntryOf(tipOid, await commitVia(reader, walker, tipOid)))
    standIn = true
    return { oid: tipOid, text: tip.text, blob: tip.blob }
  }
  // The result: the lines attributed so far, and the rest unresolved at the oldest version reached.
  const resultOf = (reason: BlameStop | null): BlameResult => {
    const boundary: BlameBoundary | null =
      state.pending === 0 || reason === null || current === null ? null : { oid: current.oid, reason, lines: state.pending }
    const hunks = toHunks(state.owner, boundary?.oid)
    const commits = new Map(hunks.map((h) => [h.oid, seen.get(h.oid) as LogEntry]))
    const cursor: BlameCursor | null =
      boundary === null || reason === 'rename' || resumeAt === null
        ? null
        : // Built once the run is over, so it holds this run's objects as they are: a continuation copies what it changes.
          { tipOid, path, tip, state, current: standIn ? null : current, start: resumeAt, at, renames, seen, approximate, versions, examined: examinedBefore + examined }
    return { lines: state.lines, hunks, commits, partial: boundary !== null, boundary, cursor, approximate, versions, renames }
  }
  try {
    outer: while (start !== null && state.pending > 0) {
      if (examined >= maxCommits) {
        stop = 'commits'
        break
      }
      const page = await pathVersions(reader, start, at, {
        walker,
        signal,
        cap: Math.min(pageCap, maxCommits - examined),
        // Every version the index lists, at once: no later page to check the trees for again.
        listLimit: maxVersions + 1,
        onExamined: report,
      })
      examined += page.examined
      indexed += page.indexed
      for (const [i, e] of page.entries.entries()) {
        signal?.throwIfAborted()
        // A continuation's first page starts at the version the last run compared: not compared twice.
        if (e.oid === current?.oid) continue
        seen.set(e.oid, e)
        // No read ahead once every line has its commit: those versions would never be compared.
        if (state.pending > 0) {
          for (const ahead of page.entries.slice(i + 1, i + 1 + BLAME_READ_AHEAD)) {
            if (ahead.entry !== undefined && isFileEntry(ahead.entry)) void textFor(ahead.entry)
          }
        }
        if (current === null) {
          current = { oid: e.oid, text: tip.text, blob: tip.blob }
          resumeAt = e.oid
        } else {
          // `current.oid` changed the file from this version's text to `current.text`. A version
          // that was a directory or a submodule there means `current.oid` made the file.
          let older = e.entry ?? (await pathEntryAt(reader, walker, e.oid, at))
          if (!isFileEntry(older)) break outer
          let text: string
          try {
            text = await textFor(older)
          } catch (err) {
            // The index named this version's blob. When it cannot be read as the file's text (not
            // a blob here, not in this repo), read the version from the trees instead; only what
            // the trees name can refuse Blame.
            if (e.entry === undefined || signal?.aborted === true) throw err
            const fromTrees = await pathEntryAt(reader, walker, e.oid, at)
            if (fromTrees === e.entry) throw err
            if (!isFileEntry(fromTrees)) break outer
            older = fromTrees
            text = await textFor(older)
          } finally {
            texts.delete(older)
            if (e.entry !== undefined) texts.delete(e.entry)
          }
          // The step, the version it reaches and where a continuation starts change together, with
          // no await between them: a stop at any await leaves them agreeing.
          if (state.step(current.oid, lineMap(text, current.text)).approximate) approximate = true
          current = { oid: e.oid, text, blob: older }
          // Past the page's last version, a continuation starts where the page stopped, not over its commits again.
          resumeAt = i === page.entries.length - 1 && page.next !== null ? page.next : e.oid
          versions += 1
          report(0)
          await yieldToEventLoop()
        }
        if (state.pending === 0) break outer
        if (versions >= versionLimit) {
          stop = 'versions'
          break outer
        }
      }
      start = page.next
      // At the end of the path's History a continuation starts at its last version (skipped), which
      // leads to the rename check again.
      if (start !== null) resumeAt = start
      // The History ended at the commit that added the path: follow it back through a rename there,
      // as blame in git does.
      if (start === null && current !== null && state.pending > 0) {
        const from = await renamedFrom(reader, walker, current.oid, at)
        if (from === 'unknown') stop = 'rename'
        else if (from !== null) {
          renames.push({ commit: current.oid, from: from.path, to: at })
          at = from.path
          start = from.parent
          resumeAt = start
        }
      }
    }
  } catch (e) {
    if (!signal?.aborted) throw e
    // Stopped before any version: the tip stands in, and a continuation keeps what was searched.
    if (current === null) current = await standInTip().catch(() => null)
    throw new BlameStoppedError(current === null ? null : resultOf('stopped'))
  } finally {
    walker.flush?.()
  }
  // No version at all: the path is unchanged in every commit the capped walk examined, so the tip
  // stands in as the oldest version reached, and every line is unresolved there.
  if (current === null) {
    current = await standInTip()
    stop ??= 'commits'
  }
  // The walk reached the commit that added the file (or its first version as a file): what is still
  // open was added there, exactly git's answer. Stopped short of that, it stays unresolved.
  if (stop === null) state.finish(current.oid)
  onProgress?.({ examined: examinedBefore + examined, indexed, versions, versionLimit, pending: state.pending, total: state.lines.length })
  return resultOf(stop)
}

/**
 * Where `commit`, which added `path`, renamed it from: the deleted file `git diff -M` pairs with it
 * over the commit's change against its first parent (exact first, then at least 50% similar; git
 * blame asks the same of the adding commit). Null when it paired none: `commit` wrote the file.
 * `'unknown'`: the change is past what this browser checks (the tree diff's cap, or the rename
 * detection's read budget), so whether it was a rename is not known.
 */
async function renamedFrom(
  reader: ObjectReader,
  walker: ObjectReader,
  commitOid: string,
  path: string,
): Promise<{ readonly path: string; readonly parent: string } | null | 'unknown'> {
  const commit = await commitVia(reader, walker, commitOid)
  const parent = commit.parents[0]
  if (parent === undefined) return null
  const sides = { base: walker, head: walker }
  const diff = await diffTrees(sides, (await commitVia(reader, walker, parent)).tree, commit.tree)
  // Only this path as a destination (git blame's `single_follow`), from every file the commit deleted.
  const added = diff.changes.find((c) => c.path === path && c.status === 'added')
  const deleted = diff.changes.filter((c) => c.status === 'deleted' && c.baseMode !== null && isFileMode(c.baseMode))
  if (added === undefined) return diff.truncated ? 'unknown' : null
  const { changes, limited } = await detectRenames(sides, [added, ...deleted])
  const renamed = changes.find((c) => c.status === 'renamed' && c.path === path)
  if (renamed?.oldPath !== undefined) return { path: renamed.oldPath, parent }
  return diff.truncated || limited !== null ? 'unknown' : null
}

/**
 * Consecutive lines with one owner, as hunks. A null owner is a line not attributed yet: it goes in
 * an {@link BlameHunk.unresolved} hunk at `boundary`, the oldest version the walk reached.
 */
export function toHunks(owner: readonly (string | null)[], boundary?: string): BlameHunk[] {
  const hunks: { start: number; count: number; oid: string; unresolved?: true }[] = []
  owner.forEach((o, i) => {
    const oid = o ?? boundary
    if (oid === undefined) throw new Error('a line without a commit, and no boundary to mark it at')
    const unresolved = o === null
    const last = hunks[hunks.length - 1]
    if (last?.oid === oid && (last.unresolved === true) === unresolved) last.count += 1
    else hunks.push({ start: i + 1, count: 1, oid, ...(unresolved ? { unresolved: true as const } : {}) })
  })
  return hunks
}
