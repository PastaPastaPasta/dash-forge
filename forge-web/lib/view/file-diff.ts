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
import { compactDiffLines, diffStat, diffTextLines, type CompactDiffLine, type TextDiffLine } from './text-diff'
import { formatBytes } from './format'

/** Blobs above this are not diffed inline. */
export const INLINE_BLOB_MAX_BYTES = 256 * 1024

/** Why a change has no line diff. */
export type PatchPlaceholder = 'binary' | 'large' | 'too-complex' | 'submodule' | 'mode-only' | 'renamed' | 'unreadable'

export type FilePatch =
  | {
      readonly kind: 'text'
      readonly change: FileChange
      /** The diff with unchanged runs folded into gaps (3 lines of context, as git shows). */
      readonly lines: readonly CompactDiffLine[]
      /** Every line of the diff: what an expanded gap shows (L-69). */
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

async function readText(reader: ObjectReader, oid: string | null, options: PatchOptions): Promise<string> {
  if (oid === null) return ''
  const min = options.ignoreSizeHint ? null : knownMinSize(reader, oid)
  if (min !== null && min > INLINE_BLOB_MAX_BYTES) throw new TooLarge(min, true)
  const object = await reader.readObject(oid)
  if (object.type !== 'blob') throw new Error(`${oid.slice(0, 9)} is a ${object.type}, not a blob`)
  if (object.bytes.length > INLINE_BLOB_MAX_BYTES) throw new TooLarge(object.bytes.length)
  const text = decodeTextBlob(object.bytes)
  if (text === null) throw new Binary()
  return text
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
    const [before, after] = await Promise.all([
      readText(sides.base, change.baseOid, options),
      readText(sides.head, change.headOid, options),
    ])
    const lines = diffTextLines(before, after, undefined, { ignoreWhitespace: options.ignoreWhitespace === true })
    if (lines === null) {
      return placeholder(change, 'too-complex', 'This change is too large to diff in the browser.')
    }
    return { kind: 'text', change, lines: compactDiffLines(lines), full: lines, ...diffStat(lines) }
  } catch (e) {
    if (e instanceof Binary) return placeholder(change, 'binary', 'Binary file not shown.')
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
    } else if (p.reason === 'submodule') {
      added += change.headOid !== null ? 1 : 0
      deleted += change.baseOid !== null ? 1 : 0
    } else if (p.reason === 'large' || p.reason === 'too-complex' || p.reason === 'unreadable') uncounted += 1
  }
  return { added, deleted, pending, uncounted }
}
