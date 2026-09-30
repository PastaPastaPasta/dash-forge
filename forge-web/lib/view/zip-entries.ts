/**
 * Zip entries as `git archive --format=zip` writes them (QW-026; git's archive-zip.c), for the
 * zip worker: kept apart from it so the tests run the same code on fflate directly.
 *
 * - An executable is recorded with its Unix mode (`0100755`, "made by" Unix) so it unpacks
 *   executable; a symlink as `0120777` with its target as its content, so it unpacks as a link;
 *   a regular file with no Unix mode, as git writes it (unzip then applies the umask).
 * - Every directory gets its own entry, as git archive writes one.
 * - Every entry carries the commit's time: as the DOS date (local time, as git's `localtime`) and
 *   as the `UT` extended timestamp (UTC seconds), which unzip prefers.
 * - The archive comment is the commit id, as git writes it.
 */

import type { Zippable, ZipOptions } from 'fflate'

/** The message the zip worker takes. */
export interface ZipMessage {
  readonly entries: Record<string, Uint8Array>
  readonly meta: {
    readonly modes: Readonly<Record<string, number>>
    readonly mtime: number
    readonly comment: string | null
  } | null
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
/** Zip's "version made by" high byte for Unix, and the DOS directory attribute. */
const OS_UNIX = 3
const DOS_DIRECTORY = 0x10
/** The `UT` extended timestamp's header id (APPNOTE 4.6.1 / Info-ZIP). */
const EXTENDED_TIMESTAMP = 0x5455

/** The `UT` field: flags (modification time present) and the time in UTC seconds. */
function extendedTimestamp(mtime: number): Uint8Array {
  const field = new Uint8Array(5)
  field[0] = 1
  new DataView(field.buffer).setUint32(1, Math.floor(mtime / 1000) >>> 0, true)
  return field
}

/** The attributes git archive records for a file of git mode `mode`. */
export function entryAttributes(mode: number): Pick<ZipOptions, 'os' | 'attrs'> {
  if ((mode & S_IFMT) === S_IFLNK) return { os: OS_UNIX, attrs: ((mode | 0o777) << 16) >>> 0 }
  if ((mode & 0o111) !== 0) return { os: OS_UNIX, attrs: (mode << 16) >>> 0 }
  return { os: 0, attrs: 0 }
}

/** `entries` with each file's attributes, every directory's entry, and the commit's time. */
export function zipEntries(entries: Record<string, Uint8Array>, meta: NonNullable<ZipMessage['meta']>): Zippable {
  const mtime = new Date(meta.mtime)
  const extra = { [EXTENDED_TIMESTAMP]: extendedTimestamp(meta.mtime) }
  const out: Zippable = {}
  const dirs = new Set<string>()
  for (const path of Object.keys(entries)) {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) dirs.add(path.slice(0, at + 1))
  }
  // Directories first, in path order, then the files (git writes each directory before its contents).
  for (const dir of [...dirs].sort()) out[dir] = [new Uint8Array(0), { os: 0, attrs: DOS_DIRECTORY, mtime, extra, level: 0 }]
  for (const [path, bytes] of Object.entries(entries)) {
    out[path] = [bytes, { ...entryAttributes(meta.modes[path] ?? 0o100644), mtime, extra }]
  }
  return out
}

/** `zip` with `comment` as its archive comment (the end-of-central-directory record's). */
export function withArchiveComment(zip: Uint8Array, comment: string | null): Uint8Array {
  if (comment === null || comment === '' || zip.length < 22) return zip
  const bytes = new TextEncoder().encode(comment).subarray(0, 0xffff)
  const eocd = zip.length - 22
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // Only a zip that ends in a comment-less end record (fflate writes one).
  if (view.getUint32(eocd, true) !== 0x06054b50 || view.getUint16(eocd + 20, true) !== 0) return zip
  const out = new Uint8Array(zip.length + bytes.length)
  out.set(zip)
  out.set(bytes, zip.length)
  new DataView(out.buffer).setUint16(eocd + 20, bytes.length, true)
  return out
}
