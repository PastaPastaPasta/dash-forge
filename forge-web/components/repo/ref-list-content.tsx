'use client'

/**
 * RefListContent — the branches / tags listing. Renders the already-resolved refs from the
 * repo home view-model (zero extra Platform reads); each tip oid links to its commit page.
 * Deleted refs (null-oid updates — the name persists in append-only Platform history) are
 * folded behind a disclosure so the main list shows only what can be browsed.
 *
 * The branches list adds GitHub's branch administration for maintainers and writers (P1-4,
 * `branch-admin.tsx`): "New branch", a delete button per branch, and "Restore" for a branch
 * deleted from this page.
 *
 * A public repo with members-only branches (mixed-visibility DESIGN §10 "Branches"): a member sees
 * two groups, "Public" and "Members only", the second with each branch's real tip and Publish; the
 * web never writes to a members-only ref (no delete or restore there: push with git). Everyone
 * else sees the public list and one line, "This repo also has members-only branches.", never a
 * number. A branch for fewer people than all members (phase 3F) is listed there too, saying who
 * it is for ("Maintainers only · visible to 3 people"), without Publish (it can't be the head of a
 * members-only pull request); a member without its key sees one row per such branch, "A branch you
 * don't have access to", with no name, tip or link.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Activity, GitBranch, Lock, Search, Tag } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { isDiverged, isLive, matchesRefQuery, plural, refParamFor, tipOidOf } from '@/lib/view'
import { compareRefNames, compareTagNames, repoKey, type ResolvedRef } from '@/lib/repo'
import { NO_ACCESS_TEXT, narrowLabel, narrowerText } from '@/lib/repo/branch-ring'
import { Oid } from '@/components/ui/oid'
import { EmptyState } from '@/components/ui/states'
import { RefDate, TagCommit, useTagPeeler } from '@/components/repo/tag-commit'
import { Input } from '@/components/ui/input'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { UnlockMore } from '@/components/auth/unlock-more'
import { DeleteBranchButton, NewBranchButton, RestoreBranchButton, useBranchAdmin, useDeletedHere } from '@/components/repo/branch-admin'

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

/**
 * A ref's Activity page: its pushes, force-pushes, deletions and protection changes. Public repos
 * only: a private repo's ref names are sealed, and the page's address would carry them.
 */
function ActivityLink({ addr, kind, name }: { addr: RepoAddress; kind: keyof typeof KIND; name: string }): JSX.Element {
  return (
    <Link
      href={repoHref('/repo/activity', addr, kind === 'tags' ? { tag: name } : { branch: name })}
      className="hit-area inline-flex shrink-0 items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-800 dark:text-anvil-400 dark:hover:text-forge-400"
      aria-label={`Activity of ${name}`}
      data-testid="ref-activity-link"
    >
      <Activity className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">Activity</span>
    </Link>
  )
}

/** How many people can read a members-only branch: the repo's members who hold the members key (never bots). */
function membersKeyHolders(home: RepoHome): number {
  const session = home.lane !== undefined && 'session' in home.lane ? home.lane.session : null
  if (session === null) return 0
  return new Set(session.members.filter((m) => m.role !== 'bot').map((m) => m.identity)).size
}

export function RefListContent({
  home,
  addr,
  kind,
  reload,
}: {
  home: RepoHome
  addr: RepoAddress
  kind: keyof typeof KIND
  /** Re-read the repo home (after a branch is created, deleted or restored here). */
  reload?: () => void
}): JSX.Element {
  const { prefix, icon: Icon, empty, noun, single } = KIND[kind]
  const admin = useBranchAdmin(home)
  const branchAdmin = kind === 'branches'
  // Branches deleted from this page, with the tip each had: "Restore" puts one back there.
  const [deletedHere, setDeletedHere] = useDeletedHere(repoKey(home.repo))
  const changed = (): void => reload?.()
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
  const [unlocking, setUnlocking] = useState(false)
  // Tags are usually named for a version, so version order (newest first) is the useful default
  // there; branches usually are not, so name order (default branch first, then alphabetical).
  const [sort, setSort] = useState<SortMode>(kind === 'tags' ? 'version' : 'name')

  // The default branch always leads, so it never scrolls out of view. After it: name order
  // (alphabetical), or version order (L-13/L-53: a name with a parseable version, newest first).
  const { live, deleted, membersLive } = useMemo(() => {
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
    // Members-only refs are listed live only (`members-branches.ts`): a deleted one has no row.
    const members = shown.filter((r) => r.audience === 'members' && isLive(r))
    const plain = shown.filter((r) => r.audience !== 'members')
    return { live: plain.filter(isLive), deleted: plain.filter((r) => !isLive(r)), membersLive: members }
  }, [refs, query, sort, defaultRefName, short])
  // Narrower branches this member holds no key for: one nameless row each (branches only).
  const noAccess = kind === 'branches' ? (home.membersRefs?.noAccess ?? 0) : 0
  // Whether this list has members-only refs to speak of: a member's own, or the public fact.
  const membersGroup = refs.some((r) => r.audience === 'members') || noAccess > 0
  const membersVisibleTo = home.lane?.access === 'member' || home.lane?.access === 'former' ? membersKeyHolders(home) : null

  // On the branches page: the fact covers branches and tags together, and branches are what it is about.
  const outsiderLine = kind === 'branches' && !membersGroup && home.membersOnlyRefs === true && home.repo.visibility === 'public' ? (
    <div className="space-y-2" data-testid="members-only-refs-note">
      <p className="flex flex-wrap items-center gap-1.5 text-dense text-anvil-600 dark:text-anvil-300">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        This repo also has members-only branches.
        {home.lane?.access === 'locked' ? (
          // A member whose tab resumed with the signing key only (DESIGN §4.3: "unlock to see members-only branches").
          <button type="button" className="hit-area font-medium text-forge-700 hover:underline dark:text-forge-400" aria-expanded={unlocking} onClick={() => setUnlocking((u) => !u)} data-testid="members-refs-unlock">
            Unlock to see them
          </button>
        ) : null}
      </p>
      {unlocking && home.lane?.access === 'locked' ? <UnlockMore title="Unlock to see members-only branches" testId="members-refs-unlock-panel" forgot={false} /> : null}
    </div>
  ) : null

  if (refs.length === 0) {
    if (outsiderLine !== null) return outsiderLine
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
        {branchAdmin ? <NewBranchButton home={home} admin={admin} onCreated={changed} /> : null}
      </div>

      {membersGroup ? (
        <h2 className="text-dense font-semibold text-anvil-800 dark:text-anvil-100" data-testid="refs-group-public">
          Public
        </h2>
      ) : null}
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
                {home.repo.visibility === 'public' ? <ActivityLink addr={addr} kind={kind} name={shortName} /> : null}
                {branchAdmin ? (
                  <DeleteBranchButton
                    home={home}
                    admin={admin}
                    branch={ref}
                    onDeleted={(at) => {
                      setDeletedHere((m) => void m.set(ref.refName, at))
                      changed()
                    }}
                  />
                ) : null}
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

      {membersGroup ? (
        <section className="space-y-2" data-testid="refs-group-members" aria-labelledby={`${kind}-members-heading`}>
          <h2 id={`${kind}-members-heading`} className="flex items-center gap-1.5 text-dense font-semibold text-anvil-800 dark:text-anvil-100">
            Members only <Lock className="h-3.5 w-3.5" aria-hidden />
          </h2>
          {membersVisibleTo !== null ? (
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Visible to {plural(membersVisibleTo, 'member', 'members')}.</p>
          ) : null}
          {membersLive.length > 0 || (noAccess > 0 && query.trim() === '') ? (
            <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
              {membersLive.map((ref) => {
                const shortName = short(ref)
                const tip = tipOidOf(ref)
                const browseRef = refParamFor(shortName, kind === 'tags', home.defaultBranch)
                const narrower = ref.narrower
                return (
                  <div
                    key={ref.refName}
                    className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 last:border-b-0 coarse:py-0 dark:border-anvil-850"
                    data-testid="members-ref-row"
                    data-ref={shortName}
                  >
                    <Lock className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-label={narrower !== undefined ? `${narrowLabel(narrower.audience)} only` : 'Members only'} />
                    <Link
                      href={repoHref('/repo', addr, browseRef ? { ref: browseRef } : {})}
                      className="min-w-0 flex-1 truncate font-mono text-dense font-medium text-anvil-900 hover:text-forge-800 coarse:py-3 dark:text-anvil-50 dark:hover:text-forge-400"
                    >
                      {shortName}
                    </Link>
                    {narrower !== undefined ? (
                      <span className="shrink-0 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="narrower-ref-audience">
                        {narrowerText(narrower.audience, narrower.people)}
                      </span>
                    ) : null}
                    {isDiverged(ref) ? (
                      <span className="rounded-full border border-caution/40 bg-caution/5 px-2 py-0.5 text-[11px] text-caution-700 dark:text-caution-400">
                        diverged
                      </span>
                    ) : null}
                    {tip ? <RefDate key={`date:${tip}`} peeler={peeler} tip={tip} pushedAt={refUpdatedAt(ref)} /> : null}
                    {tip && kind === 'branches' ? (
                      <Link
                        href={repoHref('/repo/compare', addr, { base: home.defaultBranch, head: browseRef || shortName })}
                        className="hit-area shrink-0 text-[12px] text-anvil-500 hover:text-forge-800 dark:text-anvil-400 dark:hover:text-forge-400"
                        aria-label={`Compare ${shortName} with ${home.defaultBranch}`}
                      >
                        Compare
                      </Link>
                    ) : null}
                    {tip ? tipChip(tip) : null}
                    {tip && kind === 'branches' && narrower === undefined ? (
                      // Published through a members-only pull request: its merge box squashes or publishes with history.
                      <Link
                        href={repoHref('/repo/pulls/new', addr, { head: shortName, base: home.defaultBranch })}
                        className="hit-area shrink-0 text-[12px] text-anvil-500 hover:text-forge-800 dark:text-anvil-400 dark:hover:text-forge-400"
                        aria-label={`Publish ${shortName}`}
                        data-testid="members-ref-publish"
                      >
                        Publish…
                      </Link>
                    ) : null}
                  </div>
                )
              })}
              {query.trim() === ''
                ? Array.from({ length: noAccess }, (_, i) => (
                    <div
                      key={`no-access:${i}`}
                      className="flex items-center gap-3 border-b border-anvil-100 px-4 py-2.5 text-dense text-anvil-500 last:border-b-0 dark:border-anvil-850 dark:text-anvil-400"
                      data-testid="members-ref-no-access"
                    >
                      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {NO_ACCESS_TEXT}
                    </div>
                  ))
                : null}
            </div>
          ) : (
            <p className="text-dense text-anvil-500 dark:text-anvil-400">No members-only {single} matches &ldquo;{query}&rdquo;.</p>
          )}
        </section>
      ) : (
        outsiderLine
      )}

      {deleted.length > 0 ? (
        // Open while it holds a branch deleted from this page: its Restore is in it.
        <details className="rounded-lg border border-anvil-200 dark:border-anvil-800" open={deleted.some((r) => deletedHere.has(r.refName)) || undefined}>
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
                {home.repo.visibility === 'public' ? <ActivityLink addr={addr} kind={kind} name={short(ref)} /> : null}
                {branchAdmin && deletedHere.has(ref.refName) ? (
                  <RestoreBranchButton
                    home={home}
                    admin={admin}
                    refName={ref.refName}
                    tip={deletedHere.get(ref.refName) as string}
                    onRestored={() => {
                      setDeletedHere((m) => void m.delete(ref.refName))
                      changed()
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
