/**
 * The one place issue, PR and `#n` links are built (FG-2 L-39): Markdown autolinks, the jump
 * box and the number resolver all go through these, so a change in how numbers map (the
 * numbering rules of `forge-v2.md` §6) is made here once.
 */

import { useMemo } from 'react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import type { MarkdownLinks } from '@/components/markdown-view'
import { mirrorSourceOfDescription } from '@/lib/view/mirror-source'
import { forgeRepoOfLabel, type ForgeRepo, type NamedRepo, type RefTarget } from '@/lib/view/ref-targets'

/** Issue `n` of `addr`. */
export function issueHref(addr: RepoAddress, n: number): string {
  return repoHref('/repo/issue', addr, { number: String(n) })
}

/** PR `n` of `addr`. */
export function pullHref(addr: RepoAddress, n: number): string {
  return repoHref('/repo/pull', addr, { number: String(n) })
}

/**
 * `#n` of `addr` when it is not known whether an issue or a PR holds it (GitHub numbers both
 * in one sequence): the resolver page opens whichever exists. `upstream`: the number is the
 * mirrored forge's (imported content), so a row here counts only when the import wrote it,
 * and the source's own page is offered otherwise.
 */
export function numberHref(addr: RepoAddress, n: number, upstream = false): string {
  return repoHref('/repo/number', addr, { number: String(n), ...(upstream ? { upstream: '1' } : {}) })
}

/** A Forge profile by DPNS name. */
export function profileHref(name: string): string {
  return `/u/?name=${encodeURIComponent(name)}`
}

/** `addr`, or another Forge repo `owner/name` a reference names. */
const repoOf = (addr: RepoAddress, repo: NamedRepo | null): RepoAddress => (repo === null ? addr : { owner: repo.owner, name: repo.name })

/** The href of a reference target, in `addr`'s pages. */
export function targetHref(addr: RepoAddress, target: RefTarget): string {
  switch (target.kind) {
    case 'number':
      return numberHref(repoOf(addr, target.repo), target.n, target.upstream)
    case 'commit':
      return repoHref('/repo/commit', repoOf(addr, target.repo), { oid: target.oid })
    case 'profile':
      return profileHref(target.name)
    case 'external':
      return target.url
  }
}

/** The {@link MarkdownLinks} of a repo's pages: its autolinks, and the forge it mirrors (if any). */
export function repoLinks(addr: RepoAddress, source: ForgeRepo | null): MarkdownLinks {
  return { href: (target) => targetHref(addr, target), source }
}

/**
 * The mirrored repo's URL, as the origin of text a mirror copies with its git history and
 * releases (commit messages, release notes), or null when the repo mirrors nothing: that text
 * was written on the source forge, so its mentions are that forge's accounts.
 */
export function sourceUrl(links: MarkdownLinks): string | null {
  return links.source === null ? null : `https://${links.source.host}/${links.source.path}`
}

/**
 * {@link repoLinks} for a repo page, memoized (MarkdownView is memo'd on it). The mirror source
 * is the one the owner's description names (`Mirror of github.com/o/r`): no read.
 */
export function useRepoLinks(addr: RepoAddress, description: string): MarkdownLinks {
  const label = mirrorSourceOfDescription(description, 'issue')?.label ?? null
  const { owner, name, repoId } = addr
  return useMemo(() => repoLinks({ owner, name, ...(repoId ? { repoId } : {}) }, forgeRepoOfLabel(label)), [owner, name, repoId, label])
}
