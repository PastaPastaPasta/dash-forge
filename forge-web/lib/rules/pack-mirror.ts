/**
 * Pack mirrors (forge-v2.md §2 `packMirror`, §9.1; Rust `forge_core::rules::pack_mirror`): another
 * copy of a pack that anyone may record, read only when every copy the repository's own manifests
 * record has failed. A mirror's bytes must hash to the pack's SHA-256 before a reader uses them,
 * so a bad mirror can only fail to serve. Both clients apply these rules identically (vectors
 * `pack_mirror_uris__*`, `pack_mirror_order__*`).
 */

import { compareKey } from './oid'
import type { Role, Visibility } from './v2'

/** `kind` 1: an `https://` URL (a web host, or an S3 bucket's public URL). */
export const KIND_HTTPS = 1
/** `kind` 2: `ipfs://<cid>`, read through the reader's IPFS gateways. */
export const KIND_IPFS = 2
/** Addresses one record holds (the contract's `uris.maxItems`). */
export const MAX_URIS = 4
/** Characters one address holds (the contract's `maxLength`, in characters). */
export const MAX_URI_CHARS = 300
/** Distinct mirror addresses one read of a pack tries, over every record. */
export const MIRROR_URIS_TRIED = 8

/** Why a writer's addresses cannot be recorded. */
export type UriProblem = 'none' | 'tooMany' | 'length' | 'address' | 'ipfsPath' | 'duplicate' | 'mixedKinds'

/** {@link checkMirrorUris}'s verdict: the kind, or the first problem (and the address it is with). */
export type UriCheck = { readonly kind: number } | { readonly problem: UriProblem; readonly index?: number }

/** POSIX `[:space:]` (ASCII), as the contract's pattern reads it. */
const SPACE = /[ \t\n\v\f\r]/

function charCount(s: string): number {
  return [...s].length
}

/** Empty, or `/`, `?` or `#` and no whitespace after: the pattern's `([/?#][^[:space:]]*)?$`. */
function isTail(rest: string): boolean {
  return rest === '' || (/^[/?#]/.test(rest) && !SPACE.test(rest))
}

/**
 * The kind `uri` is an address of: {@link KIND_IPFS} for a bare `ipfs://<cid>`, {@link KIND_HTTPS}
 * for an `https://` URL the contract admits; null for anything else (an ipfs address with a path
 * included).
 */
export function uriKind(uri: string): number | null {
  const chars = charCount(uri)
  if (chars === 0 || chars > MAX_URI_CHARS) return null
  if (uri.startsWith('ipfs://')) return /^[A-Za-z0-9]+$/.test(uri.slice(7)) ? KIND_IPFS : null
  if (!uri.startsWith('https://')) return null
  const rest = uri.slice(8)
  const cut = rest.search(/[/?#]/)
  const host = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  return host !== '' && !host.includes('@') && !SPACE.test(host) && isTail(tail) ? KIND_HTTPS : null
}

/** Whether the contract's pattern admits `uri` (an ipfs address may carry a path there). */
function admitted(uri: string): boolean {
  if (!uri.startsWith('ipfs://')) return uriKind(uri) === KIND_HTTPS
  const m = /^[A-Za-z0-9]+/.exec(uri.slice(7))
  return m !== null && isTail(uri.slice(7 + m[0].length))
}

/** Whether a writer may record `uris` as one mirror, and as which kind. */
export function checkMirrorUris(uris: readonly string[]): UriCheck {
  if (uris.length === 0) return { problem: 'none' }
  if (uris.length > MAX_URIS) return { problem: 'tooMany' }
  const kinds: number[] = []
  for (const [index, uri] of uris.entries()) {
    const chars = charCount(uri)
    if (chars === 0 || chars > MAX_URI_CHARS) return { problem: 'length', index }
    if (!admitted(uri)) return { problem: 'address', index }
    const kind = uriKind(uri)
    if (kind === null) return { problem: 'ipfsPath', index }
    if (uris.slice(0, index).includes(uri)) return { problem: 'duplicate', index }
    kinds.push(kind)
  }
  if (kinds.some((k) => k !== kinds[0])) return { problem: 'mixedKinds' }
  return { kind: kinds[0] as number }
}

/** One `packMirror` document, flattened. */
export interface MirrorRecord {
  readonly id: string
  /** The writer's current role in the repository; null for anyone who is not a member now. */
  readonly ownerRole?: Role | null
  readonly createdAt: number
  /** The pack it mirrors (hex). */
  readonly packHash: string
  readonly kind: number
  readonly uris: readonly string[]
}

/** What {@link mirrorReadOrder} reads. */
export interface MirrorReadInput {
  /** The pack being read (hex). */
  readonly packHash: string
  /** The pack hashes the repository's own manifests list (hex). */
  readonly listed: readonly string[]
  readonly visibility: Visibility
  readonly mirrors: readonly MirrorRecord[]
}

/** Maintainers first, then other members, then everyone else (the pack-copy rank). */
function rank(role: Role | null | undefined): number {
  return role === 'maintainer' ? 0 : role == null ? 2 : 1
}

/**
 * The mirror addresses a reader tries for `packHash`, in order: none for a private repository or
 * an unlisted pack; members' records first, each group by `(createdAt, id)`; unknown kinds and
 * addresses that do not fit their record's kind skipped; at most {@link MIRROR_URIS_TRIED}.
 */
export function mirrorReadOrder(input: MirrorReadInput): string[] {
  const want = input.packHash.toLowerCase()
  if (input.visibility === 'private' || !input.listed.some((h) => h.toLowerCase() === want)) return []
  const records = input.mirrors
    .filter((m) => m.packHash.toLowerCase() === want && (m.kind === KIND_HTTPS || m.kind === KIND_IPFS))
    .sort((a, b) => rank(a.ownerRole) - rank(b.ownerRole) || compareKey(a, b))
  const out: string[] = []
  for (const m of records) {
    for (const uri of m.uris) {
      if (uriKind(uri) === m.kind && !out.includes(uri)) {
        out.push(uri)
        if (out.length === MIRROR_URIS_TRIED) return out
      }
    }
  }
  return out
}
