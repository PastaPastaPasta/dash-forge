'use client'

/**
 * RecentPushBanner — "<branch> had recent pushes 12m ago · Compare & pull request" (#451), on a
 * repository's home and its pull request list, as GitHub shows it after a push: for each branch
 * the signed-in identity pushed in the last hour that no PR covers yet (`lib/view/recent-push.ts`).
 * The button opens the New pull request form with the branch as the head; on a fork, the
 * parent's form, as the fork's "New pull request" does (QW3-012).
 *
 * Requests: none unless the viewer has such a branch (the candidates come from the home the page
 * already holds); then ONE composite answers whether a PR covers each (`coveredPushes`: one open,
 * or opened since the push), and nothing shows until it does. A dismissal holds for that branch at
 * that tip (localStorage, as GitHub's): a new push offers it again.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { GitBranch, GitPullRequest, X } from 'lucide-react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { useRepoWriteGeneration } from '@/hooks/use-repo-chrome'
import { useSdk } from '@/hooks/use-sdk'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { coveredPushes, repoContractIds } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { timeAgo } from '@/lib/view/format'
import { recentPushKey, recentPushes, withDismissed, type RecentPush } from '@/lib/view/recent-push'
import { sessionCached } from '@/lib/view/session-cache'
import { Button, buttonClass } from '@/components/ui/button'
import { contributeHref, useForkParent } from '@/components/repo/fork-contribute'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'forge.recent-push.dismissed'

/** How long one answer serves the repo's pages (home ⇄ PR list) before it is read again. */
const ANSWER_TTL_MS = 30_000

function readDismissed(): readonly string[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function RecentPushBanner({ home, addr, className }: { home: RepoHome; addr: RepoAddress; className?: string }): JSX.Element | null {
  const { identity } = useAuth()
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const forkParent = useForkParent(home)
  // A PR opened from this tab moves the write generation of the repo it is filed in (this one, or
  // the parent for a fork's branch): the answer is read again then, so the banner goes once the PR
  // exists. Both are watched, so the key does not change when the parent finishes reading.
  const ownWrites = useRepoWriteGeneration(home.repo)
  const parentWrites = useRepoWriteGeneration(forkParent ?? home.repo)
  const generation = `${ownWrites}.${parentWrites}`
  const list = useRef<HTMLDivElement>(null)
  // "Now" is the page's load: the banner does not count down while it is open.
  const [now] = useState(() => Date.now())
  // Read after mount (localStorage is browser-only); until then nothing shows, so no flash.
  const [dismissed, setDismissed] = useState<readonly string[] | null>(null)
  useEffect(() => setDismissed(readDismissed()), [])

  const repoId = home.repo.repoId
  const candidates = useMemo(() => recentPushes(home, identity, now), [home, identity, now])
  const pushes = dismissed === null ? [] : candidates.filter((p) => !dismissed.includes(recentPushKey(repoId, p)))
  // Every candidate is asked about, the dismissed ones too: a dismissal then changes nothing the
  // read depends on (no second read), and once every one is dismissed nothing is read at all.
  const asked = candidates.map((p) => `${p.refName}@${p.tip}`).join(',')
  const answer = useAsync(
    () => sessionCached(`recentPushPulls:${network}:${repoId}:${asked}:${generation}`, ANSWER_TTL_MS, () => coveredPushes(sdk!, home.repo, candidates)),
    [ready, network, repoId, asked, generation],
    { enabled: ready && sdk !== null && pushes.length > 0 },
  )

  // Unknown (not read yet, failed, or incomplete): nothing is offered.
  const covered = answer.data
  if (covered == null) return null
  const offered = pushes.filter((p) => !covered.has(p.refName))
  if (offered.length === 0) return null

  const dismiss = (p: RecentPush): void => {
    const next = withDismissed(dismissed ?? [], recentPushKey(repoId, p))
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* storage disabled: dismissed for this page only */
    }
    setDismissed(next)
    // The focused button goes with its banner: focus moves to the next one's, if any is left.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[data-testid="recent-push-dismiss"]')?.focus())
  }
  // A fork proposes to its parent, as its "New pull request" does; the form there lists this fork's branches.
  const hrefOf = (p: RecentPush): string =>
    forkParent !== null ? contributeHref(forkParent, home.repo, p.branch) : repoHref('/repo/pulls/new', addr, { head: p.branch })

  return (
    <div ref={list} className={cn('space-y-2', className)} data-testid="recent-pushes">
      {offered.map((p) => (
        <div
          key={p.refName}
          role="group"
          aria-label={`Recent push to ${p.branch}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-caution/40 bg-caution/10 px-3 py-2 text-dense"
          data-testid="recent-push"
        >
          <p className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 text-anvil-800 dark:text-anvil-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
            <span className="min-w-0">
              <span className="break-all font-mono font-semibold" data-testid="recent-push-branch">{p.branch}</span> had recent pushes{' '}
              <time dateTime={new Date(p.pushedAt).toISOString()} title={new Date(p.pushedAt).toLocaleString()} className="whitespace-nowrap">
                {timeAgo(p.pushedAt, now)}
              </time>
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Link
              href={hrefOf(p)}
              className={buttonClass({ variant: 'primary', size: 'sm' })}
              data-testid="recent-push-compare"
            >
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> Compare &amp; pull request
            </Link>
            <Button size="icon" variant="ghost" onClick={() => dismiss(p)} aria-label={`Dismiss the recent push to ${p.branch}`} data-testid="recent-push-dismiss">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
