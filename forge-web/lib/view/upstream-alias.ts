/**
 * Which Forge repo mirrors a GitHub repo (CJ-3), for `/github.com/<owner>/<repo>` and for a
 * `/dashpay/dash` that names no Forge repo. A mirror says what it mirrors in the description its
 * owner wrote (`… (mirror of github.com/dashpay/dash)`, `mirrorSourceOfRepo`; a fork, which copies
 * its parent's description, is never one). Anyone can write that, so a claim alone opens a repo
 * only when it is the only one among every repo of that name, or when the network's showcase
 * vouches for exactly one. Otherwise the visitor picks.
 */

import { ACTIVE_NETWORK } from '../constants'
import type { DiscoveredRepo } from './discovery'
import { mirrorSourceOfRepo } from './mirror-source'
import { showcaseFor } from './showcase'

/** The repo ids this site's showcase vouches for. */
export const SHOWCASE_IDS: ReadonlySet<string> = new Set(showcaseFor(ACTIVE_NETWORK.key).map((e) => e.repoId))

/** Whether `repo` claims to mirror `github.com/<owner>/<name>` (any case; never a fork or a private repo). */
export function claimsToMirror(repo: DiscoveredRepo, owner: string, name: string): boolean {
  const source = mirrorSourceOfRepo({ description: repo.description, forkOf: repo.forkOf ?? null }, 'issue')
  return repo.visibility === 'public' && source?.label.toLowerCase() === `github.com/${owner}/${name}`.toLowerCase()
}

/** The mirrors of `github.com/<owner>/<name>` among `repos` (same name, any owner), showcase first. */
export function mirrorsOf(owner: string, name: string, repos: readonly DiscoveredRepo[], showcaseIds: ReadonlySet<string> = SHOWCASE_IDS): DiscoveredRepo[] {
  return repos.filter((r) => claimsToMirror(r, owner, name)).sort((a, b) => Number(showcaseIds.has(b.key)) - Number(showcaseIds.has(a.key)))
}

/**
 * The mirror to open without asking: the one showcase repo among the claims, else the only claim,
 * but only when `complete` (every repo of that name was read: one beyond the page could be another).
 */
export function mirrorToOpen(mirrors: readonly DiscoveredRepo[], complete: boolean, showcaseIds: ReadonlySet<string> = SHOWCASE_IDS): DiscoveredRepo | null {
  const vouched = mirrors.filter((m) => showcaseIds.has(m.key))
  if (vouched.length === 1) return vouched[0] ?? null
  return complete && vouched.length === 0 && mirrors.length === 1 ? (mirrors[0] ?? null) : null
}

/** What a page does with the repos named like a GitHub repo (`reposNamed`'s answer). */
export interface UpstreamMatch {
  readonly mirrors: DiscoveredRepo[]
  /** The mirror to open straight away, or null. */
  readonly open: DiscoveredRepo | null
  /** More repos share the name than were read, so "no mirror" is not certain. */
  readonly partial: boolean
}

export function matchUpstream(owner: string, name: string, named: { readonly repos: readonly DiscoveredRepo[]; readonly more: boolean }, showcaseIds: ReadonlySet<string> = SHOWCASE_IDS): UpstreamMatch {
  const mirrors = mirrorsOf(owner, name, named.repos, showcaseIds)
  return { mirrors, open: mirrorToOpen(mirrors, !named.more, showcaseIds), partial: named.more }
}

/** The GitHub sub-pages the short-URL shim maps onto a repo page; anything else opens the repo's home. */
const MAPPED = new Set(['tree', 'blob', 'blame', 'commits', 'commit', 'issues', 'pull', 'pulls', 'releases', 'branches', 'tags', 'compare', 'labels', 'milestones', 'stargazers', 'security'])

/** Whether the rest of a GitHub path (`issues/12`) names a page Forge has. */
export function mapsToRepoPage(rest: string): boolean {
  return MAPPED.has(rest.split('/')[0] ?? '')
}
