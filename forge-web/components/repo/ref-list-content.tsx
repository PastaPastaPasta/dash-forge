'use client'

/**
 * RefListContent — the branches / tags listing. Renders the already-resolved refs from the
 * repo home view-model (zero extra Platform reads); each tip oid links to its commit page.
 * Deleted refs (null-oid updates — the name persists in append-only Platform history) are
 * folded behind a disclosure so the main list shows only what can be browsed.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { GitBranch, Search, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isDiverged, isLive, matchesRefQuery, plural, refParamFor, tipOidOf } from '@/lib/view'
import { compareRefNames, compareTagNames, type ResolvedRef } from '@/lib/repo'
import { Oid } from '@/components/ui/oid'
import { EmptyState } from '@/components/ui/states'
import { RefDate, TagCommit, useTagPeeler } from '@/components/repo/tag-commit'
import { Input } from '@/components/ui/input'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const KIND = {
  branches: { prefix: 'refs/heads/', icon: GitBranch, empty: 'No branches yet', noun: 'a branch', single: 'branch' },
  tags: { prefix: 'refs/tags/', icon: Tag, empty: 'No tags yet', noun: 'a tag', single: 'tag' },
} as const

type SortMode = 'name' | 'version'

/** When a ref last moved: its update's time, or a diverged ref's newest head's (0: unknown). */
export function refUpdatedAt(ref: ResolvedRef): number {
  const st = ref.state
  if (st.state === 'resolved') return st.createdAt
  if (st.state === 'diverged') return Math.max(0, ...st.heads.map((h) => h.createdAt))
  return 0
}

export function RefListContent({
  home,
  addr,
  kind,
}: {
  home: RepoHome
  addr: RepoAddress
  kind: keyof typeof KIND
}): JSX.Element {
  const { prefix, icon: Icon, empty, noun, single } = KIND[kind]
  // Tags are peeled for their commit chips, and every row's tip is read for its date (QW2-023):
  // both through the published browse index, a row at a time as it scrolls into view.
  const peeler = useTagPeeler(home.repo, { readAhead: kind === 'tags' })
  const tipChip = (tip: string): JSX.Element => {
    // A tag's tip may be a tag object: the chip shows the commit it names (L-02). Keyed by the
    // tip, so a force-moved tag's chip starts over instead of keeping the old commit.
    if (kind === 'tags') return <TagCommit key={tip} peeler={peeler} tip={tip} addr={addr} />
    return (
      <Link href={repoHref('/repo/commit', addr, { oid: tip })} className="hit-area hover:text-forge-800 dark:hover:text-forge-400">
        <Oid value={tip} copyable={false} />
      </Link>
    )
  }
  const refs = kind === 'branches' ? home.branches : home.tags
  const defaultRefName = `refs/heads/${home.defaultBranch}`
  const short = useCallback(
    (ref: ResolvedRef): string => (ref.refName.startsWith(prefix) ? ref.refName.slice(prefix.length) : ref.refName),
    [prefix],
  )

  const [query, setQuery] = useState('')
  // Tags are usually named for a version, so version order (newest first) is the useful default
  // there; branches usually are not, so name order (default branch first, then alphabetical).
  const [sort, setSort] = useState<SortMode>(kind === 'tags' ? 'version' : 'name')

  // The default branch always leads, so it never scrolls out of view. After it: name order
  // (alphabetical), or version order (L-13/L-53: a name with a parseable version, newest first).
  const { live, deleted } = useMemo(() => {
    // Natural order (digit runs as numbers), not localeCompare: "branch-9" belongs before
    // "branch-10", and it matches the tags page's Version mode closely enough that switching
    // between the two sort modes doesn't reshuffle unrelated names. compareRefNames, not bare
    // naturalRuns: it adds the raw-string tie-break that keeps "foo-bar"/"foo_bar" in a fixed order.
    const compareNames = sort === 'version' ? compareTagNames : compareRefNames
    const comparator = (a: ResolvedRef, b: ResolvedRef): number => {
      if (a.refName === defaultRefName) return -1
      if (b.refName === defaultRefName) return 1
      return compareNames(short(a), short(b))
    }
    const shown = refs.filter((r) => matchesRefQuery(short(r), query)).sort(comparator)
    return { live: shown.filter(isLive), deleted: shown.filter((r) => !isLive(r)) }
  }, [refs, query, sort, defaultRefName, short])

  if (refs.length === 0) {
    return (
      <EmptyState
        icon={Icon}
        title={empty}
        body={`Push ${noun} with the git-remote-dash helper and it appears here.`}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <label htmlFor={`${kind}-search`} className="sr-only">Search {kind}</label>
          <Input
            id={`${kind}-search`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8 font-mono text-[13px]"
            placeholder={`Find a ${single}…`}
          />
        </div>
        <label className="sr-only" htmlFor={`${kind}-sort`}>Sort</label>
        <select
          id={`${kind}-sort`}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
        >
          <option value="name">Name</option>
          <option value="version">Version</option>
        </select>
      </div>

      {live.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
          {live.map((ref) => {
            const shortName = short(ref)
            const isDefault = ref.refName === defaultRefName
            const tip = tipOidOf(ref)
            const browseRef = refParamFor(shortName, kind === 'tags', home.defaultBranch)
            return (
              <div
                key={ref.refName}
                className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 coarse:py-0 dark:border-anvil-850"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
                <Link
                  href={repoHref('/repo', addr, browseRef ? { ref: browseRef } : {})}
                  className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:py-3 dark:text-anvil-50 dark:hover:text-forge-400"
                >
                  {shortName}
                </Link>
                {isDefault ? (
                  <span className="rounded-full border border-anvil-200 px-2 py-0.5 text-[11px] text-anvil-500 dark:border-anvil-700 dark:text-anvil-400">
                    default
                  </span>
                ) : null}
                {isDiverged(ref) ? (
                  <span className="rounded-full border border-caution/40 bg-caution/5 px-2 py-0.5 text-[11px] text-caution-700 dark:text-caution-400">
                    diverged
                  </span>
                ) : null}
                {/* GitHub's "Updated": the tip commit's (or the tag's) date, QW2-023; not when this ref document last moved. */}
                {tip ? <RefDate key={`date:${tip}`} peeler={peeler} tip={tip} pushedAt={refUpdatedAt(ref)} /> : null}
                {tip && !isDefault ? (
                  // What this ref has that the default branch does not (L-30).
                  <Link
                    href={repoHref('/repo/compare', addr, { base: home.defaultBranch, head: browseRef || shortName })}
                    className="hit-area shrink-0 text-[12px] text-anvil-500 hover:text-forge-800 dark:text-anvil-400 dark:hover:text-forge-400"
                    aria-label={`Compare ${shortName} with ${home.defaultBranch}`}
                  >
                    Compare
                  </Link>
                ) : null}
                {tip ? tipChip(tip) : null}
              </div>
            )
          })}
        </div>
      ) : query.trim() !== '' ? (
        // "Active" because a query that matches nothing live can still match a deleted ref,
        // which then shows up in the disclosure below — this message must not read as "no
        // matches anywhere".
        <EmptyState icon={Icon} title={`No active ${kind} match`} body={`No active ${single} matches "${query}". Clear the search to see them all.`} />
      ) : (
        // Only reachable with an empty query, so nothing was filtered out here: every live ref
        // really has been deleted, and "every X was deleted" is the correct message.
        <EmptyState
          icon={Icon}
          title={`No active ${kind}`}
          body={`Every pushed ${single} here has since been deleted. Push ${noun} with the git-remote-dash helper and it appears here.`}
        />
      )}

      {deleted.length > 0 ? (
        <details className="rounded-lg border border-anvil-200 dark:border-anvil-800">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-dense coarse:py-3 text-anvil-500 hover:text-anvil-700 dark:text-anvil-400 dark:hover:text-anvil-200">
            {plural(deleted.length, `deleted ${single}`, `deleted ${kind}`)}
          </summary>
          <div className="border-t border-anvil-100 dark:border-anvil-850">
            {deleted.map((ref) => (
              <div
                key={ref.refName}
                className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 dark:border-anvil-850"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-300 dark:text-anvil-600" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-dense text-anvil-500 dark:text-anvil-400 line-through decoration-anvil-300 dark:decoration-anvil-600">
                  {short(ref)}
                </span>
                <span className="rounded-full border border-anvil-200 px-2 py-0.5 text-[11px] text-anvil-500 dark:text-anvil-400 dark:border-anvil-700">
                  deleted
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
