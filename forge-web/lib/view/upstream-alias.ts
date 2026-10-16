/**
 * Which Forge repo mirrors a GitHub repo (CJ-3), for `/github.com/<owner>/<repo>` and for a
 * `/dashpay/dash` that names no Forge repo. A mirror says what it mirrors in the description its
 * owner wrote (`… (mirror of github.com/dashpay/dash)`, `mirrorSourceOfRepo`; a fork, which copies
 * its parent's description, is never one). Anyone can write that, so a claim alone opens nothing
 * (ABU-04): a repo opens by itself only when the network's showcase vouches for it, or when the
 * source's back-link file lists it (`mirror-check.ts`, seen this session). Otherwise the visitor
 * picks, from repos that "say they mirror" it.
 */

import { ACTIVE_NETWORK } from '../constants'
import type { DiscoveredRepo } from './discovery'
import { isMirrorVerified } from './mirror-check'
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

/** The mirrors of `github.com/<owner>/<name>` whose claim the source's back-link file confirmed this session. */
export function verifiedMirrors(owner: string, name: string, mirrors: readonly DiscoveredRepo[]): ReadonlySet<string> {
  const label = `github.com/${owner}/${name}`
  return new Set(mirrors.filter((m) => isMirrorVerified(label, m.key)).map((m) => m.key))
}

/**
 * The mirror to open without asking: the one showcase repo among the claims, else the one the
 * source confirmed (`verified`: ids whose back-link check listed them). A claim alone never
 * opens, however alone it is: it is the owner's own description. Two vouched or two confirmed
 * mirrors are the visitor's pick.
 */
export function mirrorToOpen(mirrors: readonly DiscoveredRepo[], showcaseIds: ReadonlySet<string> = SHOWCASE_IDS, verified: ReadonlySet<string> = new Set()): DiscoveredRepo | null {
  const vouched = mirrors.filter((m) => showcaseIds.has(m.key))
  if (vouched.length > 0) return vouched.length === 1 ? (vouched[0] ?? null) : null
  const confirmed = mirrors.filter((m) => verified.has(m.key))
  return confirmed.length === 1 ? (confirmed[0] ?? null) : null
}

/** What a page does with the repos named like a GitHub repo (`reposNamed`'s answer). */
export interface UpstreamMatch {
  readonly mirrors: DiscoveredRepo[]
  /** The mirror to open straight away, or null. */
  readonly open: DiscoveredRepo | null
  /** More repos share the name than were read, so "no mirror" is not certain. */
  readonly partial: boolean
  /** The claims the source confirmed this session (their ids). */
  readonly verified: ReadonlySet<string>
}

export function matchUpstream(
  owner: string,
  name: string,
  named: { readonly repos: readonly DiscoveredRepo[]; readonly more: boolean },
  showcaseIds: ReadonlySet<string> = SHOWCASE_IDS,
  verified: ReadonlySet<string> | null = null,
): UpstreamMatch {
  const mirrors = mirrorsOf(owner, name, named.repos, showcaseIds)
  const confirmed = verified ?? verifiedMirrors(owner, name, mirrors)
  return { mirrors, open: mirrorToOpen(mirrors, showcaseIds, confirmed), partial: named.more, verified: confirmed }
}

/** The GitHub sub-pages the short-URL shim maps onto a repo page; anything else opens the repo's home. */
const MAPPED = new Set(['tree', 'blob', 'blame', 'commits', 'commit', 'issues', 'pull', 'pulls', 'releases', 'branches', 'tags', 'compare', 'labels', 'milestones', 'stargazers', 'security'])

/** Whether the rest of a GitHub path (`issues/12`) names a page Forge has. */
export function mapsToRepoPage(rest: string): boolean {
  return MAPPED.has(rest.split('/')[0] ?? '')
}
