'use client'

/**
 * CommitContent — a single commit: metadata + its patch against its first parent (browse-plane
 * tree diff, then per-file line diffs through the shared {@link DiffView}). A root commit shows
 * every file as added. Each changed path links to its blob at this commit (L-28). An annotated
 * tag's id (the tags list's chips) shows the commit it names, and says which tag it came through.
 * Below the header, the commit's check runs (CI results, `checkRun`): what `dg ci report` and the
 * GitHub Action link to.
 */

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { GitCommit, Tag } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import { readMembershipsCached, repoContractIds, repoKey, type RepoRef } from '@/lib/repo'
import { readCheckRuns, summarizeChecks } from '@/lib/repo/checks'
import type { DiffSides, RepoHome } from '@/lib/view'
import { commitSubject, loadCommitChanges, type CommitObject } from '@/lib/view'
import { commitPeople } from '@/lib/view/commit-people'
import { Time } from '@/components/repo/byline'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { GoToFileHotkey } from '@/components/repo/go-to-file'
import { DiffView } from '@/components/repo/diff-view'
import { ChecksTab } from '@/components/repo/pull-tabs'
import { ReadErrorState } from '@/components/repo/resolved-tip'
import { Oid } from '@/components/ui/oid'
import { EmptyState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { LinkifiedText } from '@/components/markdown-view'
import { sourceUrl, useRepoLinks } from '@/components/repo/target-href'
import { cn } from '@/lib/utils'

export function CommitContent({ home, addr, oid }: { home: RepoHome; addr: RepoAddress; oid: string }): JSX.Element {
  if (!oid) return <EmptyState icon={GitCommit} title="No commit addressed" body="Add &oid= to the URL." />
  return (
    <BrowseBoundary repo={home.repo} addr={addr}>
      {(reader, retry) => <Body reader={reader} retry={retry} oid={oid} addr={addr} repo={home.repo} description={home.description} />}
    </BrowseBoundary>
  )
}

function Body({ reader, retry, oid, addr, repo, description }: { reader: BrowseReader; retry: () => void; oid: string; addr: RepoAddress; repo: RepoRef; description: string }): JSX.Element {
  const links = useRepoLinks(addr, description)
  const { data, loading, error, cause } = useAsync(() => loadCommitChanges(reader, oid), [oid])
  const sides = useMemo<DiffSides>(() => ({ base: reader, head: reader }), [reader])
  if (loading) return <LoadingBlock label="Reconstructing commit" />
  if (error) return <ReadErrorState cause={cause} retry={retry} addr={addr} repo={repo} />
  if (!data) return <LoadingBlock />

  const { commit, changes, truncated, tags } = data
  const full = data.oid
  const tagNames = tags.map((t) => t.tag).filter((t) => t !== '')
  const body = commit.message.split('\n').slice(1).join('\n').trim()

  return (
    <div className="space-y-4">
      {/* `t`: the files at this commit (QW2-043). */}
      <GoToFileHotkey reader={reader} repo={repo} tip={{ oid: full, type: 'commit' }} addr={addr} refParam={full} />
      <div className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900">
        <h1 className="text-prose font-semibold [overflow-wrap:anywhere]" data-testid="commit-subject">
          {commitSubject(commit.message) ? <LinkifiedText text={commitSubject(commit.message)} links={links} imported={sourceUrl(links)} /> : '(no message)'}
        </h1>
        {body ? <CommitBody body={body} links={links} /> : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] coarse:gap-y-3 text-anvil-500 dark:text-anvil-400">
          <CommitByline commit={commit} />
          <span className="flex items-center gap-1">commit <Oid value={full} chars={9} /></span>
          {tagNames.length > 0 ? (
            <span className="flex items-center gap-1" data-testid="commit-via-tag">
              <Tag className="h-3 w-3" aria-hidden /> tagged {tagNames.join(' → ')}
            </span>
          ) : null}
          {commit.parents.map((p) => (
            <Link key={p} href={repoHref('/repo/commit', addr, { oid: p })} className="hit-area flex items-center gap-1 hover:text-forge-800 dark:hover:text-forge-400">
              parent <Oid value={p} chars={7} copyable={false} />
            </Link>
          ))}
        </div>
        {commit.parents.length > 1 ? (
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            Merge commit — changes are shown against the first parent.
          </p>
        ) : null}
      </div>

      <CommitChecks repo={repo} oid={full} />

      {changes.length === 0 && !truncated ? (
        <EmptyState title="No file changes" body="This commit touches no tree paths (e.g. a merge with no diff to its first parent)." />
      ) : (
        <DiffView
          key={full}
          sides={sides}
          changes={changes}
          truncated={truncated}
          renameLimit={data.renameLimit}
          fileHref={(path) => repoHref('/repo/blob', addr, { path, ref: full })}
        />
      )}
    </div>
  )
}

/**
 * The newest check run per name on this commit, trusted when its reporter is a current
 * maintainer, writer or runner. Private repositories' check runs are plaintext on chain too
 * (private-repos.md §7), so they read the same way.
 */
function CommitChecks({ repo, oid }: { repo: RepoRef; oid: string }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const checks = useAsync(
    async () => {
      const members = await readMembershipsCached(sdk!, repo, network).then(
        (ms) => ({ known: true, ids: new Set(ms.map((m) => m.identity)) }),
        () => ({ known: false, ids: new Set<string>() }),
      )
      const { runs } = await readCheckRuns(sdk!, repo, oid, members.ids)
      return { runs, summary: summarizeChecks(runs, members.known) }
    },
    [ready, repoKey(repo), oid, network],
    { enabled: ready && sdk !== null && oid !== '' },
  )
  return (
    <section aria-label="Checks" data-testid="commit-checks">
      <h2 className="mb-2 text-dense font-semibold text-anvil-700 dark:text-anvil-200">Checks</h2>
      <ChecksTab
        runs={checks.data?.runs ?? null}
        summary={checks.data?.summary ?? null}
        headOid={oid}
        error={checks.error}
        onRetry={checks.reload}
        subject="commit"
      />
    </section>
  )
}

/**
 * Who made the commit and when (L-26, L-27): the author with the author date, then the committer
 * with the commit date when that is someone else or another time, and the co-authors its trailers
 * name. Each date is a `<time>` with the exact time on hover.
 */
function CommitByline({ commit }: { commit: CommitObject }): JSX.Element {
  const { author, committer, committerIsAuthor, coAuthors } = commitPeople(commit)
  const name = (n: string): JSX.Element => <span className="font-medium text-anvil-700 dark:text-anvil-200">{n || 'unknown'}</span>
  return (
    <span className="flex flex-wrap items-center gap-x-1.5" data-testid="commit-byline">
      {name(author.name)}
      {coAuthors.length > 0 ? (
        <span title={coAuthors.map((p) => `${p.name} <${p.email}>`).join('\n')} data-testid="commit-coauthors">
          and {coAuthors.map((p) => p.name).join(', ')}
        </span>
      ) : null}
      <span data-testid="commit-authored">
        {committer === null ? 'committed' : 'authored'} <Time ms={author.when} withDate />
      </span>
      {committer !== null ? (
        <span data-testid="commit-committed">
          · {committerIsAuthor ? null : <>{name(committer.name)} </>}committed <Time ms={committer.when} withDate />
        </span>
      ) : null}
    </span>
  )
}

/** A body longer than this many lines (or characters) starts collapsed on a phone. */
const PHONE_BODY_LINES = 6
const PHONE_BODY_CHARS = 480

/** Whether a commit body is long enough to start collapsed on a phone (QW-061f). */
export function longCommitBody(body: string): boolean {
  return body.split('\n').length > PHONE_BODY_LINES || body.length > PHONE_BODY_CHARS
}

/**
 * The commit message's body. On a phone a long one (a squash's list of commits, a release's
 * changelog) starts clamped to a few lines with "Show more", so the diff is not screens away;
 * from `sm` up it is shown whole, as GitHub's commit page does.
 */
function CommitBody({ body, links }: { body: string; links: ReturnType<typeof useRepoLinks> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const long = longCommitBody(body)
  // CSS only (below `sm`), so a desktop never paints it clamped first.
  const clamped = long && !open
  return (
    <div className="mt-2">
      <pre className={cn('whitespace-pre-wrap font-sans text-dense text-anvil-600 [overflow-wrap:anywhere] dark:text-anvil-300', clamped && 'max-sm:line-clamp-6')} data-testid="commit-body" data-clamped={clamped || undefined}>
        <LinkifiedText text={body} links={links} imported={sourceUrl(links)} />
      </pre>
      {long ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 text-[12px] font-medium text-forge-700 underline-offset-2 hover:underline coarse:min-h-11 sm:hidden dark:text-forge-400" data-testid="commit-body-toggle">
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}
