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
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'
import { useInboxActions, useInboxStore } from '@/hooks/use-inbox'
import { repoHref } from '@/hooks/use-query-param'
import { INBOX_EMPTY, MAX_REPOS, MAX_THREADS, POLL_MS, type InboxItem } from '@/lib/view/inbox'
import { timeAgo } from '@/lib/view'
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
  const { identity } = useAuth()
  const { items, subs, prefs, polling, lastPoll, lastFeeds, error } = useInboxStore()
  const { markRead, markAllRead, setPrefs, pollNow } = useInboxActions()
  const [filter, setFilter] = useState<'unread' | 'all'>('unread')
  const shown = filter === 'unread' ? items.filter((i) => !i.read) : items
  const unread = items.filter((i) => !i.read).length

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
          title="Sign in to see your notifications"
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
              className={cn('rounded px-3 py-1 text-dense font-medium', filter === f ? 'bg-forge-500/15 text-forge-800 dark:text-forge-300' : 'text-anvil-600 dark:text-anvil-300')}
            >
              {f === 'unread' ? `Unread (${unread})` : `All (${items.length})`}
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
            {shown.map((item) => (
              <InboxRow key={item.id} item={item} onRead={() => void markRead([item.id])} />
            ))}
          </ul>
        )}

        <section className="rounded-lg border border-anvil-200 p-4 text-dense dark:border-anvil-800" aria-labelledby="watching">
          <h2 id="watching" className="mb-2 font-medium">What this browser watches</h2>
          {subs ? (
            <ul className="list-inside list-disc space-y-1 text-anvil-600 dark:text-anvil-300">
              <li>
                {subs.repos.filter((r) => r.reason !== 'starred').length} repos you own or belong to: new issues and pull
                requests{prefs?.pushes ? ', pushes' : ''}.
              </li>
              <li>
                {subs.threads.length} issues and pull requests you opened or commented on: comments, state changes, and reviews
                on your pull requests.
              </li>
              {prefs?.stars ? <li>{subs.repos.filter((r) => r.reason === 'starred').length} starred repos: new issues and pull requests.</li> : null}
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
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-forge-600" checked={prefs.stars} onChange={(e) => void setPrefs({ ...prefs, stars: e.target.checked })} />
                Also watch repos I starred
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-forge-600" checked={prefs.pushes} onChange={(e) => void setPrefs({ ...prefs, pushes: e.target.checked })} />
                Tell me about pushes to repos I watch
              </label>
            </div>
          ) : null}
          <p className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400">
            {lastPoll ? `Last checked ${timeAgo(lastPoll)}` : 'Not checked yet'}
            {lastFeeds ? ` · ${lastFeeds.read} of ${lastFeeds.total} feeds this round${lastFeeds.failed ? `, ${lastFeeds.failed} failed (retried next round)` : ''}` : ''}
            . Your own actions never notify you.
          </p>
        </section>
      </div>
    </AppShell>
  )
}

function InboxRow({ item, onRead }: { item: InboxItem; onRead: () => void }): JSX.Element {
  const Icon = ICON[item.kind]
  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5 sm:px-4', item.read ? 'bg-transparent' : 'bg-forge-500/5')} data-read={item.read}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <Link href={hrefOf(item)} onClick={onRead} className="block text-dense hover:underline">
          <span className="font-mono text-anvil-500 dark:text-anvil-400">{item.repo.name}</span>
          {item.target ? (
            <>
              {' '}
              <span className="font-mono text-anvil-500 dark:text-anvil-400">#{item.target.number}</span>{' '}
              <span className="font-medium text-anvil-900 dark:text-anvil-50">{item.target.title}</span>
            </>
          ) : null}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
          <Author identityId={item.actor} link={false} />
          <span>{item.what}</span>
          <span>· {timeAgo(item.at)}</span>
          {item.read ? null : <span className="rounded bg-forge-700 px-1 text-[10px] font-semibold uppercase text-white">new</span>}
        </div>
      </div>
      {item.read ? null : (
        <Button variant="ghost" size="sm" onClick={onRead} aria-label={`Mark read: ${item.what}${item.target ? ` on #${item.target.number}` : ''}`}>
          <CheckCheck className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Read</span>
        </Button>
      )}
    </li>
  )
}
