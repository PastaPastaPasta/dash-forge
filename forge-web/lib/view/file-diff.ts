/**
 * Per-file patches over a tree diff's change set — shared by the commit and PR views.
 *
 * Each side of a change is read through its own reader (see {@link DiffSides}). What cannot be
 * shown as a line diff says why instead: binary content, a blob too large to diff in the tab,
 * an edit too large to compute, a submodule pointer, or a blob that could not be read.
 */

import { decodeTextBlob } from './git-objects'
import { isGitlink, type DiffSides, type FileChange } from './commit-log'
import { ObjectTooLargeError } from '../browse'
import { knownMinSize, type ObjectReader } from './tree-nav'
import { diffStat, diffTextLinesOrCount, type TextDiffLine } from './text-diff'
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

/**
 * How a blob was found too large: `measured` (its bytes were read); `refused` by the reader
 * before building it (its exact size is then not known here); or from the browse index's
 * unverified length: a `hint` skip (downloading anyway is allowed), or the reader refusing to
 * fetch an entry the index says is that long (`stored`: the reader would refuse it again).
 */
type TooLargeBy = 'measured' | 'refused' | 'hint' | 'stored'

class TooLarge extends Error {
  constructor(
    readonly size: number | null,
    readonly by: TooLargeBy,
  ) {
    super('too large')
  }
}

class Binary extends Error {
  /** Told from its first bytes only: the file is too large to read whole here. */
  constructor(readonly sniffed = false) {
    super('binary')
  }
}

/** How many leading bytes git looks at for a NUL to call a file binary (`buffer_is_binary`). */
const BINARY_SNIFF_BYTES = 8000

/**
 * A blob too large to read whole that is binary all the same, from its first bytes (QW3-045: a
 * root commit's 1.4 MB .dll left its totals "partial" though git counts a binary file as no
 * lines). A blob stored as a delta, or one whose prefix cannot be read, stays unknown.
 */
async function sniffedBinary(reader: ObjectReader, oid: string): Promise<boolean> {
  const prefix = await reader.blobPrefix?.(oid, BINARY_SNIFF_BYTES).catch(() => null)
  return prefix != null && prefix.includes(0)
}

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

/**
 * A blob's text and byte size, read once up to {@link COUNT_BLOB_MAX_BYTES} ({@link TooLarge}
 * past it). A {@link BrowseReader} refuses an object over the limit with its own
 * `ObjectTooLargeError`, before building it; a reader that ignores the limit (a local
 * `git cat-file`) is checked here after the read. Both are the same verdict: too large.
 */
async function readText(reader: ObjectReader, oid: string | null, options: PatchOptions): Promise<{ text: string; size: number }> {
  if (oid === null) return { text: '', size: 0 }
  const min = options.ignoreSizeHint ? null : knownMinSize(reader, oid)
  if (min !== null && min > COUNT_BLOB_MAX_BYTES) {
    if (await sniffedBinary(reader, oid)) throw new Binary(true)
    throw new TooLarge(min, 'hint')
  }
  let object
  try {
    object = await reader.readObject(oid, { maxBytes: COUNT_BLOB_MAX_BYTES })
  } catch (e) {
    if (!(e instanceof ObjectTooLargeError)) throw e
    if (await sniffedBinary(reader, oid)) throw new Binary(true)
    // Refused on the entry's length alone: the index's claim, which nothing has checked.
    if (e.size === reader.locate?.(oid)?.length) throw new TooLarge(e.size, 'stored')
    throw new TooLarge(null, 'refused')
  }
  if (object.type !== 'blob') throw new Error(`${oid.slice(0, 9)} is a ${object.type}, not a blob`)
  if (object.bytes.length > COUNT_BLOB_MAX_BYTES) {
    if (object.bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new Binary()
    throw new TooLarge(object.bytes.length, 'measured')
  }
  const text = decodeTextBlob(object.bytes)
  if (text === null) throw new Binary()
  return { text, size: object.bytes.length }
}

const textPatch = (change: FileChange, lines: TextDiffLine[]): FilePatch => ({ kind: 'text', change, full: lines, ...diffStat(lines) })

const placeholder = (change: FileChange, reason: PatchPlaceholder, note: string): FilePatch => ({
  kind: 'placeholder',
  change,
  reason,
  note,
})

/** Why a file between the inline and count limits is not shown (its lines are still counted). */
const largeNote = (size: number): string =>
  `Large file (${formatBytes(size)}) not shown; the limit for an inline diff is ${formatBytes(INLINE_BLOB_MAX_BYTES)}.`

/** What the browser shows and counts, for a file past both limits. */
const LIMITS = `Files up to ${formatBytes(INLINE_BLOB_MAX_BYTES)} are shown and files up to ${formatBytes(COUNT_BLOB_MAX_BYTES)} are counted; this one's lines are not in the totals.`

type Side = { readonly text: string; readonly size: number }

/**
 * Both sides' texts. A binary side wins over any other failure (git counts a binary file as no
 * lines, whatever its other side), so the verdict does not depend on which read failed first.
 */
async function readSides(sides: DiffSides, change: FileChange, options: PatchOptions): Promise<[Side, Side]> {
  const [before, after] = await Promise.allSettled([readText(sides.base, change.baseOid, options), readText(sides.head, change.headOid, options)])
  if (before.status === 'fulfilled' && after.status === 'fulfilled') return [before.value, after.value]
  const failures = [before, after].flatMap((r): unknown[] => (r.status === 'rejected' ? [r.reason] : []))
  throw failures.find((e) => e instanceof Binary) ?? failures[0]
}

/** The placeholder for a file too large to read here, saying why. */
function tooLarge(change: FileChange, e: TooLarge): FilePatch {
  const size = e.size === null ? `over ${formatBytes(COUNT_BLOB_MAX_BYTES)}` : formatBytes(e.size)
  if (e.by === 'hint' || e.by === 'stored') {
    // The size is the browse index's claim: a false one could hide a small file's change.
    const what = e.by === 'hint' ? `this file at about ${size}` : `this file's stored size as ${size}`
    return {
      kind: 'placeholder',
      change,
      reason: 'large',
      note: `Not downloaded: the browse index lists ${what}, more than the browser reads to diff a file (${formatBytes(COUNT_BLOB_MAX_BYTES)}). That size is the index's claim and has not been checked.`,
      ...(e.by === 'hint' ? { unverifiedSize: true as const } : {}),
    }
  }
  return placeholder(change, 'large', `File too large to diff in the browser (${size}). ${LIMITS}`)
}

/**
 * Load one change's patch. Never rejects: a failure becomes an `unreadable` placeholder.
 *
 * Both sides are read once, up to {@link COUNT_BLOB_MAX_BYTES}: a file up to
 * {@link INLINE_BLOB_MAX_BYTES} is shown, a larger one is counted but not shown (so the change's
 * totals stay whole, L-25), and one past the count limit is neither, and says so.
 */
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
    const [before, after] = await readSides(sides, change, options)
    const size = Math.max(before.size, after.size)
    const lines = diffTextLinesOrCount(before.text, after.text, undefined, { ignoreWhitespace: options.ignoreWhitespace === true })
    if (!Array.isArray(lines)) {
      const large = size > INLINE_BLOB_MAX_BYTES ? `${largeNote(size)} ` : ''
      // Too many changes to show, but counted from the same diff (QW-027): the totals stay whole.
      if (lines !== null) return { ...placeholder(change, 'too-complex', `${large}This change is too large to show in the browser; its lines are counted.`), added: lines.added, deleted: lines.deleted }
      return placeholder(change, 'too-complex', `${large}This change is too large to diff in the browser, so its lines are not counted.`)
    }
    if (size <= INLINE_BLOB_MAX_BYTES) return textPatch(change, lines)
    return { kind: 'placeholder', change, reason: 'large', note: largeNote(size), ...diffStat(lines) }
  } catch (e) {
    if (e instanceof Binary) {
      return placeholder(change, 'binary', e.sniffed ? 'Binary file not shown (too large to read whole here; told binary by its first bytes, as git does).' : 'Binary file not shown.')
    }
    if (e instanceof TooLarge) return tooLarge(change, e)
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
    } else if (uncountedWhy(p) !== null) uncounted += 1
  }
  return { added, deleted, pending, uncounted }
}

/** Why a loaded patch's lines are not in the totals, or null when they are (or it has none to count). */
function uncountedWhy(p: FilePatch): string | null {
  if (p.kind !== 'placeholder' || (p.added !== undefined && p.deleted !== undefined)) return null
  if (p.reason === 'large') return 'too large to diff in the browser'
  if (p.reason === 'too-complex') return 'too many changes to diff'
  if (p.reason === 'unreadable') return 'could not be read'
  return null
}

/**
 * Why the files {@link diffTotals} leaves uncounted are left out, for the partial totals' label:
 * `1 too large to diff in the browser, 1 could not be read`. Empty when every loaded file was counted.
 */
export function uncountedReasons(changes: readonly FileChange[], patchOf: (change: FileChange) => FilePatch | undefined): string {
  const counts = new Map<string, number>()
  for (const change of changes) {
    const p = patchOf(change)
    const why = p === undefined ? null : uncountedWhy(p)
    if (why !== null) counts.set(why, (counts.get(why) ?? 0) + 1)
  }
  return [...counts].map(([why, n]) => `${n} ${why}`).join(', ')
}
