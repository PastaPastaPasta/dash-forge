/**
 * The optional check of a mirror claim against GitHub, run from the viewer's browser when they
 * ask (TS-01, CJ-3): does the source list this repo in its back-link file
 * (`lib/rules/mirror-backlink.ts`), and does the source's branch point where this mirror's does?
 *
 * Nothing here runs unasked. Each check tells github.com the viewer's address, as loading an
 * image from a host does, so the page offers it as a button and shows "not checked" until then:
 * an unchecked claim is never shown as a confirmed one. A failed or refused request is "couldn't
 * check", never a match. Results are kept for the session, so moving between a repo's pages does
 * not ask again (GitHub allows 60 anonymous API requests an hour per address).
 */

import { BACKLINK_FILE, BACKLINK_MAX_BYTES, readBacklink } from '../rules/mirror-backlink'
import { GITHUB_API } from '../mirror/wizard'
import type { MirrorSource } from './mirror-source'

/** What the source's back-link file says about this repo. */
export type BacklinkCheck =
  /** The file lists this repo: the source vouches for the mirror. */
  | { readonly kind: 'listed' }
  /** The file is there and lists other repos only. */
  | { readonly kind: 'not-listed' }
  /** The source has no back-link file, or one that is not a list of mirrors. */
  | { readonly kind: 'none' }
  /** GitHub did not answer usably. */
  | { readonly kind: 'failed'; readonly reason: string }

/** How the source's branch compares with this mirror's. */
export type HeadCheck =
  | { readonly kind: 'match'; readonly oid: string }
  | { readonly kind: 'differs'; readonly upstream: string }
  /** The source has no branch of that name. */
  | { readonly kind: 'no-branch' }
  | { readonly kind: 'failed'; readonly reason: string }

export interface MirrorCheck {
  readonly backlink: BacklinkCheck
  /** Null when this mirror has no commit on the branch to compare. */
  readonly head: HeadCheck | null
  readonly checkedAt: number
}

/** `owner/name` of a github.com source, or null for any other host (only GitHub is checked). */
export function githubRepoOf(source: MirrorSource): { readonly owner: string; readonly name: string } | null {
  if (source.host !== 'github.com') return null
  const [owner, name, ...rest] = source.label.slice('github.com/'.length).split('/')
  return owner && name && rest.length === 0 ? { owner, name } : null
}

/** Where the source's back-link file is served from (the default branch, CORS-open). */
export function backlinkUrl(repo: { readonly owner: string; readonly name: string }): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/HEAD/${BACKLINK_FILE}`
}

/** GitHub's page for adding the back-link file, prefilled with `content`. */
export function newBacklinkUrl(repo: { readonly owner: string; readonly name: string }, branch: string, content: string): string {
  const q = new URLSearchParams({ filename: BACKLINK_FILE, value: content })
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/new/${encodeURIComponent(branch)}?${q}`
}

const UNREACHABLE = "Couldn't reach GitHub."

async function checkBacklink(repo: { owner: string; name: string }, repoId: string, fetchImpl: typeof fetch): Promise<BacklinkCheck> {
  let res: Response
  try {
    res = await fetchImpl(backlinkUrl(repo), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  } catch {
    return { kind: 'failed', reason: UNREACHABLE }
  }
  if (res.status === 404) return { kind: 'none' }
  if (!res.ok) return { kind: 'failed', reason: `GitHub answered ${res.status}.` }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > BACKLINK_MAX_BYTES) return { kind: 'none' }
  const read = readBacklink(await res.text(), repoId)
  return !read.valid ? { kind: 'none' } : read.listed ? { kind: 'listed' } : { kind: 'not-listed' }
}

async function checkHead(repo: { owner: string; name: string }, branch: string, oid: string, fetchImpl: typeof fetch): Promise<HeadCheck> {
  let res: Response
  try {
    res = await fetchImpl(`${GITHUB_API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${encodeURIComponent(branch)}`, {
      headers: { Accept: 'application/vnd.github.sha' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    return { kind: 'failed', reason: UNREACHABLE }
  }
  if (res.status === 404 || res.status === 422) return { kind: 'no-branch' }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'failed', reason: 'GitHub allows 60 checks an hour from one address, and this one has used them.' }
  }
  if (!res.ok) return { kind: 'failed', reason: `GitHub answered ${res.status}.` }
  const upstream = (await res.text()).trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(upstream)) return { kind: 'failed', reason: 'GitHub did not name a commit.' }
  return upstream === oid.toLowerCase() ? { kind: 'match', oid } : { kind: 'differs', upstream }
}

const checked = new Map<string, Promise<MirrorCheck>>()

/**
 * Check `repoId`'s claim to mirror `source`: the back-link file and, when `head` is given, the
 * source's `head.branch` against this mirror's `head.oid`. Kept for the session per repo and head.
 */
export function checkMirrorClaim(
  source: MirrorSource,
  repoId: string,
  head: { readonly branch: string; readonly oid: string } | null,
  fetchImpl: typeof fetch = fetch,
): Promise<MirrorCheck> | null {
  const repo = githubRepoOf(source)
  if (repo === null) return null
  const key = `${source.label}:${repoId}:${head?.branch ?? ''}:${head?.oid ?? ''}`
  const hit = checked.get(key)
  if (hit !== undefined) return hit
  const run = Promise.all([checkBacklink(repo, repoId, fetchImpl), head === null ? null : checkHead(repo, head.branch, head.oid, fetchImpl)]).then(([backlink, headCheck]) => ({
    backlink,
    head: headCheck,
    checkedAt: Date.now(),
  }))
  checked.set(key, run)
  // A failed check is asked again next time; a definite answer is kept for the session.
  void run.then((r) => {
    if (r.backlink.kind === 'failed' || r.head?.kind === 'failed') checked.delete(key)
  })
  return run
}

/** The session's answer for a claim, when it was already checked (no request). */
export function checkedClaim(source: MirrorSource, repoId: string, head: { readonly branch: string; readonly oid: string } | null): Promise<MirrorCheck> | null {
  return checked.get(`${source.label}:${repoId}:${head?.branch ?? ''}:${head?.oid ?? ''}`) ?? null
}

/** Forget every answer (tests). */
export function clearMirrorChecks(): void {
  checked.clear()
}
