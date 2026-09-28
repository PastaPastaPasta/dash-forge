/**
 * Blame (F-5): each line of a file at a commit, with the commit that last changed it, computed in
 * the browser over the file's first-parent history ({@link logPage} with a path, the same walk and
 * session memo as the History page), like `git blame --first-parent`.
 *
 * Bounded: files over {@link BLAME_MAX_BYTES} are refused, at most {@link BLAME_MAX_VERSIONS}
 * versions are compared (the lines still open after that are attributed to the oldest version
 * reached, and the result says it is partial), and each comparison is the line diff's own
 * bounded Myers. Between versions the walk yields to the event loop and reports progress, and an
 * AbortSignal stops it.
 */

import { MODE_GITLINK, MODE_TREE, ObjectTooLargeError } from '../browse'
import { BlameState, lineMap } from './blame-core'
import { historyWalker, type WalkOptions } from './commit-log'
import { decodeTextBlob, type CommitObject } from './git-objects'
import { commitVia, logPage, pathEntryAt } from './path-history'
import { readBlob, type ObjectReader } from './tree-nav'

/** Largest file blamed (the spec's ≤ 2 MiB). */
export const BLAME_MAX_BYTES = 2 * 1024 * 1024
/** Most versions of the file compared before the rest are attributed to the oldest reached. */
export const BLAME_MAX_VERSIONS = 200

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
  /** Every commit a hunk names, with its commit object (for author, time and subject). */
  readonly commits: ReadonlyMap<string, CommitObject>
  /**
   * The walk stopped before every line reached the commit that added it (the version cap, or the
   * history walk cap): the oldest hunks may name a later commit than git would. `approximate`: a
   * change too large to align blamed its lines on the newer side.
   */
  readonly partial: boolean
  readonly approximate: boolean
  readonly versions: number
}

export interface BlameProgress {
  /** Versions of the file compared so far. */
  readonly versions: number
  /** Lines still without a commit. */
  readonly pending: number
  readonly total: number
}

export class BlameRefusedError extends Error {
  constructor(
    readonly reason: 'too-large' | 'binary' | 'not-a-file',
    readonly bytes = 0,
  ) {
    super(reason === 'too-large' ? `This file is over ${BLAME_MAX_BYTES / 1024 / 1024} MiB: blame it with git.` : reason === 'binary' ? 'Binary files have no lines to blame.' : 'Not a file at this commit.')
    this.name = 'BlameRefusedError'
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A `mode:oid` path entry that is a blob (a file or a symlink), not a directory or a submodule. */
const isFileEntry = (entry: string): boolean => {
  const mode = Number(entry.slice(0, entry.indexOf(':')))
  return mode !== MODE_TREE && mode !== MODE_GITLINK
}

/**
 * A file version's text, or a refusal. Read through the page's reader, not the history walker: its
 * memo already holds the version the file view showed, and blobs gain nothing from read-ahead.
 */
async function textOf(reader: ObjectReader, entry: string): Promise<string> {
  const oid = entry.slice(entry.indexOf(':') + 1)
  let bytes: Uint8Array
  try {
    bytes = await readBlob(reader, oid, BLAME_MAX_BYTES)
  } catch (e) {
    if (e instanceof ObjectTooLargeError) throw new BlameRefusedError('too-large', e.size)
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
  }: WalkOptions & { readonly onProgress?: (p: BlameProgress) => void; readonly maxVersions?: number } = {},
): Promise<BlameResult> {
  const entry = await pathEntryAt(reader, walker, tipOid, path)
  if (entry === null || !isFileEntry(entry)) throw new BlameRefusedError('not-a-file')
  const state = new BlameState(await textOf(reader, entry))
  const commits = new Map<string, CommitObject>()
  let approximate = false
  let versions = 0
  let partial = false

  // The versions come from the path's History, page by page: the commits that changed it.
  let start: string | null = tipOid
  let current = { oid: '', text: '' }
  let first = true
  try {
    outer: while (start !== null && state.pending > 0) {
      const page = await logPage(reader, start, { path, walker, signal })
      for (const e of page.entries) {
        signal?.throwIfAborted()
        commits.set(e.oid, e.commit)
        if (first) {
          // The newest change to the path is at or before the tip: the tip's text is its text.
          first = false
          current = { oid: e.oid, text: state.lines.join('') }
        } else {
          // `current.oid` changed the file from this version's text to `current.text`. A version
          // that was a directory or a submodule there means `current.oid` made the file.
          const older = await pathEntryAt(reader, walker, e.oid, path)
          if (older === null || !isFileEntry(older)) break outer
          const text = await textOf(reader, older)
          const map = lineMap(text, current.text)
          if (state.step(current.oid, map).approximate) approximate = true
          current = { oid: e.oid, text }
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
      if (page.capped) partial = true
      start = page.next
    }
  } finally {
    walker.flush?.()
  }
  // What is still open was added by the oldest version reached (exactly git's answer when the
  // walk reached the commit that added the file).
  if (current.oid === '') {
    // The path is unchanged in every commit examined (the walk cap): nothing to attribute to.
    const tip = await commitVia(reader, walker, tipOid)
    commits.set(tipOid, tip)
    current = { oid: tipOid, text: '' }
    partial = true
  }
  state.finish(current.oid)
  onProgress?.({ versions, pending: 0, total: state.lines.length })
  return { lines: state.lines, hunks: toHunks(state.owner as string[]), commits, partial, approximate, versions }
}

/** Consecutive lines with one owner, as hunks. */
export function toHunks(owner: readonly string[]): BlameHunk[] {
  const hunks: BlameHunk[] = []
  for (let i = 0; i < owner.length; i++) {
    const last = hunks[hunks.length - 1]
    if (last !== undefined && last.oid === owner[i] && last.start + last.count === i + 1) {
      hunks[hunks.length - 1] = { ...last, count: last.count + 1 }
    } else {
      hunks.push({ start: i + 1, count: 1, oid: owner[i] as string })
    }
  }
  return hunks
}
