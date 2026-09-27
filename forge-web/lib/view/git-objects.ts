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

import { bytesToHex } from '@noble/hashes/utils.js'

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
    const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(sp + 1, nul))
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
  constructor(
    readonly oid: string,
    reason: string,
  ) {
    super(`malformed git object ${oid.slice(0, 9)}: ${reason}`)
    this.name = 'MalformedObjectError'
  }
}

const OID_HEX = /^[0-9a-f]{40}$/
/** `name <email> <date> <tz>`, as fsck_ident: no `<`/`>` stray, no zero-padded date. */
const IDENT = /^[^<>\n]* <[^<>\n]*> (0|[1-9]\d*) [+-]\d{4}$/

/**
 * Refuse a commit `git fsck` would refuse, or one git and this client could read differently:
 * exactly one `tree` (first), then only contiguous `parent` lines, then `author`, then
 * `committer`, each well-formed, every oid 40 lowercase hex; later headers (encoding, gpgsig
 * and its continuation lines, mergetag) may not repeat any of those four.
 */
export function checkCommit(oid: string, bytes: Uint8Array): void {
  const bad = (why: string): never => {
    throw new MalformedObjectError(oid, why)
  }
  // Judge the raw bytes as git does: a decoder would drop a leading BOM or hide a NUL.
  const TREE = [0x74, 0x72, 0x65, 0x65, 0x20]
  if (!TREE.every((b, i) => bytes[i] === b)) bad('the object must start with "tree "')
  let sep = -1
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x00) bad('a NUL byte in the header')
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
  const author = take('author')
  if (author === null || !IDENT.test(author)) bad('"author" must follow the parents, well-formed')
  const committer = take('committer')
  if (committer === null || !IDENT.test(committer)) bad('"committer" must follow the author, well-formed')
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith(' ')) continue // a continuation of a multi-line header (gpgsig)
    const key = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' '))
    if (key === 'tree' || key === 'parent' || key === 'author' || key === 'committer') bad(`a second "${key}" header`)
    if (key === '') bad('an empty header line')
  }
}

/** Characters HFS+ ignores in names (as `is_hfs_dotgit`). */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g

/** A name with what HFS+ ignores removed, and as NTFS resolves it (lowercase, no stream, no trailing dots or spaces). */
function foldedName(name: string): { readonly hfs: string; readonly ntfs: string } {
  const hfs = name.replace(HFS_IGNORABLE, '')
  const ntfs = (hfs.split(':')[0] as string).toLowerCase().replace(/[. ]+$/, '')
  return { hfs, ntfs }
}

/** `.`, `..`, or a name some filesystem reads as the repository directory (`.git.`, `GIT~1`, `.g‌it`). */
function isDotGitLike(name: string): boolean {
  const { hfs, ntfs } = foldedName(name)
  return hfs === '.' || hfs === '..' || ntfs === '.git' || /^\.?git~[1-9]$/.test(ntfs)
}

/** The submodule file, or a name some filesystem reads as it (`GITMOD~1`). */
function isDotGitModulesLike(name: string): boolean {
  const { ntfs } = foldedName(name)
  return ntfs === '.gitmodules' || /^gitmod~[1-9]$/.test(ntfs)
}

/** The tree-entry modes git writes (fsck refuses anything else). */
export const GIT_TREE_MODES: ReadonlySet<number> = new Set([0o40000, 0o100644, 0o100755, 0o120000, 0o160000])

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

/**
 * Refuse a tree `git fsck` would refuse: every entry `<mode> <name>\0<20 bytes>` with a mode
 * git writes (no leading zeros), names non-empty without `/` and not `.`, `..` or `.git`
 * (any case), no name twice, entries in git's order; nothing left over.
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
    // Names must be UTF-8: the merge (isomorphic-git) decodes them, and would rewrite others.
    let name = ''
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    } catch {
      bad('an entry name that is not UTF-8')
    }
    if (name === '' || name.includes('/') || name.includes('\\') || isDotGitLike(name)) bad(`bad entry name ${JSON.stringify(name)}`)
    if (mode === 0o120000 && isDotGitModulesLike(name)) bad('".gitmodules" as a symbolic link')
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
