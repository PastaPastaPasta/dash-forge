'use client'

/**
 * The About card's License row and language bar (F-5), from the facts the repo home works out
 * ({@link loadRepoFacts}). Shown once known; nothing while they are read (the card never waits).
 */

import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { Scale } from 'lucide-react'
import { repoFacts, subscribeRepoFacts } from '@/lib/view/repo-facts'
import { plural } from '@/lib/view/format'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

export function RepoFactsRows({ repoKey, tipOid, addr, refParam }: { repoKey: string; tipOid: string | null; addr: RepoAddress; refParam: string }): JSX.Element | null {
  const facts = useSyncExternalStore(
    subscribeRepoFacts,
    () => repoFacts(repoKey, tipOid),
    () => repoFacts(repoKey, null),
  )
  const { license, languages } = facts
  if (!license && !languages) return null
  return (
    <>
      {license ? (
        <Link
          href={repoHref('/repo/blob', addr, { path: license.file, ...(refParam ? { ref: refParam } : {}) })}
          className="-mx-1 flex items-center justify-between gap-2 rounded px-1 py-1 text-anvil-600 transition-colors hover:bg-anvil-50 hover:text-forge-800 coarse:min-h-11 dark:text-anvil-300 dark:hover:bg-anvil-850 dark:hover:text-forge-400"
          data-testid="repo-license"
        >
          <span className="flex items-center gap-1.5 text-anvil-500 dark:text-anvil-400">
            <Scale className="h-3.5 w-3.5" aria-hidden />
            License
          </span>
          <span className="truncate font-medium">{license.ids.length > 0 ? license.ids.join(' or ') : 'Other'}</span>
        </Link>
      ) : null}
      {languages && languages.languages.length > 0 ? (
        <div className="mt-2 border-t border-anvil-100 pt-2 dark:border-anvil-850" data-testid="language-bar">
          <h3 className="mb-1.5 text-anvil-500 dark:text-anvil-400">Languages</h3>
          <div className="flex h-2 overflow-hidden rounded-full" role="img" aria-label={languages.languages.map((l) => `${l.name} ${l.percent}%`).join(', ')}>
            {languages.languages.map((l) => (
              <span key={l.name} style={{ width: `${l.percent}%`, backgroundColor: l.color }} className="h-full min-w-[2px]" />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            {languages.languages.map((l) => (
              <li key={l.name} className="flex items-center gap-1" data-testid="language">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
                <span className="font-medium text-anvil-700 dark:text-anvil-200">{l.name}</span>
                <span className="tabular-nums text-anvil-500 dark:text-anvil-400">{l.percent}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="language-note">
            ≈ by stored (compressed) size
            {languages.truncated ? `, based on the first ${plural(languages.files, 'file')}` : ''}
          </p>
        </div>
      ) : null}
    </>
  )
}
