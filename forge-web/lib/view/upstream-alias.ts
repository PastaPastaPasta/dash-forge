/**
 * Which Forge repo mirrors a GitHub repo (CJ-3), for `/github.com/<owner>/<repo>` and for a
 * `/dashpay/dash` that names no Forge repo. A mirror says what it mirrors in the description its
 * owner wrote (`… (mirror of github.com/dashpay/dash)`, `mirrorSourceOfRepo`; a fork, which copies
 * its parent's description, is never one); anyone can write
 * that, so a claim alone opens a repo only when it is the only one, or when the network's
 * showcase vouches for one of several. Otherwise the visitor picks.
 */

import type { DiscoveredRepo } from './discovery'
import { mirrorSourceOfRepo } from './mirror-source'

/** The mirrors of `github.com/<owner>/<name>` among `repos` (same name, any owner), showcase first. */
export function mirrorsOf(owner: string, name: string, repos: readonly DiscoveredRepo[], showcaseIds: ReadonlySet<string> = new Set()): DiscoveredRepo[] {
  const wanted = `github.com/${owner}/${name}`.toLowerCase()
  return repos
    .filter((r) => r.visibility === 'public' && mirrorSourceOfRepo({ description: r.description, forkOf: r.forkOf ?? null }, 'issue')?.label.toLowerCase() === wanted)
    .sort((a, b) => Number(showcaseIds.has(b.key)) - Number(showcaseIds.has(a.key)))
}

/** The mirror to open without asking: the only claim, or the one showcase repo among several. */
export function mirrorToOpen(mirrors: readonly DiscoveredRepo[], showcaseIds: ReadonlySet<string> = new Set()): DiscoveredRepo | null {
  if (mirrors.length === 1) return mirrors[0] ?? null
  const vouched = mirrors.filter((m) => showcaseIds.has(m.key))
  return vouched.length === 1 ? (vouched[0] ?? null) : null
}
