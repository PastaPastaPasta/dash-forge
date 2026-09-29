'use client'

/**
 * CommitContent — a single commit: metadata + its patch against its first parent (browse-plane
 * tree diff, then per-file line diffs through the shared {@link DiffView}). A root commit shows
 * every file as added. Each changed path links to its blob on the default branch — the blob
 * route addresses branches and tags, not commits. Below the header, the commit's check runs (CI
 * results, `checkRun`): what `dg ci report` and the GitHub Action link to.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { GitCommit } from 'lucide-react'
import type { BrowseReader } from '@/lib/browse'
import { readMembershipsCached, repoContractIds, type RepoRef } from '@/lib/repo'
import { readCheckRuns, summarizeChecks } from '@/lib/repo/checks'
import type { DiffSides, RepoHome } from '@/lib/view'
import { CommitIdError, commitSubject, formatDate, loadCommitChanges, timeAgo } from '@/lib/view'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { BrowseBoundary } from '@/components/repo/browse-boundary'
import { DiffView } from '@/components/repo/diff-view'
import { ChecksTab } from '@/components/repo/pull-tabs'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const COMMIT_ID_TITLES: Record<CommitIdError['kind'], string> = {
  invalid: 'Not a commit id',
  'not-found': 'Commit not found',
  'not-a-commit': 'Not a commit',
  ambiguous: 'Ambiguous commit id',
}

export function CommitContent({ home, addr, oid }: { home: RepoHome; addr: RepoAddress; oid: string }): JSX.Element {
  if (!oid) return <EmptyState icon={GitCommit} title="No commit addressed" body="Add &oid= to the URL." />
  return (
    <BrowseBoundary repo={home.repo} addr={addr}>
      {(reader, retry) => <Body reader={reader} retry={retry} oid={oid} addr={addr} repo={home.repo} />}
    </BrowseBoundary>
  )
}

function Body({ reader, retry, oid, addr, repo }: { reader: BrowseReader; retry: () => void; oid: string; addr: RepoAddress; repo: RepoRef }): JSX.Element {
  const { data, loading, error, cause } = useAsync(() => loadCommitChanges(reader, oid), [oid])
  const sides = useMemo<DiffSides>(() => ({ base: reader, head: reader }), [reader])
  if (loading) return <LoadingBlock label="Reconstructing commit" />
  if (cause instanceof CommitIdError) {
    return (
      <EmptyState
        icon={GitCommit}
        title={COMMIT_ID_TITLES[cause.kind]}
        body={cause.message}
        action={
          cause.candidates.length > 0 ? (
            <ul className="space-y-1 text-left font-mono text-dense">
              {cause.candidates.map((c) => (
                <li key={c}>
                  <Link href={repoHref('/repo/commit', addr, { oid: c })} className="hover:text-forge-800 dark:hover:text-forge-400">
                    {c}
                  </Link>
                </li>
              ))}
            </ul>
          ) : undefined
        }
      />
    )
  }
  if (error) return <ErrorState message={error} onRetry={retry} />
  if (!data) return <LoadingBlock />

  const { commit, changes, truncated } = data
  const full = data.oid
  const body = commit.message.split('\n').slice(1).join('\n').trim()

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-750 dark:bg-anvil-900">
        <h1 className="text-prose font-semibold">{commitSubject(commit.message) || '(no message)'}</h1>
        {body ? <pre className="mt-2 whitespace-pre-wrap font-sans text-dense text-anvil-600 dark:text-anvil-300">{body}</pre> : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] coarse:gap-y-3 text-anvil-500 dark:text-anvil-400">
          <span className="font-medium text-anvil-700 dark:text-anvil-200">{commit.author.name || 'unknown'}</span>
          <span>committed {timeAgo(commit.committer.when)} · {formatDate(commit.committer.when)}</span>
          <span className="flex items-center gap-1">commit <Oid value={full} chars={9} /></span>
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
          fileHref={(path) => repoHref('/repo/blob', addr, { path })}
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
      const runs = await readCheckRuns(sdk!, repo, oid, members.ids)
      return { runs, summary: summarizeChecks(runs, members.known) }
    },
    [ready, repo.repoId, oid, network],
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
