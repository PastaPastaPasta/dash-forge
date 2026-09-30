'use client'

/**
 * `/notifications` — the local inbox (`ux-dx-spec.md` §5.10). Items are computed in this
 * browser from the chain by the header's poller; this page lists them, marks them read, and
 * says exactly what is watched.
 */

import Link from 'next/link'
import { useState } from 'react'
import { Bell, CheckCheck, CircleDot, GitCommit, GitPullRequest, Info, MessageSquare, RefreshCw, ShieldCheck, Tag } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { Author } from '@/components/author'
import { WithAge } from '@/components/ui/with-age'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'
import { useInboxActions, useInboxStore } from '@/hooks/use-inbox'
import { repoHref } from '@/hooks/use-query-param'
import { INBOX_EMPTY, MAX_REPOS, MAX_THREADS, POLL_MS, groupThreads, type InboxItem, type InboxThread } from '@/lib/view/inbox'
import { plural, timeAgo } from '@/lib/view'
import { cn } from '@/lib/utils'

const ICON: Readonly<Record<InboxItem['kind'], typeof Bell>> = {
  issue: CircleDot,
  pull: GitPullRequest,
  comment: MessageSquare,
  state: Tag,
  review: ShieldCheck,
  push: GitCommit,
}

function hrefOf(item: InboxItem): string {
  const addr = { owner: item.repo.ownerId, name: item.repo.name, repoId: item.repo.id }
  if (!item.target) return repoHref('/repo/commits', addr)
  return repoHref(item.target.kind === 'issue' ? '/repo/issue' : '/repo/pull', addr, { number: String(item.target.number) })
}

export default function NotificationsPage(): JSX.Element {
  const { identity, locked } = useAuth()
  const { items, subs, prefs, polling, lastPoll, lastFeeds, error } = useInboxStore()
  const { markRead, markAllRead, setPrefs, pollNow } = useInboxActions()
  const [filter, setFilter] = useState<'unread' | 'all'>('unread')
  // One row per thread (an issue, a PR, a repo's pushes), as GitHub lists them (QW-066).
  const threads = groupThreads(items)
  const shown = filter === 'unread' ? threads.filter((t) => t.unread > 0) : threads
  const unread = threads.filter((t) => t.unread > 0).length

  if (!isForgeDeployed()) {
    return (
      <AppShell>
        <NotDeployedState />
      </AppShell>
    )
  }
  if (!identity) {
    return (
      <AppShell>
        <h1 className="mb-4 text-xl">Notifications</h1>
        <EmptyState
          icon={Bell}
          title={locked ? 'Unlock to see your notifications' : 'Sign in to see your notifications'}
          body={`${INBOX_EMPTY} They follow the identity you sign in with.`}
          action={<SignInButton />}
        />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl">Notifications</h1>
          <div className="flex flex-wrap items-center gap-2">
            {polling ? <Spinner label="Checking the chain" /> : null}
            <Button variant="ghost" size="sm" onClick={pollNow} disabled={polling}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check now
            </Button>
            <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={unread === 0}>
              <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
            </Button>
          </div>
        </div>

        <p role="note" className="flex items-start gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
          <span>
            Local only: this tab checks the chain every {POLL_MS / 1000} s while it is open. There is no email, no push and no
            sync to your other devices; each browser keeps its own read state.
          </span>
        </p>

        <div role="group" aria-label="Show" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
          {(['unread', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn('rounded px-3 py-1 text-dense font-medium coarse:min-h-11', filter === f ? 'bg-forge-500/15 text-forge-800 dark:text-forge-300' : 'text-anvil-600 dark:text-anvil-300')}
            >
              {f === 'unread' ? `Unread (${unread})` : `All (${threads.length})`}
            </button>
          ))}
        </div>

        {error && items.length === 0 ? (
          <ErrorState message={error} onRetry={pollNow} />
        ) : shown.length === 0 ? (
          <div data-testid="inbox-empty">
            <EmptyState
              icon={Bell}
              title={filter === 'unread' && items.length > 0 ? 'All caught up' : 'Nothing new'}
              body={INBOX_EMPTY}
            />
          </div>
        ) : (
          <ul className="divide-y divide-anvil-200 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800" data-testid="inbox-list">
            {shown.map((t) => (
              <ThreadRow
                key={t.key}
                thread={t}
                onRead={() => {
                  const ids = t.items.filter((i) => !i.read).map((i) => i.id)
                  if (ids.length > 0) void markRead(ids)
                }}
              />
            ))}
          </ul>
        )}

        <section className="rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-800" aria-labelledby="watching">
          <h2 id="watching" className="mb-2 font-medium">What this browser watches</h2>
          {subs ? (
            <ul className="list-inside list-disc space-y-1 text-anvil-600 dark:text-anvil-300">
              <li>
                {plural(subs.repos.filter((r) => r.reason !== 'starred' && r.reason !== 'watched').length, 'repo')} you own or belong to: new issues and pull
                requests{prefs?.pushes ? ', pushes' : ''}.
              </li>
              <li>
                {plural(subs.repos.filter((r) => r.reason === 'watched').length, 'repo')} you watch (on every device): new issues and pull
                requests{prefs?.pushes ? ', pushes' : ''}.
              </li>
              <li>
                {plural(subs.threads.length, 'issue or pull request', 'issues and pull requests')} you opened or commented on: comments, state changes, and reviews
                on your pull requests.
              </li>
              {prefs?.stars ? <li>{plural(subs.repos.filter((r) => r.reason === 'starred').length, 'starred repo')}: new issues and pull requests.</li> : null}
              {subs.droppedRepos > 0 ? (
                <li>
                  Capped at {MAX_REPOS} repos: {subs.droppedRepos} more are not watched.
                </li>
              ) : null}
              {subs.droppedThreads > 0 ? (
                <li>
                  Capped at the {MAX_THREADS} threads you joined most recently: {subs.droppedThreads} older ones are not watched.
                </li>
              ) : null}
              {subs.incomplete && subs.incomplete.length > 0 ? (
                <li className="text-caution-700 dark:text-caution-400" data-partial="true">
                  Could not read all of: {subs.incomplete.join('; ')}. What they would add is not watched until the next check
                  succeeds.
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-anvil-500 dark:text-anvil-400">Working out your repos and threads…</p>
          )}
          {prefs ? (
            <div className="mt-3 space-y-1.5">
              <label className="flex items-center gap-2 coarse:min-h-11">
                <input type="checkbox" className="h-4 w-4 accent-forge-600" checked={prefs.stars} onChange={(e) => void setPrefs({ ...prefs, stars: e.target.checked })} />
                Also watch repos I starred
              </label>
              <label className="flex items-center gap-2 coarse:min-h-11">
                <input type="checkbox" className="h-4 w-4 accent-forge-600" checked={prefs.pushes} onChange={(e) => void setPrefs({ ...prefs, pushes: e.target.checked })} />
                Tell me about pushes to repos I watch
              </label>
            </div>
          ) : null}
          <p className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400">
            {lastPoll ? `Last checked ${timeAgo(lastPoll)}` : 'Not checked yet'}
            {lastFeeds ? ` · ${lastFeeds.read} of ${plural(lastFeeds.total, 'feed')} this round${lastFeeds.failed ? `, ${lastFeeds.failed} failed (retried next round)` : ''}` : ''}
            . Your own actions never notify you.
          </p>
        </section>
      </div>
    </AppShell>
  )
}

function ThreadRow({ thread, onRead }: { thread: InboxThread; onRead: () => void }): JSX.Element {
  const latest = thread.items[0] as InboxItem
  const Icon = ICON[thread.target?.kind ?? latest.kind]
  const more = thread.items.length - 1
  const unread = thread.unread > 0
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5 sm:px-4', unread ? 'bg-forge-500/5' : 'bg-transparent')} data-read={!unread} data-testid="inbox-thread" data-events={thread.items.length}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      {/* Touch: the thread link covers its whole text column (the meta line holds no links). */}
      <div className="relative min-w-0 flex-1">
        <Link href={hrefOf(latest)} onClick={onRead} className="block text-dense hover:underline coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-2.5 coarse:after:content-['']">
          <span className="font-mono text-anvil-500 dark:text-anvil-400">{thread.repo.name}</span>
          {thread.target ? (
            <>
              {' '}
              <span className="font-mono text-anvil-500 dark:text-anvil-400">#{thread.target.number}</span>{' '}
              <span className="font-medium text-anvil-900 dark:text-anvil-50">{thread.target.title}</span>
            </>
          ) : null}
        </Link>
        <p className="mt-0.5 text-[12px] leading-5 text-anvil-500 dark:text-anvil-400">
          <Author identityId={latest.actor} link={false} className="align-middle" /> <WithAge text={latest.what} age={timeAgo(latest.at)} />
          {more > 0 ? <span className="whitespace-nowrap"> · {plural(more, 'earlier event')}</span> : null}
          {unread ? (
            <span className="ml-1.5 whitespace-nowrap rounded bg-forge-700 px-1 align-middle text-[10px] font-semibold uppercase text-white">
              {thread.unread > 1 ? `${thread.unread} new` : 'new'}
            </span>
          ) : null}
        </p>
      </div>
      {unread ? (
        <Button variant="ghost" size="sm" onClick={onRead} aria-label={`Mark read: ${thread.target ? `#${thread.target.number} ${thread.target.title}` : `pushes to ${thread.repo.name}`}`}>
          <CheckCheck className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Read</span>
        </Button>
      ) : null}
    </li>
  )
}
