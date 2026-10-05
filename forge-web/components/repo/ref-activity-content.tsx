'use client'

/**
 * A branch's or tag's activity (epic E5): every push, force-push, move and deletion of the ref,
 * and every change to whether it is protected, newest first (`lib/rules/refHistory.ts`). The
 * history comes from the repo chrome store this tab usually holds already (`readRefHistory`), so
 * the list itself costs no request. Whether a branch move kept the old tip is git knowledge: the
 * newest {@link CONTAINS_CHECKED} moves are checked through the browse reader, a bounded walk
 * each; a move that cannot be checked reads "updated", never a guess.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { ArrowLeft, GitBranch, GitCommitHorizontal, Lock, LockOpen, Tag, Trash2, TriangleAlert } from 'lucide-react'
import { Author } from '@/components/author'
import { Time } from '@/components/repo/byline'
import { Oid } from '@/components/ui/oid'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useAsync } from '@/hooks/use-async'
import { useBrowse } from '@/hooks/use-browse'
import { useSdk } from '@/hooks/use-sdk'
import { useTrustView } from '@/hooks/use-trust-view'
import { repoContractIds, repoKey } from '@/lib/repo'
import { readRefHistory } from '@/lib/repo/ref-history'
import { refHistory, type RefEvent } from '@/lib/rules/refHistory'
import type { RepoHome } from '@/lib/view'
import { plural } from '@/lib/view'
import { tipContains } from '@/lib/view/head-updates'
import { cn } from '@/lib/utils'

/** How many of the newest branch moves are checked for a force-push. */
export const CONTAINS_CHECKED = 20
/** How many entries the page lists, newest first. */
export const ACTIVITY_SHOWN = 100

const pairKey = (from: string, to: string): string => `${from}:${to}`

function Badge({ tone, children }: { tone: 'danger' | 'caution' | 'verify' | 'plain'; children: React.ReactNode }): JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-1.5 text-[11px] font-medium leading-[18px]',
        tone === 'danger' && 'border-danger/40 bg-danger/5 text-danger-700 dark:text-danger-400',
        tone === 'caution' && 'border-caution/40 bg-caution/5 text-caution-700 dark:text-caution-400',
        tone === 'verify' && 'border-verify/40 bg-verify/5 text-verify-700 dark:text-verify-400',
        tone === 'plain' && 'border-anvil-300 text-anvil-600 dark:border-anvil-700 dark:text-anvil-300',
      )}
      data-testid="activity-badge"
    >
      {children}
    </span>
  )
}

function CommitLink({ addr, oid }: { addr: RepoAddress; oid: string }): JSX.Element {
  return (
    <Link href={repoHref('/repo/commit', addr, { oid })} className="hit-area hover:text-forge-800 dark:hover:text-forge-400">
      <Oid value={oid} copyable={false} />
    </Link>
  )
}

/** One entry: who, what, from and to, when. */
function EventRow({ e, addr, configAuthor }: { e: RefEvent; addr: RepoAddress; configAuthor: string | undefined }): JSX.Element {
  const who = e.by ?? configAuthor
  const icon =
    e.kind === 'deleted' ? (
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
    ) : e.kind === 'forcePushed' || e.kind === 'moved' ? (
      <TriangleAlert className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    ) : e.kind === 'protectionLifted' ? (
      <LockOpen className="h-3.5 w-3.5 text-caution-700 dark:text-caution-400" aria-hidden />
    ) : e.kind === 'protectionAdded' || e.kind === 'protectionRestored' ? (
      <Lock className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
    ) : (
      <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
    )
  const verb: Record<RefEvent['kind'], string> = {
    created: 'created it at',
    pushed: 'pushed',
    forcePushed: 'force-pushed',
    updated: 'updated it',
    moved: 'moved it',
    deleted: 'deleted it',
    protectionAdded: 'protected it',
    protectionLifted: 'lifted its protection',
    protectionRestored: 'protected it again',
  }
  const badge =
    e.kind === 'forcePushed' ? (
      <Badge tone="danger">force-pushed</Badge>
    ) : e.kind === 'moved' ? (
      <Badge tone="danger">moved</Badge>
    ) : e.kind === 'protectionLifted' ? (
      <Badge tone="caution">protection lifted</Badge>
    ) : e.kind === 'protectionRestored' ? (
      <Badge tone="verify">protection restored</Badge>
    ) : e.kind === 'created' ? (
      <Badge tone="plain">created</Badge>
    ) : e.kind === 'deleted' ? (
      <Badge tone="plain">deleted</Badge>
    ) : null
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-anvil-100 px-4 py-2.5 text-dense last:border-b-0 dark:border-anvil-850" data-kind={e.kind}>
      <span className="text-anvil-500 dark:text-anvil-400">{icon}</span>
      {who ? <Author identityId={who} /> : <span className="text-anvil-600 dark:text-anvil-300">A maintainer</span>}
      <span>{verb[e.kind]}</span>
      {e.kind === 'created' && e.to !== null ? <CommitLink addr={addr} oid={e.to} /> : null}
      {e.from !== null && e.to !== null ? (
        <span className="inline-flex items-center gap-1">
          <CommitLink addr={addr} oid={e.from} />
          <span aria-label="to">→</span>
          <CommitLink addr={addr} oid={e.to} />
        </span>
      ) : null}
      {e.kind === 'deleted' && e.from !== null ? (
        <span className="inline-flex items-center gap-1 text-anvil-600 dark:text-anvil-300">
          (was <CommitLink addr={addr} oid={e.from} />)
        </span>
      ) : null}
      {badge}
      <span className="ml-auto text-[12px] text-anvil-500 dark:text-anvil-400">
        <Time ms={e.at} withDate />
      </span>
    </li>
  )
}

export function RefActivityContent({ home, addr, refName }: { home: RepoHome; addr: RepoAddress; refName: string }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const isTag = refName.startsWith('refs/tags/')
  const shortName = refName.replace(/^refs\/(heads|tags)\//, '')
  const history = useAsync(() => readRefHistory(sdk!, home.repo, refName), [ready, repoKey(home.repo), network, refName], {
    enabled: ready && sdk !== null && shortName !== '',
  })
  const h = history.data
  // First without git: which branch moves need checking.
  const unchecked = useMemo(() => (h === null ? [] : refHistory(refName, h.refNameHash, h.updates, h.configs, () => null)), [h, refName])
  const pairs = useMemo(
    () =>
      unchecked
        .filter((e) => e.kind === 'updated' && e.from !== null && e.to !== null)
        .slice(-CONTAINS_CHECKED)
        .map((e) => [e.from as string, e.to as string] as const),
    [unchecked],
  )
  const browse = useBrowse(pairs.length > 0 ? home.repo : null)
  const view = useTrustView()
  const shared = browse.data?.kind === 'ready' ? browse.data.context.reader : null
  const reader = useMemo(() => shared?.forView(view) ?? null, [shared, view])
  const checked = useAsync(
    async () => {
      const out = new Map<string, boolean | null>()
      for (const [from, to] of pairs) out.set(pairKey(from, to), await tipContains(reader!, from, to))
      return out
    },
    [reader === null, pairs.map(([f, t]) => pairKey(f, t)).join(',')],
    { enabled: reader !== null && pairs.length > 0 },
  )
  const events = useMemo(() => {
    if (h === null) return []
    const known = checked.data
    const all = refHistory(refName, h.refNameHash, h.updates, h.configs, (from, to) => known?.get(pairKey(from, to)) ?? null)
    return all.reverse()
  }, [h, refName, checked.data])
  const configAuthors = useMemo(() => new Map((h?.configs ?? []).map((c) => [c.id ?? '', c.author])), [h])

  const back = isTag ? '/repo/tags' : '/repo/branches'
  const Icon = isTag ? Tag : GitBranch
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={repoHref(back, addr)} className="hit-area inline-flex items-center gap-1 text-dense text-anvil-600 hover:text-forge-800 dark:text-anvil-300 dark:hover:text-forge-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {isTag ? 'Tags' : 'Branches'}
      </Link>
      <h1 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">
        <Icon className="h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="truncate font-mono">{shortName}</span>
        <span className="font-normal text-anvil-500 dark:text-anvil-400">activity</span>
      </h1>
    </div>
  )
  if (history.error !== null) {
    return (
      <div className="space-y-4">
        {header}
        <ErrorState title="Couldn't read this ref's history" message={history.error} onRetry={history.reload} />
      </div>
    )
  }
  if (h === null) {
    return (
      <div className="space-y-4">
        {header}
        <LoadingBlock label="Reading the history…" />
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Icon} title="No activity" body={`Nothing has ever been pushed to ${shortName}.`} />
      </div>
    )
  }
  const shown = events.slice(0, ACTIVITY_SHOWN)
  return (
    <div className="space-y-4">
      {header}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {plural(events.length, 'entry', 'entries')}, newest first, from the history on Platform.
        {checked.loading ? ' Checking which pushes kept the old commit…' : null}
      </p>
      <ol className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="ref-activity">
        {shown.map((e) => (
          <EventRow key={`${e.kind}:${e.id}`} e={e} addr={addr} configAuthor={configAuthors.get(e.id)} />
        ))}
      </ol>
      {events.length > shown.length ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Showing the newest {ACTIVITY_SHOWN}. `dg repo activity` lists them all.</p>
      ) : null}
    </div>
  )
}
