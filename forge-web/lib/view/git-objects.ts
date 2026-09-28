/**
 * git object parsers (view glue) — decode the raw bytes {@link BrowseReader} returns.
 *
 * The browse plane hands back `{ type, bytes }` for a git object; these helpers turn a
 * `tree` into its entries and a `commit` into its header fields for rendering. Pure byte
 * parsing, no network. Blob bytes are used as-is (text-decoded or offered as a raw download).
 *
 * Loaded by plain Node (type stripping) in `render-fuzz.test.ts`: keep imports relative and
 * the syntax erasable (no enums, namespaces or `@/` aliases).
 */

import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

/** One entry in a parsed git tree. */
export interface TreeEntry {
  readonly mode: number
  readonly name: string
  readonly oid: string
}

/** Parse a raw git tree object body into its entries (`<mode> <name>\0<20-byte oid>`…). */
export function parseTree(bytes: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = []
  let i = 0
  while (i < bytes.length) {
    // mode (ascii octal) up to a space
    let sp = i
    while (sp < bytes.length && bytes[sp] !== 0x20) sp += 1
    const modeStr = new TextDecoder().decode(bytes.subarray(i, sp))
    const mode = parseInt(modeStr, 8)
    // name up to NUL
    let nul = sp + 1
    while (nul < bytes.length && bytes[nul] !== 0x00) nul += 1
    // `ignoreBOM`: a name starting with U+FEFF keeps it (a decoder would drop it, and rename the entry).
    const name = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes.subarray(sp + 1, nul))
    const oid = bytesToHex(bytes.subarray(nul + 1, nul + 21))
    entries.push({ mode, name, oid })
    i = nul + 21
  }
  return entries
}

/** A parsed git commit. */
export interface CommitObject {
  readonly tree: string
  readonly parents: readonly string[]
  readonly author: GitIdent
  readonly committer: GitIdent
  readonly message: string
}

/** A git author/committer identity line. */
export interface GitIdent {
  readonly name: string
  readonly email: string
  /** Commit time (ms epoch). */
  readonly when: number
}

/**
 * "Name <email> 1700000000 +0000". Located with indexOf/lastIndexOf rather than a lazy
 * `^(.*?) <(.*?)> …$` regex, which backtracks quadratically on a hostile author line (a
 * pushed commit object can be any size): the name ends at the first " <", the email at the
 * last ">", and only the short timestamp tail is matched by a regex.
 */
function parseIdent(line: string): GitIdent {
  const open = line.indexOf(' <')
  const close = line.lastIndexOf('>')
  const tail = close > open + 1 && open !== -1 ? /^ (\d+) [+-]\d{4}$/.exec(line.slice(close + 1)) : null
  if (!tail) return { name: line, email: '', when: 0 }
  return {
    name: line.slice(0, open),
    email: line.slice(open + 2, close),
    when: Number(tail[1] ?? '0') * 1000,
  }
}

/**
 * Parse a raw git commit object body the way git reads it (`parse_commit_buffer`): the tree is
 * the FIRST header line, the parents are the `parent` lines directly after it, and author /
 * committer are the first of each. A commit that says otherwise elsewhere in its header is
 * not believed — web and git must agree on what a commit points at. {@link checkCommit}
 * refuses such commits outright where it matters (merges).
 */
export function parseCommit(bytes: Uint8Array): CommitObject {
  // `ignoreBOM`: a leading BOM stays in the text, so the first line is not "tree " (as for git).
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes)
  const sep = text.indexOf('\n\n')
  const header = sep === -1 ? text : text.slice(0, sep)
  const message = sep === -1 ? '' : text.slice(sep + 2)
  const lines = header.split('\n')
  const tree = lines[0]?.startsWith('tree ') ? (lines[0] as string).slice(5).trim() : ''
  const parents: string[] = []
  for (let i = 1; i < lines.length && (lines[i] as string).startsWith('parent '); i++) parents.push((lines[i] as string).slice(7).trim())
  const first = (key: string): string | undefined => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1).trim()
  const none: GitIdent = { name: '', email: '', when: 0 }
  const a = first('author')
  const c = first('committer')
  return { tree, parents, author: a === undefined ? none : parseIdent(a), committer: c === undefined ? none : parseIdent(c), message }
}

/** A commit or tree that `git fsck` would refuse (or that git and this client would read differently). */
export class MalformedObjectError extends Error {
  // A plain field, not a parameter property: this module also loads under Node's
  // strip-only TypeScript (the render fuzz workers), which cannot run those.
  readonly oid: string

  constructor(oid: string, reason: string) {
    super(`malformed git object ${oid.slice(0, 9)}: ${reason}`)
    this.name = 'MalformedObjectError'
    this.oid = oid
  }
}

const OID_HEX = /^[0-9a-f]{40}$/

/**
 * git's author/committer/tagger-line checks, demoted to warnings wherever Dash Forge checks
 * objects (the same list as `RELAXED` in `crates/forge-core/src/pack/fsck.rs`, which gives the
 * reason for each). {@link checkCommit} does not judge that text; the parity tests judge it
 * with `git -c fsck.<id>=ignore fsck --strict`.
 */
export const RELAXED_FSCK_IDS: readonly string[] = [
  'badDate',
  'badDateOverflow',
  'badEmail',
  'badName',
  'badTimezone',
  'missingEmail',
  'missingNameBeforeEmail',
  'missingSpaceBeforeDate',
  'missingSpaceBeforeEmail',
  'zeroPaddedDate',
]

/**
 * Refuse a commit `git fsck --strict` would refuse, or one git and this client could read
 * differently: no NUL byte anywhere (`nulInCommit`); exactly one `tree` (first), then only
 * contiguous `parent` lines, then one `author` line, then one `committer` line, every oid 40
 * lowercase hex; later headers (encoding, gpgsig and its continuation lines, mergetag) may not
 * repeat any of those four. Stricter than git in places (a blank line after the header), never
 * looser.
 *
 * The text of the author and committer lines is not judged: git's checks of it are the relaxed
 * ones ({@link RELAXED_FSCK_IDS}; psf/requests' 5e6ecdad has the time zone `+051800`), and
 * {@link parseIdent} reads it leniently, as git does.
 */
export function checkCommit(oid: string, bytes: Uint8Array): void {
  const bad = (why: string): never => {
    throw new MalformedObjectError(oid, why)
  }
  // Judge the raw bytes as git does: a decoder would drop a leading BOM or hide a NUL.
  const TREE = [0x74, 0x72, 0x65, 0x65, 0x20]
  if (!TREE.every((b, i) => bytes[i] === b)) bad('the object must start with "tree "')
  if (bytes.includes(0x00)) bad('a NUL byte in the commit')
  let sep = -1
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      sep = i
      break
    }
  }
  if (sep === -1) bad('no blank line after the header')
  // latin1 maps every byte to one char, so nothing is dropped or merged.
  const lines = new TextDecoder('latin1').decode(bytes.subarray(0, sep)).split('\n')
  let i = 0
  const take = (key: string): string | null => {
    const line = lines[i]
    if (line === undefined || !line.startsWith(`${key} `)) return null
    i += 1
    return line.slice(key.length + 1)
  }
  const tree = take('tree')
  if (tree === null || !OID_HEX.test(tree)) bad('the first header line must be "tree <oid>"')
  for (let p = take('parent'); p !== null; p = take('parent')) if (!OID_HEX.test(p)) bad('bad parent oid')
  if (take('author') === null) bad('"author" must follow the parents')
  if (take('committer') === null) bad('"committer" must follow the author')
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith(' ')) continue // a continuation of a multi-line header (gpgsig)
    const key = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' '))
    if (key === 'tree' || key === 'parent' || key === 'author' || key === 'committer') bad(`a second "${key}" header`)
    if (key === '') bad('an empty header line')
  }
}

/** Code points HFS+ ignores in names (git's `next_hfs_char`). */
const HFS_IGNORABLE: ReadonlySet<number> = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
])

/** The code points of `name` (valid UTF-8) HFS+ does not ignore. */
function hfsChars(name: string): number[] {
  return [...name].map((c) => c.codePointAt(0) as number).filter((c) => !HFS_IGNORABLE.has(c))
}

/** git's `is_hfs_dot_generic`: `.` + `needle` (ASCII, any case) once HFS+-ignored code points are dropped. */
function isHfsDot(name: string, needle: string): boolean {
  const cs = hfsChars(name)
  if (cs.length !== needle.length + 1 || cs[0] !== 0x2e) return false
  for (let i = 0; i < needle.length; i++) {
    const c = cs[i + 1] as number
    if (c > 127 || String.fromCharCode(c).toLowerCase() !== needle[i]) return false
  }
  return true
}

/** A byte of a C string: 0 past the end. */
const at = (b: Uint8Array, i: number): number => b[i] ?? 0
/** ASCII `tolower` (bytes over 0x7f unchanged, as in the C locale). */
const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 32 : c)
/** `strncasecmp(b + from, s, n) == 0` for ASCII `s`. */
function ncaseEq(b: Uint8Array, from: number, s: string, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const c = at(b, from + i)
    if (lower(c) !== s.charCodeAt(i)) return false
    if (c === 0) return false
  }
  return true
}

/** git's `only_spaces_and_periods` tail: from `i`, only spaces and periods to the end or a `:`. */
function onlySpacesAndPeriods(b: Uint8Array, i: number): boolean {
  for (;;) {
    const c = at(b, i++)
    if (c === 0 || c === 0x3a) return true
    if (c !== 0x20 && c !== 0x2e) return false
  }
}

/** git's `is_ntfs_dotgit`: `.git` or `git~1`, then spaces and periods, up to the end, a separator or `:`. */
function isNtfsDotGit(b: Uint8Array): boolean {
  let i: number
  if (at(b, 0) === 0x2e) {
    if (!ncaseEq(b, 1, 'git', 3)) return false
    i = 4
  } else if (lower(at(b, 0)) === 0x67) {
    if (!ncaseEq(b, 1, 'it', 2) || at(b, 3) !== 0x7e || at(b, 4) !== 0x31) return false
    i = 5
  } else return false
  for (;;) {
    const c = at(b, i++)
    if (c === 0 || c === 0x2f || c === 0x5c || c === 0x3a) return true
    if (c !== 0x2e && c !== 0x20) return false
  }
}

/**
 * git's `is_ntfs_dot_generic`: `.<name>`, its regular 8.3 short name (`<first 6>~1`…`~4`), or
 * its fall-back short name (`<prefix>~<digits>`, where `prefix` is git's hash-derived one, e.g.
 * `gi7eba` for `.gitmodules`), each followed only by spaces and periods up to the end or a `:`.
 */
function isNtfsDot(b: Uint8Array, dotName: string, shortPrefix: string): boolean {
  if (at(b, 0) === 0x2e && ncaseEq(b, 1, dotName, dotName.length)) return onlySpacesAndPeriods(b, dotName.length + 1)
  if (ncaseEq(b, 0, dotName, 6) && at(b, 6) === 0x7e && at(b, 7) >= 0x31 && at(b, 7) <= 0x34) return onlySpacesAndPeriods(b, 8)
  let sawTilde = false
  let i = 0
  for (; i < 8; i++) {
    const c = at(b, i)
    if (c === 0) return false
    if (sawTilde) {
      if (c < 0x30 || c > 0x39) return false
    } else if (c === 0x7e) {
      i += 1
      if (at(b, i) < 0x31 || at(b, i) > 0x39) return false
      sawTilde = true
    } else if (i >= 6) return false
    else if (c & 0x80) return false
    else if (lower(c) !== shortPrefix.charCodeAt(i)) return false
  }
  return onlySpacesAndPeriods(b, i)
}

/**
 * Which of git's special files a tree-entry name is to some filesystem (fsck's
 * `is_hfs_dot*`/`is_ntfs_dot*`, in any directory), or null. `raw` is the name's bytes, `name`
 * the same decoded (valid UTF-8).
 */
export function specialFileName(name: string, raw: Uint8Array = new TextEncoder().encode(name)): 'gitmodules' | 'gitattributes' | null {
  if (isHfsDot(name, 'gitmodules') || isNtfsDot(raw, 'gitmodules', 'gi7eba')) return 'gitmodules'
  if (isHfsDot(name, 'gitattributes') || isNtfsDot(raw, 'gitattributes', 'gi7d29')) return 'gitattributes'
  return null
}

/** `.gitignore` or `.mailmap` under a name a filesystem reads as one (fsck reports them as symlinks). */
function isIgnoreOrMailmap(name: string, raw: Uint8Array): boolean {
  return isHfsDot(name, 'gitignore') || isNtfsDot(raw, 'gitignore', 'gi250a') || isHfsDot(name, 'mailmap') || isNtfsDot(raw, 'mailmap', 'maba30')
}

/** `.`, `..` (also once HFS+-ignored code points are dropped), or a name git reads as the repository directory. */
function isDotGitLike(name: string, raw: Uint8Array): boolean {
  const folded = String.fromCodePoint(...hfsChars(name))
  return folded === '.' || folded === '..' || isHfsDot(name, 'git') || isNtfsDotGit(raw)
}

/** The tree-entry modes git writes (fsck refuses anything else). */
export const GIT_TREE_MODES: ReadonlySet<number> = new Set([0o40000, 0o100644, 0o100755, 0o120000, 0o160000])

/** The longest entry name fsck accepts (`max_tree_entry_len`; longer is `largePathname`). */
export const MAX_TREE_ENTRY_NAME = 4096

/** The deepest tree nesting git walks (`core.maxTreeDepth`; the root tree is depth 0). */
export const MAX_TREE_DEPTH = 2048

/** The refusal for tree `oid` nested past {@link MAX_TREE_DEPTH}. */
export function treeTooDeep(oid: string): MalformedObjectError {
  return new MalformedObjectError(oid, `trees nested more than ${MAX_TREE_DEPTH} deep, deeper than git walks`)
}

/** git's tree order: bytes, a subtree's name compared as if it ended in `/`. */
function treeKey(name: Uint8Array, mode: number): Uint8Array {
  if (mode !== 0o40000) return name
  const k = new Uint8Array(name.length + 1)
  k.set(name)
  k[name.length] = 0x2f
  return k
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  return a.length - b.length
}

/** The bytes of a tree holding `entries` (names unique), in git's order, as git writes it. */
export function serializeTree(entries: readonly TreeEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const rows = entries.map((e) => ({ e, name: enc.encode(e.name) }))
  rows.sort((a, b) => compareBytes(treeKey(a.name, a.e.mode), treeKey(b.name, b.e.mode)))
  return concatBytes(...rows.flatMap(({ e, name }) => [enc.encode(`${e.mode.toString(8)} `), name, new Uint8Array([0]), hexToBytes(e.oid)]))
}

/**
 * Refuse a tree `git fsck --strict` would refuse: every entry `<mode> <name>\0<20 bytes>` with a
 * mode git writes (no leading zeros), no entry naming the null oid, names non-empty, at most
 * {@link MAX_TREE_ENTRY_NAME} bytes, without `/`, not `.`, `..` or anything a filesystem reads as
 * `.git`, no name twice, entries in git's order, nothing left over; `.gitmodules` and
 * `.gitattributes` (or a name a filesystem reads as one) only as a file, and `.gitignore` and
 * `.mailmap` never as a symbolic link (fsck reports those too). Stricter than git in
 * places (names must be UTF-8 and without `\`), never looser.
 */
export function checkTree(oid: string, bytes: Uint8Array): void {
  const bad = (why: string): never => {
    throw new MalformedObjectError(oid, why)
  }
  const names = new Set<string>()
  let prev: Uint8Array | null = null
  let i = 0
  while (i < bytes.length) {
    let sp = i
    while (sp < bytes.length && bytes[sp] !== 0x20) sp += 1
    const modeText = new TextDecoder('latin1').decode(bytes.subarray(i, sp))
    if (!/^[1-7][0-7]*$/.test(modeText)) bad(`bad mode "${modeText}"`)
    const mode = parseInt(modeText, 8)
    if (!GIT_TREE_MODES.has(mode)) bad(`mode ${modeText} is not one git writes`)
    let nul = sp + 1
    while (nul < bytes.length && bytes[nul] !== 0x00) nul += 1
    if (nul + 21 > bytes.length) bad('truncated entry')
    const raw = bytes.subarray(sp + 1, nul)
    if (bytes.subarray(nul + 1, nul + 21).every((b) => b === 0)) bad('an entry naming the null oid')
    if (raw.length > MAX_TREE_ENTRY_NAME) bad(`an entry name over ${MAX_TREE_ENTRY_NAME} bytes`)
    // Names must be UTF-8: paths are compared and shown as text, and must round-trip.
    let name = ''
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    } catch {
      bad('an entry name that is not UTF-8')
    }
    if (name === '' || name.includes('/') || name.includes('\\') || isDotGitLike(name, raw)) bad(`bad entry name ${JSON.stringify(name)}`)
    const special = specialFileName(name, raw)
    if (special !== null && mode !== 0o100644 && mode !== 0o100755) bad(`".${special}" (as ${JSON.stringify(name)}) that is not a file`)
    // fsck --strict reports these (gitignoreSymlink, mailmapSymlink): refused too.
    if (mode === 0o120000 && isIgnoreOrMailmap(name, raw)) bad(`${JSON.stringify(name)} as a symbolic link`)
    if (names.has(name)) bad(`entry ${JSON.stringify(name)} twice`)
    names.add(name)
    const key = treeKey(raw, mode)
    if (prev !== null && compareBytes(prev, key) >= 0) bad('entries out of order')
    prev = key
    i = nul + 21
  }
}

/** The subject (first line) of a commit message. */
export function commitSubject(message: string): string {
  const nl = message.indexOf('\n')
  return (nl === -1 ? message : message.slice(0, nl)).trim()
}

/** Decode blob bytes as text if it looks like text (no NUL in the first 8 KB). */
export function decodeTextBlob(bytes: Uint8Array): string | null {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192))
  for (const b of probe) {
    if (b === 0) return null
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
