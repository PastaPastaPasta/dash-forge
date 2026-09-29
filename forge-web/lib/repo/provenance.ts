/**
 * Where an imported issue, PR, comment, review or release came from (FG-6: L-04, L-36, L-37,
 * L-45). forge-import signs everything with the mirror identity and records the original in two
 * places:
 *
 * - the `imported` object on issues, PRs, comments and reviews: `{author, createdAt (unix s), url}`;
 * - the provenance block its bodies open with:
 *   - `> Mirrored from github.com/o/r#12 by @bob (issue, 2018-06-22)`;
 *   - a PR adds `> Base <oid> · head <branch or owner:branch>`;
 *   - a review names its verdict: `(review, approved, …)`;
 *   - release notes open with `> Published on github.com by @x on 2026-08-03`.
 *
 * Anyone can write an `imported` object or such text, so this module only parses. A caller shows
 * it as the original author, date or verdict only when the document's owner is trusted to mirror
 * (the repo owner or a current maintainer: {@link trustedOrigin}, the same trust set as the
 * mirror note and issue numbering).
 */

import type { PlainDocument } from '../sdk'

/** An imported item's original author and time. */
export interface Origin {
  /** The source login (`bob`), without `@`. */
  readonly author: string
  /** Milliseconds since the epoch (0 when the source gave none). */
  readonly createdAt: number
  /** The item on the source forge. */
  readonly url: string
  /** `github.com`, `gitlab.com`, … (from `url`), or `''`. */
  readonly host: string
}

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.host : ''
  } catch {
    return ''
  }
}

/** The `imported` object of `doc` as an {@link Origin}, or null when it has none. */
export function originOf(doc: PlainDocument): Origin | null {
  const v = doc['imported']
  if (typeof v !== 'object' || v === null) return null
  const o = v as PlainDocument
  const author = typeof o['author'] === 'string' ? o['author'] : ''
  const at = typeof o['createdAt'] === 'number' ? o['createdAt'] : 0
  const url = typeof o['url'] === 'string' ? o['url'] : ''
  if (author === '' && url === '') return null
  return { author, createdAt: at * 1000, url, host: hostOf(url) }
}

/** `origin` when `owner` (the document's signer) is trusted to mirror, else null. */
export function trustedOrigin(origin: Origin | null | undefined, owner: string, trusted: ReadonlySet<string> | null): Origin | null {
  if (!origin || trusted === null || !trusted.has(owner)) return null
  return origin
}

const PROVENANCE = /^> Mirrored from \S+ by @\S+ \(([^)]*)\)/
const PULL_ORIGIN = /^> (?:Base ([0-9a-f]{40}|[0-9a-f]{64}))?(?: · )?(?:head (\S{1,200}))?\s*$/
// (a bare `>` never matches: both groups empty is rejected below)

/** What a mirrored PR's body says about where it branched from and its head branch. */
export interface PullOrigin {
  /** The source's base commit (the merge base when opened), hex, or `''`. */
  readonly baseOid: string
  /** `branch`, or `owner:branch` for a fork, or `''`. */
  readonly headLabel: string
}

/**
 * The `> Base … · head …` line forge-import writes after a PR's provenance line, or null. Only
 * the line right after the provenance quote counts (an empty `>` line may separate them).
 */
export function pullOriginOf(body: string): PullOrigin | null {
  const [first = '', second = '', third = ''] = body.split('\n', 3)
  if (!PROVENANCE.test(first)) return null
  const m = PULL_ORIGIN.exec(second === '>' ? third : second)
  if (m === null || (m[1] === undefined && m[2] === undefined)) return null
  return { baseOid: m[1] ?? '', headLabel: m[2] ?? '' }
}

/** A review's verdict at the source, from its provenance line (`(review, approved, 2026-…)`). */
export type ImportedVerdict = 'approved' | 'requested changes' | 'commented'

const IMPORTED_VERDICTS: readonly ImportedVerdict[] = ['approved', 'requested changes', 'commented']

export function importedVerdictOf(body: string): ImportedVerdict | null {
  const m = PROVENANCE.exec(body.split('\n', 1)[0] ?? '')
  const kind = m?.[1] ?? ''
  if (!kind.startsWith('review, ')) return null
  const verdict = kind.slice('review, '.length).split(',')[0]?.trim()
  return IMPORTED_VERDICTS.find((v) => v === verdict) ?? null
}

/** Who published a mirrored release, and when (its notes' first line). */
export interface ReleasePublished {
  readonly host: string
  readonly author: string
  /** Milliseconds since the epoch (midnight UTC of the day; the line records the date). */
  readonly at: number
}

const PUBLISHED = /^> Published on ([a-z0-9.-]+(?::\d+)?)(?: by @(\S+))? on (\d{4}-\d{2}-\d{2})\s*$/

/** The publisher line of a mirrored release's notes, and the notes without it. */
export function releasePublishedOf(notes: string): { published: ReleasePublished | null; rest: string } {
  const [first = '', ...rest] = notes.split('\n')
  const m = PUBLISHED.exec(first)
  if (m === null) return { published: null, rest: notes }
  const at = Date.parse(`${m[3]}T00:00:00Z`)
  if (!Number.isFinite(at)) return { published: null, rest: notes }
  return { published: { host: m[1]!, author: m[2] ?? '', at }, rest: rest.join('\n').replace(/^\n+/, '') }
}
