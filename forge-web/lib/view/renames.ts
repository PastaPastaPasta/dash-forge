/**
 * Rename detection over a tree diff (L-24), as `git diff -M` does it: git's `diffcore_rename`
 * (diffcore-rename.c) with its default options (`-M`, 50% similarity, no copies, no break
 * detection), scored by `diffcore_count_changes` (diffcore-delta.c). Ported step by step so the
 * same files pair as in git:
 *
 * 1. Exact renames: an added file whose blob a deleted file had (`find_exact_renames`), the
 *    deleted file with the same basename preferred; symlinks and submodules only with equal modes.
 * 2. Basename matches: among what is left, an added and a deleted file whose basename is unique on
 *    both sides pair when they are at least 75% similar (`find_basename_matches`, with
 *    `GIT_BASENAME_FACTOR` at its default of 50: halfway between 50% and 100%).
 * 3. The similarity matrix: every remaining added file against every remaining deleted one, the
 *    best four sources per destination kept, then paired best first at 50% or more
 *    (`find_renames`), unless the matrix is over `diff.renameLimit` (1000 × 1000).
 *
 * Two limits are this browser's, not git's, and the result says when either applied
 * ({@link RenameResult.limited}): reading blobs costs network requests here, so the inexact
 * phases read at most {@link RENAME_READ_BUDGET} blobs (a phase that needs more is skipped), and a
 * blob over {@link RENAME_MAX_BLOB_BYTES} is not scored. `.gitattributes` `diff` drivers are not
 * read: binary means a NUL in the first 8000 bytes, git's own default test.
 */

import type { DiffSides, FileChange } from './commit-log'
import { ObjectTooLargeError } from '../browse'
import { formatBytes, plural } from './format'
import { mapPooled } from './pool'

/** git's MAX_SCORE (diffcore.h): similarity is a score out of this. */
const MAX_SCORE = 60000
/** DEFAULT_RENAME_SCORE: `-M` without a number, 50%. */
const MIN_SCORE = 30000
/** find_basename_matches' bar: `MIN_SCORE + 0.5 × (MAX_SCORE − MIN_SCORE)`, 75%. */
const MIN_BASENAME_SCORE = MIN_SCORE + Math.trunc(0.5 * (MAX_SCORE - MIN_SCORE))
/** diff.renameLimit's default for `git diff`: no inexact detection past 1000 × 1000 pairs. */
const RENAME_LIMIT = 1000
/** NUM_CANDIDATE_PER_DST. */
const CANDIDATES = 4
/** git's buffer_is_binary: a NUL in the first FIRST_FEW_BYTES. */
const FIRST_FEW_BYTES = 8000
/** diffcore-delta.c HASHBASE. */
const HASHBASE = 107927

/** Blobs the inexact phases may read (each a ranged read over the network). */
const RENAME_READ_BUDGET = 64
/** A blob larger than this is not scored for similarity. */
const RENAME_MAX_BLOB_BYTES = 1024 * 1024
const NOT_LOOKED = 'Renames with edits were not all looked for:'
/** Blob reads in flight at once. */
const READ_POOL = 6

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const isRegular = (mode: number): boolean => (mode & S_IFMT) === S_IFREG

export interface RenameOptions {
  /** Blobs the inexact phases may read (default {@link RENAME_READ_BUDGET}). */
  readonly readBudget?: number
}

export interface RenameResult {
  /** The changes with each detected rename as one `renamed` change at its new path. */
  readonly changes: FileChange[]
  /** Why renames with edits may be missing (a browser limit git does not have), or null. */
  readonly limited: string | null
}

/** A side of a candidate pair: its path, blob and mode. */
interface Spec {
  /** Its index in its side's list. */
  readonly index: number
  readonly path: string
  readonly oid: string
  readonly mode: number
  readonly change: FileChange
  used: boolean
}

/** git's path order for the diff queue: byte (UTF-8) order of the full path, which is code point order. */
function byPath(a: FileChange, b: FileChange): number {
  const x = a.path
  const y = b.path
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    const cx = x.codePointAt(i) as number
    const cy = y.codePointAt(j) as number
    if (cx !== cy) return cx - cy
    i += cx > 0xffff ? 2 : 1
    j += cy > 0xffff ? 2 : 1
  }
  return x.length - y.length
}

/** basename_same: whether two paths end in the same file name. */
export function basenameSame(src: string, dst: string): boolean {
  let i = src.length
  let j = dst.length
  while (i > 0 && j > 0) {
    const c1 = src[--i]
    const c2 = dst[--j]
    if (c1 !== c2) return false
    if (c1 === '/') return true
  }
  return (i === 0 || src[i - 1] === '/') && (j === 0 || dst[j - 1] === '/')
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * hash_chars (diffcore-delta.c): the blob cut into chunks at each LF or every 64 bytes, each
 * chunk hashed into one of {@link HASHBASE} buckets, bucket → bytes. A text blob's CR before an LF
 * is skipped.
 */
export function spanHash(bytes: Uint8Array): Map<number, number> {
  const isText = bytes.subarray(0, FIRST_FEW_BYTES).indexOf(0) === -1
  const out = new Map<number, number>()
  const add = (hashval: number, n: number): void => {
    out.set(hashval, (out.get(hashval) ?? 0) + n)
  }
  let n = 0
  let accum1 = 0
  let accum2 = 0
  const hashOf = (): number => ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] as number
    if (isText && c === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) continue
    const old1 = accum1
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0
    accum1 = (accum1 + c) >>> 0
    if (++n < 64 && c !== 0x0a) continue
    add(hashOf(), n)
    n = 0
    accum1 = 0
    accum2 = 0
  }
  if (n > 0) add(hashOf(), n)
  return out
}

/** A blob read for scoring: its size and its span hashes. */
interface Scored {
  readonly size: number
  readonly spans: Map<number, number>
}

/**
 * estimate_similarity: how much of `dst` came from `src`, out of {@link MAX_SCORE}. Only regular
 * files are scored, and a pair whose sizes differ by more than `minScore` allows is 0 unread.
 */
function similarity(src: Scored, dst: Scored, minScore: number): number {
  const max = Math.max(src.size, dst.size)
  const base = Math.min(src.size, dst.size)
  if (max * (MAX_SCORE - minScore) < (max - base) * MAX_SCORE) return 0
  if (dst.size === 0) return 0
  let copied = 0
  for (const [h, n] of src.spans) copied += Math.min(n, dst.spans.get(h) ?? 0)
  return Math.trunc((copied * MAX_SCORE) / max)
}

/** git's similarity index (`R087`): the score as a whole percentage, rounded down. */
const similarityPercent = (score: number): number => Math.trunc((score * 100) / MAX_SCORE)

/** One candidate pair of the matrix (struct diff_score). */
interface Candidate {
  readonly src: number
  readonly dst: number
  readonly score: number
  readonly nameScore: number
}

/** score_compare: best first, by score, then a shared basename; empty slots last. */
function scoreCompare(a: Candidate | null, b: Candidate | null): number {
  if (a === null) return b !== null ? 1 : 0
  if (b === null) return -1
  if (a.score === b.score) return b.nameScore - a.nameScore
  return b.score - a.score
}

/**
 * Pair the deleted and added files of `changes` that git would call renames. Deleted files are
 * read through `sides.base`, added ones through `sides.head`. Never rejects on a read failure: a
 * blob that cannot be read is not scored, and the result says renames may be missing.
 */
export async function detectRenames(sides: DiffSides, changes: readonly FileChange[], options: RenameOptions = {}): Promise<RenameResult> {
  const { readBudget = RENAME_READ_BUDGET } = options
  const sorted = [...changes].sort(byPath)
  const srcs: Spec[] = []
  const dsts: Spec[] = []
  for (const c of sorted) {
    if (c.status === 'deleted' && c.baseOid !== null && c.baseMode !== null) {
      srcs.push({ index: srcs.length, path: c.path, oid: c.baseOid, mode: c.baseMode, change: c, used: false })
    }
    if (c.status === 'added' && c.headOid !== null && c.headMode !== null) {
      dsts.push({ index: dsts.length, path: c.path, oid: c.headOid, mode: c.headMode, change: c, used: false })
    }
  }
  if (srcs.length === 0 || dsts.length === 0) return { changes: [...changes], limited: null }

  /** dst index → [src index, score]. */
  const pairs = new Map<number, readonly [number, number]>()
  const record = (dst: number, src: number, score: number): void => {
    pairs.set(dst, [src, score])
    ;(srcs[src] as Spec).used = true
    ;(dsts[dst] as Spec).used = true
  }

  // 1. find_exact_renames: sources are tried in queue order; up to 100 per destination.
  const byOid = new Map<string, number[]>()
  for (const x of srcs) byOid.set(x.oid, [...(byOid.get(x.oid) ?? []), x.index])
  dsts.forEach((d, di) => {
    let best = -1
    let bestScore = -1
    let tries = 100
    for (const si of byOid.get(d.oid) ?? []) {
      const s = srcs[si] as Spec
      if ((!isRegular(s.mode) || !isRegular(d.mode)) && s.mode !== d.mode) continue
      if (s.used) continue
      const score = 1 + (basenameSame(s.path, d.path) ? 1 : 0)
      if (score > bestScore) {
        best = si
        bestScore = score
        if (score === 2) break
      }
      if (--tries === 0) break
    }
    if (best !== -1) record(di, best, MAX_SCORE)
  })

  // Blobs for scoring, read before each inexact phase (at most the budget over both phases).
  const blobs = new Map<string, Scored | null>()
  /** A phase was cut short for this browser's read budget (git would have run it all). */
  let skipped: string | null = null
  let unreadable = false
  let tooLarge = false
  /** The regular files' blobs among `specs` not read yet, each once. */
  const unread = (specs: readonly Spec[]): Spec[] => {
    const seen = new Set<string>()
    return specs.filter((s) => isRegular(s.mode) && !blobs.has(s.oid) && !seen.has(s.oid) && (seen.add(s.oid), true))
  }
  const readAll = async (base: readonly Spec[], head: readonly Spec[]): Promise<void> => {
    const todo = [...unread(base).map((spec) => ({ spec, reader: sides.base })), ...unread(head).map((spec) => ({ spec, reader: sides.head }))]
    await mapPooled(todo, READ_POOL, async ({ spec, reader }) => {
      if (blobs.has(spec.oid)) return
      try {
        const o = await reader.readObject(spec.oid, { maxBytes: RENAME_MAX_BLOB_BYTES })
        blobs.set(spec.oid, o.type === 'blob' ? { size: o.bytes.length, spans: spanHash(o.bytes) } : null)
      } catch (e) {
        if (e instanceof ObjectTooLargeError) tooLarge = true
        else unreadable = true
        blobs.set(spec.oid, null)
      }
    })
  }
  const score = (s: Spec, d: Spec, minScore: number): number => {
    if (!isRegular(s.mode) || !isRegular(d.mode)) return 0
    const a = blobs.get(s.oid)
    const b = blobs.get(d.oid)
    return a == null || b == null ? 0 : similarity(a, b, minScore)
  }

  // 2. find_basename_matches: a basename unique among the remaining sources and destinations.
  // Each such pair stands alone, so when the budget does not reach every pair, the ones it does
  // reach (in queue order) are still pairs git makes; the matrix is then skipped.
  const uniqueBy = (specs: readonly Spec[]): Map<string, Spec | null> => {
    const m = new Map<string, Spec | null>()
    for (const x of specs) m.set(basename(x.path), m.has(basename(x.path)) ? null : x)
    return m
  }
  const srcByName = uniqueBy(srcs.filter((x) => !x.used))
  const dstByName = uniqueBy(dsts.filter((x) => !x.used))
  const byName: (readonly [Spec, Spec])[] = []
  for (const [name, src] of srcByName) {
    const dst = dstByName.get(name)
    if (src !== null && dst != null) byName.push([src, dst])
  }
  byName.sort(([a], [b]) => a.index - b.index)
  // The longest run of pairs, in queue order, whose blobs fit the budget.
  const willRead = new Set<string>()
  let n = 0
  for (const pair of byName) {
    const add = new Set(pair.filter((x) => isRegular(x.mode) && !willRead.has(x.oid)).map((x) => x.oid))
    if (willRead.size + add.size > readBudget) break
    for (const o of add) willRead.add(o)
    n += 1
  }
  const reachable = byName.slice(0, n)
  if (n < byName.length) {
    skipped = `${NOT_LOOKED} comparing the ${plural(byName.length, 'file')} that kept their names would read too many files in the browser, so ${n === 0 ? 'none' : `only ${n}`} of them ${n === 1 ? 'was' : 'were'} compared.`
  }
  if (reachable.length > 0) {
    await readAll(
      reachable.map(([x]) => x),
      reachable.map(([, y]) => y),
    )
    for (const [src, dst] of reachable) {
      if (dst.used) continue // git's "already used in a rename"; cannot happen with unique names.
      const sc = score(src, dst, MIN_BASENAME_SCORE)
      if (sc >= MIN_BASENAME_SCORE) record(dst.index, src.index, sc)
    }
  }

  // 3. The matrix, over what is left, unless it is over diff.renameLimit or this browser's budget.
  const left = srcs.filter((x) => !x.used)
  const rest = dsts.filter((x) => !x.used)
  if (left.length > 0 && rest.length > 0 && skipped === null) {
    if (left.length * rest.length > RENAME_LIMIT * RENAME_LIMIT) {
      // git skips this phase too (and warns): the same answer as `git diff -M`.
      skipped = `${NOT_LOOKED} ${left.length} deleted and ${rest.length} added files are over git's rename limit.`
    } else if (blobs.size + unread([...left, ...rest]).length > readBudget) {
      skipped = `${NOT_LOOKED} comparing ${plural(left.length, 'deleted file')} with ${plural(rest.length, 'added file')} would read too many files in the browser.`
    } else {
      await readAll(left, rest)
      const matrix: (Candidate | null)[] = []
      for (const d of rest) {
        const m = new Array<Candidate | null>(CANDIDATES).fill(null)
        for (const src of left) {
          const o: Candidate = { src: src.index, dst: d.index, score: score(src, d, MIN_SCORE), nameScore: basenameSame(src.path, d.path) ? 1 : 0 }
          // record_if_better: replace the worst slot (the first of equals) when `o` beats it.
          let worst = 0
          for (let i = 1; i < CANDIDATES; i++) if (scoreCompare(m[i] ?? null, m[worst] ?? null) > 0) worst = i
          if (scoreCompare(m[worst] ?? null, o) > 0) m[worst] = o
        }
        matrix.push(...m)
      }
      matrix.sort(scoreCompare)
      for (const c of matrix) {
        if (c === null || c.score < MIN_SCORE) break
        if ((dsts[c.dst] as Spec).used || (srcs[c.src] as Spec).used) continue
        record(c.dst, c.src, c.score)
      }
    }
  }

  const limited =
    skipped ??
    (unreadable
      ? 'Some files could not be read to compare them, so renames among them may not be shown.'
      : tooLarge
        ? `Files over ${formatBytes(RENAME_MAX_BLOB_BYTES)} are not compared in the browser, so renames among them may not be shown.`
        : null)
  if (pairs.size === 0) return { changes: [...changes], limited }
  const gone = new Set<FileChange>()
  const renamed = new Map<FileChange, FileChange>()
  for (const [di, [si, sc]] of pairs) {
    const s = srcs[si] as Spec
    const d = dsts[di] as Spec
    gone.add(s.change)
    renamed.set(d.change, {
      ...d.change,
      status: 'renamed',
      oldPath: s.path,
      baseOid: s.oid,
      baseMode: s.mode,
      similarity: similarityPercent(sc),
    })
  }
  return { changes: changes.filter((c) => !gone.has(c)).map((c) => renamed.get(c) ?? c), limited }
}
