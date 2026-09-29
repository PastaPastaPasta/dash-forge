/**
 * History index reader (`packManifest.kind == 3`): for one tip commit, each path's last
 * first-parent change and the branch's exact commit count, computed by the pusher
 * (`docs/design/history-index.md`).
 *
 * Read-side port of `crates/forge-core/src/pack/historyindex.rs`. gzip-compressed body:
 *
 *   "DFHI" | version u8 (1) | tip oid (20) | base packHash (32; zero = full index)
 *   commitCount v | firstParentCount v | rootTime v | tipTime v
 *   nCommits v | (oid (20) | authorTime v | subjectLen v | subject)*
 *   nPaths v   | (shared v | suffixLen v | suffix | commit v)*      byte-sorted, front-coded
 *   (tag v | len v | bytes)*                                          extension sections
 *
 * The layout up to the paths is fixed for every version; a later version adds tagged sections
 * after them, which this reader skips (it accepts any version from 1 on).
 * `v` is an LEB128 varint, times are author times in seconds. A delta (non-zero base) lists
 * only the paths changed since its base's tip, with its own tip's counts.
 */

import { Inflate } from 'pako'
import { bytesToHex } from '@noble/hashes/utils.js'

const MAGIC = [0x44, 0x46, 0x48, 0x49] // "DFHI"
const VERSION = 1
const OID_LEN = 20
/** Rows one index may hold: a bound for hostile bytes (forge-core `MAX_ROWS`). */
const MAX_ROWS = 4_000_000
/** The most an index may inflate to (forge-core `MAX_INFLATED`): a gzip bomb stops here. */
export const MAX_INFLATED = 64 * 1024 * 1024

/** A commit the index refers to. */
export interface IndexedCommit {
  readonly oid: string
  readonly subject: string
  /** Author time (ms), as the web's commit parser reports it. */
  readonly when: number
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
  get done(): boolean {
    return this.i === this.b.length
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false })

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
export function parseHistoryIndex(compressed: Uint8Array): HistoryIndex {
  const c = new Cursor(inflateBounded(compressed, MAX_INFLATED))
  const head = c.take(5)
  if (MAGIC.some((m, i) => head[i] !== m) || (head[4] as number) < VERSION) throw new Error('not a history index')
  const tip = bytesToHex(c.take(OID_LEN))
  const baseBytes = c.take(32)
  const base = baseBytes.every((b) => b === 0) ? null : bytesToHex(baseBytes)
  const commitCount = c.varint()
  const firstParentCount = c.varint()
  const rootWhen = c.varint() * 1000
  const tipWhen = c.varint() * 1000
  const commits: IndexedCommit[] = []
  for (let n = c.count(); n > 0; n--) {
    const oid = bytesToHex(c.take(OID_LEN))
    const when = c.varint() * 1000
    const subject = utf8.decode(c.take(c.varint()))
    commits.push({ oid, subject, when })
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
  // A later version's extension sections: whole `(tag, len, bytes)` records, skipped.
  while (!c.done) {
    c.varint()
    c.take(c.varint())
  }
  return { tip, base, commitCount, firstParentCount, rootWhen, tipWhen, paths }
}

/**
 * A full index overlaid with a delta over it: the delta's paths win, and paths the delta's tip
 * no longer has are dropped by the reader (it only ever asks for names the tip's tree lists).
 */
export function overlayHistory(full: HistoryIndex, delta: HistoryIndex): HistoryIndex {
  const paths = new Map(full.paths)
  for (const [p, c] of delta.paths) paths.set(p, c)
  return { ...delta, base: null, paths }
}
