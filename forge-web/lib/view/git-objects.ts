/**
 * git object parsers (view glue) — decode the raw bytes {@link BrowseReader} returns.
 *
 * The browse plane hands back `{ type, bytes }` for a git object; these helpers turn a
 * `tree` into its entries and a `commit` into its header fields for rendering. Pure byte
 * parsing, no network. Blob bytes are used as-is (text-decoded or offered as a raw download).
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

function parseIdent(line: string): GitIdent {
  // "Name <email> 1700000000 +0000"
  const m = line.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/)
  if (!m) return { name: line, email: '', when: 0 }
  return {
    name: m[1] ?? '',
    email: m[2] ?? '',
    when: Number(m[3] ?? '0') * 1000,
  }
}

/** Parse a raw git commit object body. */
export function parseCommit(bytes: Uint8Array): CommitObject {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const sep = text.indexOf('\n\n')
  const header = sep === -1 ? text : text.slice(0, sep)
  const message = sep === -1 ? '' : text.slice(sep + 2)
  let tree = ''
  const parents: string[] = []
  let author: GitIdent = { name: '', email: '', when: 0 }
  let committer: GitIdent = { name: '', email: '', when: 0 }
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim()
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim())
    else if (line.startsWith('author ')) author = parseIdent(line.slice(7).trim())
    else if (line.startsWith('committer ')) committer = parseIdent(line.slice(10).trim())
  }
  return { tree, parents, author, committer, message }
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
