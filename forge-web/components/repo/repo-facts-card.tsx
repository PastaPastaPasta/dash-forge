'use client'

/**
 * The About card's facts (F-5): {@link useRepoFacts} subscribes to what the repo home worked out
 * ({@link loadRepoFacts}), and {@link LanguageBar} draws the languages. The card renders the License
 * row itself (its own `Row`). Nothing shows while the facts are read: the card never waits.
 */

import { useSyncExternalStore } from 'react'
import { repoFacts, subscribeRepoFacts, type RepoFacts } from '@/lib/view/repo-facts'
import { peeledCommitOf } from '@/lib/view/tip'
import type { LanguageStats } from '@/lib/view/languages'
import { plural } from '@/lib/view/format'

/**
 * The facts known for this repo at this tip (unknown until the home has worked them out). The
 * home keys them by the commit a tag peels to, so a tag's tip is peeled here too (L-01).
 */
export function useRepoFacts(repoKey: string, tipOid: string | null): RepoFacts {
  return useSyncExternalStore(
    subscribeRepoFacts,
    () => repoFacts(repoKey, peeledCommitOf(tipOid, repoKey)),
    () => repoFacts(repoKey, null),
  )
}

/** The language bar and its legend, labelled approximate (stored sizes) and, when cut short, partial. */
export function LanguageBar({ stats }: { stats: LanguageStats }): JSX.Element | null {
  const { languages, truncated, files } = stats
  const note = (
    <p className="mt-1.5 text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="language-note">
      ≈ by stored (compressed) size, adjusted for deltas and large data files{truncated ? `, based on the first ${plural(files, 'file')}` : ''}
    </p>
  )
  if (languages.length === 0) {
    // Nothing counted: say so only when the walk was cut short (it may have stopped before any code).
    return truncated ? (
      <div className="mt-2 border-t border-anvil-100 pt-2 dark:border-anvil-850" data-testid="language-bar">
        <h3 className="text-anvil-500 dark:text-anvil-400">Languages</h3>
        <p className="mt-1 text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="language-note">
          None found in the first {plural(files, 'file')} (the walk stopped at its limit).
        </p>
      </div>
    ) : null
  }
  return (
    <div className="mt-2 border-t border-anvil-100 pt-2 dark:border-anvil-850" data-testid="language-bar">
      <h3 className="mb-1.5 text-anvil-500 dark:text-anvil-400">Languages</h3>
      <div className="flex h-2 overflow-hidden rounded-full" role="img" aria-label={languages.map((l) => `${l.name} ${l.percent}%`).join(', ')}>
        {languages.map((l) => (
          <span key={l.name} style={{ width: `${l.percent}%`, backgroundColor: l.color }} className="h-full min-w-[2px]" />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        {languages.map((l) => (
          <li key={l.name} className="flex items-center gap-1" data-testid="language">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} aria-hidden />
            <span className="font-medium text-anvil-700 dark:text-anvil-200">{l.name}</span>
            <span className="tabular-nums text-anvil-500 dark:text-anvil-400">{l.percent}%</span>
          </li>
        ))}
      </ul>
      {note}
    </div>
  )
}
