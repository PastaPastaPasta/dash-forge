'use client'

/** PathBreadcrumb — repo-root → nested path crumbs, each a link back up the tree. */

import Link from 'next/link'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function PathBreadcrumb({
  addr,
  path,
}: {
  addr: RepoAddress
  path: string
}): JSX.Element {
  const segments = path.split('/').filter((s) => s.length > 0)
  return (
    <nav className="flex flex-wrap items-center gap-1 text-prose" aria-label="Path">
      <Link href={repoHref('/repo', addr)} className="font-mono font-semibold text-forge-600 hover:underline dark:text-forge-400">
        {addr.name}
      </Link>
      {segments.map((seg, i) => {
        const sub = segments.slice(0, i + 1).join('/')
        const isLast = i === segments.length - 1
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-anvil-300 dark:text-anvil-600">/</span>
            {isLast ? (
              <span className="font-mono text-anvil-800 dark:text-anvil-100">{seg}</span>
            ) : (
              <Link href={repoHref('/repo/tree', addr, { path: sub })} className="font-mono text-forge-600 hover:underline dark:text-forge-400">
                {seg}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
