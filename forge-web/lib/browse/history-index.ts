/**
 * History index reader: for one tip commit, each path's first-parent changes and the branch's
 * exact commit count, computed by the pusher (`docs/design/history-index.md`). A push stores two
 * artifacts of the tip: the column index (`packManifest.kind == 3`, format 1: the last-change
 * column and the counts) and the version lists (kind 5, format 2: the whole index). The format is
 * the header's version byte, the only place it is recorded; {@link parseHistoryIndexOfKind}
 * refuses an artifact whose format is not its kind's, and any format this reader does not know.
 *
 * Read-side port of `crates/forge-core/src/pack/historyindex.rs`. gzip-compressed body:
 *
 *   "DFHI" | version u8 (1, or 2 with the versions section) | tip oid (20)
 *   base packHash (32; zero = full index)
 *   commitCount v | firstParentCount v | rootTime v | tipTime v
 *   nCommits v | (oid (20) | authorTime v | subjectLen v | subject)*
 *   nPaths v   | (shared v | suffixLen v | suffix | commit v)*      byte-sorted, front-coded
 *   (tag v | len v | bytes)*                                          extension sections
 *
 * The layout up to the paths is fixed for every version; a version adds tagged sections after
 * them. This reader reads the versions section (tag 1, v2) and skips any other tag; it refuses a
 * version other than 1 or 2:
 *
 *   limit v | oidLen u8 | nAuthors v | (len v | name)* | (author v) × nCommits
 *   per path row: (count << 1 | complete) v | (commit v | mode v | oid prefix (oidLen))*
 *
 * Each list is the path's newest first-parent changes, newest first, at most `limit`: the commit,
 * the path's mode after it and, for a blob mode, the first `oidLen` bytes of its blob oid.
 * `complete`: the list reaches the commit that added the path. A count of 0 without `complete`
 * says nothing is known.
 * `v` is an LEB128 varint, times are author times in seconds. A delta (non-zero base) lists
 * only the paths changed since its base's tip, each list only the changes since then, with its
 * own tip's counts.
 *
 * forge-core's decoder is the reference. This one refuses what it refuses (non-UTF-8 subjects and
 * authors, a mode past 32 bits, every bound), and in one place refuses more: a varint past 2^53,
 * which a number cannot hold and no honest writer writes (counts and times are far smaller).
 * Paths are raw bytes in forge-core; here they decode lossily, and two that decode alike are
 * refused as duplicates.
 */

import { Inflate } from 'pako'
import { bytesToHex } from '@noble/hashes/utils.js'

const MAGIC = [0x44, 0x46, 0x48, 0x49] // "DFHI"
/** The formats this reader knows: 1 (the column index) and 2 (with the version lists). */
const VERSION_V1 = 1
const VERSION_V2 = 2
const OID_LEN = 20
/** The versions section's tag (forge-core `TAG_VERSIONS`). */
const TAG_VERSIONS = 1
/** The most a reader accepts as a list's limit (forge-core `MAX_VERSIONS_PER_PATH`). */
const MAX_VERSIONS_PER_PATH = 4096
/** The shortest blob oid prefix accepted. */
const MIN_OID_PREFIX_LEN = 4
/** git's tree and gitlink modes: their versions carry no blob oid. */
const MODE_TREE = 0o40000
const MODE_GITLINK = 0o160000
/** Rows (paths, commits, version entries) one index may hold: a bound for hostile bytes (forge-core `MAX_ROWS`). */
const MAX_ROWS = 4_000_000
/** The most an index may inflate to (forge-core `MAX_INFLATED`): a gzip bomb stops here. */
export const MAX_INFLATED = 64 * 1024 * 1024

/** A commit the index refers to. */
export interface IndexedCommit {
  readonly oid: string
  readonly subject: string
  /** Author time (ms), as the web's commit parser reports it. */
  readonly when: number
  /**
   * The author's name, from the versions section: '' in a v1 index, and until the index's
   * `versions` is first read (Blame and History read authors through the lists).
   */
  readonly author: string
}

/** One change of a path. */
export interface IndexedVersion {
  readonly commit: IndexedCommit
  /** The path's mode after the commit. */
  readonly mode: number
  /** For a blob mode: the leading hex digits of its blob oid; '' for a directory or a gitlink. */
  readonly oidPrefix: string
}

/** A path's newest first-parent changes, newest first. */
export interface VersionList {
  readonly versions: readonly IndexedVersion[]
  /** The list reaches the commit that added the path: nothing older changed it. */
  readonly complete: boolean
}

/** A parsed history index. */
export interface HistoryIndex {
  readonly tip: string
  /** The full index this delta extends (its packHash), or null for a full index. */
  readonly base: string | null
  /** `git rev-list --count <tip>`: every commit reachable from the tip. */
  readonly commitCount: number
  /** `git rev-list --first-parent --count <tip>`. */
  readonly firstParentCount: number
  /** Author time (ms) of the first-parent root and of the tip. */
  readonly rootWhen: number
  readonly tipWhen: number
  /** Full path → its last change. */
  readonly paths: ReadonlyMap<string, IndexedCommit>
  /**
   * Full path → its version list (v2), or null for a v1 index. A path without one is unknown.
   * Decoded on first read (the file list's column never reads it); a malformed section throws
   * here, not from {@link parseHistoryIndex}, so it costs Blame and History their lists but not
   * the column its commits.
   */
  readonly versions: ReadonlyMap<string, VersionList> | null
  /** The most versions a list holds (0 for a v1 index). */
  readonly versionLimit: number
  /** The header's format: 1 for a column index, 2 with the version lists. */
  readonly format: number
}

class Cursor {
  i = 0
  constructor(private readonly b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.i + n > this.b.length) throw new Error('history index truncated')
    const s = this.b.subarray(this.i, this.i + n)
    this.i += n
    return s
  }
  varint(): number {
    let r = 0
    // At most 8 bytes: 56 bits, past any safe integer; the result must itself be safe.
    for (let shift = 0; shift < 56; shift += 7) {
      const byte = this.take(1)[0] as number
      r += (byte & 0x7f) * 2 ** shift
      if (!Number.isSafeInteger(r)) throw new Error('history index varint overflow')
      if ((byte & 0x80) === 0) return r
    }
    throw new Error('history index varint overflow')
  }
  count(): number {
    const n = this.varint()
    if (n > MAX_ROWS) throw new Error('history index has too many rows')
    return n
  }
  /** An index into a table of `n` rows. */
  index(n: number, what: string): number {
    const i = this.varint()
    if (i >= n) throw new Error(`history index: ${what}`)
    return i
  }
  get done(): boolean {
    return this.i === this.b.length
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false })
/** Subjects and authors must be UTF-8, as forge-core requires. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const text = (bytes: Uint8Array, what: string): string => {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    throw new Error(`history index: ${what} is not UTF-8`)
  }
}

/** A commit while parsing: the versions section fills in its author. */
type ParsedCommit = { -readonly [K in keyof IndexedCommit]: IndexedCommit[K] }

/** Byte order, as git and forge-core sort paths. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/** Inflate a gzip body, refusing one that grows past `max` bytes (a gzip bomb). */
export function inflateBounded(compressed: Uint8Array, max: number): Uint8Array {
  const inflator = new Inflate()
  const parts: Uint8Array[] = []
  let size = 0
  inflator.onData = (chunk: Uint8Array) => {
    size += chunk.length
    if (size > max) throw new Error(`inflates past its size limit (${max} bytes)`)
    parts.push(chunk)
  }
  inflator.push(compressed, true)
  if (inflator.err) throw new Error(`inflate failed: ${inflator.msg}`)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Parse a gzip-compressed history index; throws on anything malformed. */
export function parseHistoryIndex(compressed: Uint8Array, maxInflated = MAX_INFLATED): HistoryIndex {
  const c = new Cursor(inflateBounded(compressed, maxInflated))
  const head = c.take(5)
  if (MAGIC.some((m, i) => head[i] !== m)) throw new Error('not a history index')
  const format = head[4] as number
  if (format < VERSION_V1 || format > VERSION_V2) {
    throw new Error(`history index format ${format} is not one this client reads (1-${VERSION_V2}); reload for a newer version`)
  }
  const tip = bytesToHex(c.take(OID_LEN))
  const baseBytes = c.take(32)
  const base = baseBytes.every((b) => b === 0) ? null : bytesToHex(baseBytes)
  const commitCount = c.varint()
  const firstParentCount = c.varint()
  const rootWhen = c.varint() * 1000
  const tipWhen = c.varint() * 1000
  const commits: ParsedCommit[] = []
  for (let n = c.count(); n > 0; n--) {
    const oid = bytesToHex(c.take(OID_LEN))
    const when = c.varint() * 1000
    const subject = text(c.take(c.varint()), 'a subject')
    commits.push({ oid, subject, when, author: '' })
  }
  const paths = new Map<string, IndexedCommit>()
  let prev = new Uint8Array(0)
  for (let n = c.count(); n > 0; n--) {
    const shared = c.varint()
    if (shared > prev.length) throw new Error('history index path shares more than its predecessor')
    const suffix = c.take(c.varint())
    const path = new Uint8Array(shared + suffix.length)
    path.set(prev.subarray(0, shared))
    path.set(suffix, shared)
    const commit = commits[c.varint()]
    if (commit === undefined) throw new Error('history index path names a missing commit')
    if (paths.size > 0 && compareBytes(path, prev) <= 0) throw new Error('history index paths are not strictly sorted')
    const key = utf8.decode(path)
    // Two byte strings that decode to one path (invalid UTF-8) would shadow each other.
    if (paths.has(key)) throw new Error('history index has a duplicate path')
    paths.set(key, commit)
    prev = path
  }
  // Extension sections: whole `(tag, len, bytes)` records. The versions section is read; any
  // other tag (a later version's) is skipped.
  let section: Uint8Array | null = null
  while (!c.done) {
    const tag = c.varint()
    const bytes = c.take(c.varint())
    if (tag !== TAG_VERSIONS) continue
    if (section !== null) throw new Error('history index: the versions section appears twice')
    section = bytes
  }
  const body = section
  const versionLimit = body === null ? 0 : sectionLimit(body)
  return withLazyVersions({ tip, base, commitCount, firstParentCount, rootWhen, tipWhen, paths, versionLimit, format }, () => {
    if (body === null) return null
    const s = new Cursor(body)
    const versions = parseVersions(s, commits, [...paths.keys()])
    if (!s.done) throw new Error('history index: the versions section has trailing bytes')
    return versions
  })
}

/**
 * {@link parseHistoryIndex} for an artifact recorded as `packManifest.kind == kind` (forge-core
 * `HistoryIndex::parse_kind`): a column index (kind 3) is format 1 or 2 (2 is a superset whose
 * lists a column reader ignores: an index published before the split), version lists (kind 5)
 * format 2.
 */
export function parseHistoryIndexOfKind(compressed: Uint8Array, kind: number, maxInflated = MAX_INFLATED): HistoryIndex {
  let formats: readonly number[]
  switch (kind) {
    case 3:
      formats = [VERSION_V1, VERSION_V2]
      break
    case 5:
      formats = [VERSION_V2]
      break
    default:
      throw new Error('history index: not a history index kind')
  }
  const ix = parseHistoryIndex(compressed, maxInflated)
  if (!formats.includes(ix.format)) {
    throw new Error(`history index: a kind-${kind} artifact must be format ${formats.join(' or ')}, not ${ix.format}`)
  }
  return ix
}

/** The versions section's list limit (its first field), checked. */
function sectionLimit(section: Uint8Array): number {
  const limit = new Cursor(section).varint()
  if (limit === 0 || limit > MAX_VERSIONS_PER_PATH) throw new Error('history index: the version list limit is out of range')
  return limit
}

/**
 * `index` with a `versions` read computed by `load` on first use and kept. Not enumerable, so a
 * spread of the index (`{ ...ix }`) copies the rest without decoding the lists.
 */
function withLazyVersions(
  index: Omit<HistoryIndex, 'versions'>,
  load: () => ReadonlyMap<string, VersionList> | null,
): HistoryIndex {
  let got: { readonly v: ReadonlyMap<string, VersionList> | null } | undefined
  return Object.defineProperty(index, 'versions', {
    get: () => (got ??= { v: load() }).v,
    enumerable: false,
  }) as HistoryIndex
}

/** Read the versions section over the path rows `rowPaths` (in row order), filling in authors. */
function parseVersions(
  c: Cursor,
  commits: ParsedCommit[],
  rowPaths: readonly string[],
): Map<string, VersionList> {
  const limit = c.varint()
  const oidLen = c.take(1)[0] as number
  if (oidLen < MIN_OID_PREFIX_LEN || oidLen > OID_LEN) throw new Error('history index: the oid prefix length is out of range')
  const authors: string[] = []
  for (let n = c.count(); n > 0; n--) authors.push(text(c.take(c.varint()), 'an author'))
  for (const commit of commits) commit.author = authors[c.index(authors.length, 'a commit names an author the table does not hold')] as string
  const versions = new Map<string, VersionList>()
  let entries = 0
  for (const path of rowPaths) {
    const head = c.varint()
    const n = Math.floor(head / 2)
    const complete = head % 2 === 1
    if (n > limit) throw new Error('history index: a version list is longer than its limit')
    entries += n
    if (entries > MAX_ROWS) throw new Error('history index has too many rows')
    if (n === 0 && !complete) continue
    const list: IndexedVersion[] = []
    for (let i = 0; i < n; i++) {
      const commit = commits[c.index(commits.length, 'a version names a commit the table does not hold')] as ParsedCommit
      const mode = c.varint()
      if (mode > 0xffffffff) throw new Error('history index: a mode overflows')
      const oidPrefix = mode === MODE_TREE || mode === MODE_GITLINK ? '' : bytesToHex(c.take(oidLen))
      list.push({ commit, mode, oidPrefix })
    }
    versions.set(path, { versions: list, complete })
  }
  return versions
}

/**
 * A full index overlaid with a delta over it: the delta's paths win, and paths the delta's tip
 * no longer has are dropped by the reader (it only ever asks for names the tip's tree lists).
 * The version lists merge by {@link overlayVersions}.
 */
export function overlayHistory(full: HistoryIndex, delta: HistoryIndex): HistoryIndex {
  const paths = new Map(full.paths)
  for (const [p, c] of delta.paths) paths.set(p, c)
  const limit = delta.versionLimit || full.versionLimit
  return withLazyVersions({ ...delta, base: null, paths, versionLimit: limit }, () => overlayVersions(full, delta, limit))
}

/**
 * The version lists of a delta's tip from its full base's and the delta's (forge-core
 * `overlay_versions`, tested against the same fixtures):
 *
 * - a path the delta does not list is unchanged since the base's tip: the base's list stands;
 * - a path the delta lists with a complete list was added since the base: the delta's list is
 *   its whole history;
 * - otherwise the delta's changes come first, then the base's list, deduplicated by commit and
 *   cut to `limit`; complete when the base's was and nothing was cut;
 * - a path the delta lists (it changed) without a list of its own (a v1 delta) is unknown.
 *
 * Null when neither index has version lists.
 */
export function overlayVersions(full: HistoryIndex, delta: HistoryIndex, limit: number): Map<string, VersionList> | null {
  if (full.versions === null && delta.versions === null) return null
  const out = new Map(full.versions ?? [])
  for (const path of delta.paths.keys()) {
    const d = delta.versions?.get(path)
    const b = full.versions?.get(path)
    if (d === undefined) out.delete(path)
    else if (d.complete || b === undefined) out.set(path, d)
    else {
      const seen = new Set<string>()
      const merged = [...d.versions, ...b.versions].filter((v) => !seen.has(v.commit.oid) && seen.add(v.commit.oid))
      out.set(path, { versions: merged.slice(0, limit), complete: b.complete && merged.length <= limit })
    }
  }
  return out
}
