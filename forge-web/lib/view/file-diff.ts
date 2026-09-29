/**
 * Per-file patches over a tree diff's change set — shared by the commit and PR views.
 *
 * Each side of a change is read through its own reader (see {@link DiffSides}). What cannot be
 * shown as a line diff says why instead: binary content, a blob too large to diff in the tab,
 * an edit too large to compute, a submodule pointer, or a blob that could not be read.
 */

import { decodeTextBlob } from './git-objects'
import { isGitlink, type DiffSides, type FileChange } from './commit-log'
import { knownMinSize, type ObjectReader } from './tree-nav'
import { diffStat, diffTextLines, type TextDiffLine } from './text-diff'
import { formatBytes } from './format'

/** Blobs above this are not diffed inline. */
export const INLINE_BLOB_MAX_BYTES = 256 * 1024
/** A file too large to show, up to this size, is still read to count its lines (L-25). */
export const COUNT_BLOB_MAX_BYTES = 1024 * 1024

/** Why a change has no line diff. */
export type PatchPlaceholder = 'binary' | 'large' | 'too-complex' | 'submodule' | 'mode-only' | 'renamed' | 'unreadable'

export type FilePatch =
  | {
      readonly kind: 'text'
      readonly change: FileChange
      /** Every line of the diff; the view folds unchanged runs into gaps, and expands them (L-69). */
      readonly full: readonly TextDiffLine[]
      readonly added: number
      readonly deleted: number
    }
  | {
      readonly kind: 'placeholder'
      readonly change: FileChange
      readonly reason: PatchPlaceholder
      readonly note: string
      /** A `large` skip decided from the browse index's unverified size; loading anyway is allowed. */
      readonly unverifiedSize?: true
      /** A `large` file's line counts, when it was small enough to count (not to show). */
      readonly added?: number
      readonly deleted?: number
    }

class TooLarge extends Error {
  /** `indexed`: the size is the browse index's claim, not a measured (verified) blob. */
  constructor(
    readonly size: number,
    readonly indexed = false,
  ) {
    super('too large')
  }
}

class Binary extends Error {}

/*
 * A skip based on {@link knownMinSize} is labelled as the index's claim and can be overridden
 * with {@link PatchOptions.ignoreSizeHint}: the locator is published by whoever pushed the repo
 * (for a PR's head side, the PR author), and a false length could otherwise hide a small
 * file's change from a reviewer.
 */

export interface PatchOptions {
  /** Download and measure the blobs even when the browse index says they are too large. */
  readonly ignoreSizeHint?: boolean
  /** Compare lines with whitespace removed (`git diff -w`). */
  readonly ignoreWhitespace?: boolean
}

/** A blob's text and byte size; `limit` is the largest it may be ({@link TooLarge} past it). */
async function readText(reader: ObjectReader, oid: string | null, options: PatchOptions, limit = INLINE_BLOB_MAX_BYTES): Promise<{ text: string; size: number }> {
  if (oid === null) return { text: '', size: 0 }
  const min = options.ignoreSizeHint ? null : knownMinSize(reader, oid)
  if (min !== null && min > limit) throw new TooLarge(min, true)
  const object = await reader.readObject(oid, { maxBytes: limit })
  if (object.type !== 'blob') throw new Error(`${oid.slice(0, 9)} is a ${object.type}, not a blob`)
  if (object.bytes.length > limit) throw new TooLarge(object.bytes.length)
  const text = decodeTextBlob(object.bytes)
  if (text === null) throw new Binary()
  return { text, size: object.bytes.length }
}

/** Both sides' texts, and the patch of them, or null when the diff is past its bounds. */
async function readPair(sides: DiffSides, change: FileChange, options: PatchOptions, limit?: number): Promise<{ size: number; lines: TextDiffLine[] | null }> {
  const [before, after] = await Promise.all([
    readText(sides.base, change.baseOid, options, limit),
    readText(sides.head, change.headOid, options, limit),
  ])
  return { size: Math.max(before.size, after.size), lines: diffTextLines(before.text, after.text, undefined, { ignoreWhitespace: options.ignoreWhitespace === true }) }
}

const textPatch = (change: FileChange, lines: TextDiffLine[]): FilePatch => ({ kind: 'text', change, full: lines, ...diffStat(lines) })

/**
 * A file over the inline limit but under {@link COUNT_BLOB_MAX_BYTES}: read to count its lines, so
 * the change's totals are whole (L-25), and shown after all when both sides turn out small (the
 * index's size was wrong). Null when it cannot be counted.
 */
async function countLarge(sides: DiffSides, change: FileChange, options: PatchOptions): Promise<FilePatch | null> {
  try {
    const { size, lines } = await readPair(sides, change, { ...options, ignoreSizeHint: true }, COUNT_BLOB_MAX_BYTES)
    if (lines === null) return null
    if (size <= INLINE_BLOB_MAX_BYTES) return textPatch(change, lines)
    return {
      kind: 'placeholder',
      change,
      reason: 'large',
      note: `Large file (${formatBytes(size)}) not shown; the limit for an inline diff is ${formatBytes(INLINE_BLOB_MAX_BYTES)}.`,
      ...diffStat(lines),
    }
  } catch {
    return null
  }
}

const placeholder = (change: FileChange, reason: PatchPlaceholder, note: string): FilePatch => ({
  kind: 'placeholder',
  change,
  reason,
  note,
})

/** Load one change's patch. Never rejects: a failure becomes an `unreadable` placeholder. */
export async function loadFilePatch(
  sides: DiffSides,
  change: FileChange,
  options: PatchOptions = {},
): Promise<FilePatch> {
  if (isGitlink(change.baseMode) || isGitlink(change.headMode)) {
    const from = change.baseOid ? change.baseOid.slice(0, 9) : 'none'
    const to = change.headOid ? change.headOid.slice(0, 9) : 'none'
    return placeholder(change, 'submodule', `Submodule commit ${from} → ${to}`)
  }
  if (change.baseOid !== null && change.baseOid === change.headOid) {
    if (change.status === 'renamed') {
      const mode = change.baseMode !== change.headMode ? ' Its mode changed.' : ''
      return placeholder(change, 'renamed', `File renamed without changes.${mode}`)
    }
    return placeholder(change, 'mode-only', 'File mode changed; content is identical.')
  }
  try {
    const { lines } = await readPair(sides, change, options)
    if (lines === null) {
      return placeholder(change, 'too-complex', 'This change is too large to diff in the browser.')
    }
    return textPatch(change, lines)
  } catch (e) {
    if (e instanceof Binary) return placeholder(change, 'binary', 'Binary file not shown.')
    if (e instanceof TooLarge && e.size <= COUNT_BLOB_MAX_BYTES) {
      const counted = await countLarge(sides, change, options)
      if (counted !== null) return counted
    }
    if (e instanceof TooLarge && e.indexed) {
      return {
        kind: 'placeholder',
        change,
        reason: 'large',
        note: `Not downloaded: the browse index lists this file at about ${formatBytes(e.size)}, over the ${formatBytes(INLINE_BLOB_MAX_BYTES)} inline-diff limit. That size is the index's claim and has not been checked.`,
        unverifiedSize: true,
      }
    }
    if (e instanceof TooLarge) {
      return placeholder(
        change,
        'large',
        `Large file (${formatBytes(e.size)}) not shown; the limit for an inline diff is ${formatBytes(INLINE_BLOB_MAX_BYTES)}.`,
      )
    }
    return placeholder(change, 'unreadable', e instanceof Error ? e.message : 'Could not read this file.')
  }
}

/** Human form of a tree-entry mode for a mode-change label (`100755`). */
export function modeString(mode: number): string {
  return mode.toString(8).padStart(6, '0')
}

/** A change set's line totals (L-25), and how many files they do not cover yet. */
export interface DiffTotals {
  readonly added: number
  readonly deleted: number
  /** Files whose patch is not loaded yet. */
  readonly pending: number
  /** Files whose lines cannot be counted here (too large, too complex, unreadable). */
  readonly uncounted: number
}

/**
 * Totals over `changes` as `git diff --shortstat` counts them: text lines; a submodule's commit
 * line on each side it exists; nothing for a binary file, a mode change or a rename without edits.
 * `patchOf` gives a change's loaded patch, if any.
 */
export function diffTotals(changes: readonly FileChange[], patchOf: (change: FileChange) => FilePatch | undefined): DiffTotals {
  let added = 0
  let deleted = 0
  let pending = 0
  let uncounted = 0
  for (const change of changes) {
    const p = patchOf(change)
    if (p === undefined) pending += 1
    else if (p.kind === 'text') {
      added += p.added
      deleted += p.deleted
    } else if (p.added !== undefined && p.deleted !== undefined) {
      added += p.added
      deleted += p.deleted
    } else if (p.reason === 'submodule') {
      added += change.headOid !== null ? 1 : 0
      deleted += change.baseOid !== null ? 1 : 0
    } else if (p.reason === 'large' || p.reason === 'too-complex' || p.reason === 'unreadable') uncounted += 1
  }
  return { added, deleted, pending, uncounted }
}
