'use client'

/**
 * GitHub's fork bar on a fork's Code tab (P1-4): how its default branch stands against the
 * parent's default branch, and "Sync fork" for the fork's maintainers and writers.
 *
 * On load it costs two reads (the parent's config timeline and that one ref): equal tips say
 * "up to date". Anything else is worked out only on demand ("Sync fork", or "Compare" for anyone
 * else), since it needs the parent's history: the merge-base walk the PR pages use, through the
 * fork's reader and the parent's, then each side's own commits counted.
 *
 * Only a fast-forward is written (`syncFork`, parity with `dg repo sync`): the parent's packs the
 * fork does not record yet, by reference, then one ref update. A branch with commits of its own
 * is never moved: the bar offers a pull request into the fork that merges the parent's branch,
 * or, when the fork is only ahead, the parent's New pull request form.
 */

import { useState } from 'react'
import Link from 'next/link'
import { GitFork, GitPullRequest, RefreshCw } from 'lucide-react'

import type { BrowseReader } from '@/lib/browse'
import { readSyncManifests, readSyncTarget, repoKey, syncDecision, syncFork, type RepoRef, type SyncManifests } from '@/lib/repo'
import { matchesProtected } from '@/lib/rules'
import { capabilitiesOf } from '@/lib/rules/roles'
import type { Role } from '@/lib/rules/v2'
import { EXISTING, newIntent, previewCreate, sumPreviews, type CostPreview as Cost } from '@/lib/sdk'
import { spendAction } from '@/lib/spend-toast'
import { ARCHIVED_REASON, formatBytes, plural, type RepoHome } from '@/lib/view'
import { historyWalker } from '@/lib/view/pull-diff'
import { syncAncestry, SYNC_COUNT_CAP } from '@/lib/view/fork-sync'
import { abbreviate } from '@/lib/utils'
import { useAsync } from '@/hooks/use-async'
import { useBrowseReader } from '@/hooks/use-browse-reader'
import { useSdk } from '@/hooks/use-sdk'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useAuth } from '@/contexts/auth-context'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { contributeHref, useForkParent } from '@/components/repo/fork-contribute'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { Spinner } from '@/components/ui/states'

/** `owner/name:branch`, as GitHub names the parent's branch. */
function parentLabel(parent: RepoRef, branch: string): string {
  return `${abbreviate(parent.ownerId)}/${parent.name}:${branch}`
}

/** "N commits", or "more than 1,000 commits" past the count's cap. */
function commitsText(n: number | null): string {
  return n === null ? `more than ${SYNC_COUNT_CAP.toLocaleString('en-US')} commits` : plural(n, 'commit')
}

/** The pre-sign cost of a sync writing `plan`: its manifests into a repo that has some, and one ref update. */
export function syncCost(plan: SyncManifests): Cost {
  return sumPreviews([...plan.manifests.map((m) => previewCreate('packManifest', { uris: m.uris }, EXISTING)), previewCreate('refUpdate', {}, EXISTING)])
}

/**
 * Why the viewer cannot sync this fork's default branch, or null: an archived fork, a role that
 * cannot push, or a protected branch for a writer.
 */
export function syncBlock(home: RepoHome, role: Role | null): string | null {
  if (home.config?.archived === true) return ARCHIVED_REASON
  if (!capabilitiesOf(role).canPush) return null
  if (role !== 'maintainer' && matchesProtected(`refs/heads/${home.defaultBranch}`, home.config?.protectedPatterns ?? [])) {
    return `${home.defaultBranch} is protected here: only maintainers can sync it.`
  }
  return null
}

export function ForkSyncBar({
  home,
  addr,
  forkReader,
  forkTip,
  reload,
}: {
  home: RepoHome
  addr: RepoAddress
  forkReader: BrowseReader
  forkTip: string
  reload?: () => void
}): JSX.Element | null {
  const { sdk, ready } = useSdk()
  const parent = useForkParent(home)
  const { role } = useViewerRole(home.repo)
  const [open, setOpen] = useState(false)
  const target = useAsync(() => readSyncTarget(sdk!, parent!), [ready, parent === null ? '' : repoKey(parent)], { enabled: ready && sdk !== null && parent !== null })
  if (parent === null) return null
  const t = target.data
  const canPush = capabilitiesOf(role).canPush
  const upToDate = t !== null && t.tip !== null && t.tip.toLowerCase() === forkTip.toLowerCase()
  const label = t === null ? null : parentLabel(parent, t.branch)
  return (
    <section aria-label="Fork status" className="rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="fork-sync">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
        <GitFork className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <p className="min-w-0 flex-1" data-testid="fork-sync-status" role="status">
          {t === null ? (
            target.error !== null ? (
              <>Couldn&apos;t read the parent&apos;s default branch.</>
            ) : (
              <>Reading where the parent&apos;s branch is…</>
            )
          ) : t.tip === null ? (
            <>
              <span className="font-mono">{label}</span> has no commits.
            </>
          ) : upToDate ? (
            <>
              This branch is up to date with <span className="font-mono">{label}</span>.
            </>
          ) : (
            <>
              This branch is not the same as <span className="font-mono">{label}</span>.
            </>
          )}
        </p>
        {t !== null && t.tip !== null && !upToDate ? (
          <Button variant={canPush ? 'outline' : 'ghost'} size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="fork-sync-panel" data-testid="fork-sync-open">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {canPush ? 'Sync fork' : 'Compare'}
          </Button>
        ) : null}
      </div>
      {open && t !== null && t.tip !== null ? (
        <div id="fork-sync-panel" className="border-t border-anvil-200 px-3 py-3 dark:border-anvil-800">
          <SyncPanel home={home} addr={addr} parent={parent} parentBranch={t.branch} parentTip={t.tip} forkReader={forkReader} forkTip={forkTip} canPush={canPush} block={syncBlock(home, role)} reload={reload} />
        </div>
      ) : null}
    </section>
  )
}

function SyncPanel({
  home,
  addr,
  parent,
  parentBranch,
  parentTip,
  forkReader,
  forkTip,
  canPush,
  block,
  reload,
}: {
  home: RepoHome
  addr: RepoAddress
  parent: RepoRef
  parentBranch: string
  parentTip: string
  forkReader: BrowseReader
  forkTip: string
  canPush: boolean
  block: string | null
  reload?: () => void
}): JSX.Element {
  const parentReader = useBrowseReader(parent)
  const ready = parentReader.kind === 'ready'
  const ancestry = useAsync(
    async (signal) => {
      if (parentReader.kind !== 'ready') throw new Error('the parent is not readable yet')
      // One read-ahead walk over both repos: the parent's history first, then the fork's.
      const walk = historyWalker(parentReader.reader, forkReader)
      try {
        return await syncAncestry(walk.reader, forkTip, parentTip, { signal })
      } finally {
        walk.done()
      }
    },
    [ready ? parentReader.version : '', forkTip, parentTip],
    { enabled: ready },
  )
  const label = parentLabel(parent, parentBranch)

  if (parentReader.kind === 'offer') {
    return (
      <p className="text-dense text-anvil-600 dark:text-anvil-300">
        Comparing reads {parent.name}&apos;s history in this browser ({formatBytes(parentReader.sizeBytes)} to download).{' '}
        <Button variant="outline" size="sm" onClick={parentReader.start}>
          Load it
        </Button>
      </p>
    )
  }
  if (parentReader.kind === 'error') {
    return (
      <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
        {parentReader.message}{' '}
        <Button variant="ghost" size="sm" onClick={parentReader.retry}>
          Retry
        </Button>
      </p>
    )
  }
  if (parentReader.kind === 'no-packs') return <p className="text-dense text-anvil-600 dark:text-anvil-300">{parent.name} has no packs to compare with.</p>
  if (parentReader.kind === 'loading' || ancestry.loading || ancestry.data === null) {
    if (ancestry.error !== null) {
      return (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          Couldn&apos;t compare the histories: {ancestry.error}{' '}
          <Button variant="ghost" size="sm" onClick={ancestry.reload}>
            Retry
          </Button>
        </p>
      )
    }
    return <Spinner label={parentReader.kind === 'loading' ? parentReader.label : 'Comparing the histories'} />
  }
  const a = ancestry.data
  const decision = syncDecision(forkTip, parentTip, a.forkInParent, a.parentInFork)
  const branch = home.defaultBranch
  if (decision === 'fastForward') {
    return (
      <div className="space-y-2">
        <p className="text-dense text-anvil-700 dark:text-anvil-200" data-testid="fork-sync-behind">
          This branch is {commitsText(a.behind)} behind <span className="font-mono">{label}</span>, and can be fast-forwarded to it.
        </p>
        {canPush ? (
          <UpdateBranch home={home} parent={parent} parentTip={parentTip} forkTip={forkTip} block={block} reload={reload} />
        ) : (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">The fork&apos;s maintainers and writers can update it.</p>
        )}
      </div>
    )
  }
  if (decision === 'ahead') {
    return (
      <div className="space-y-2" data-testid="fork-sync-ahead">
        <p className="text-dense text-anvil-700 dark:text-anvil-200">
          This branch is {commitsText(a.ahead)} ahead of <span className="font-mono">{label}</span>: there is nothing to sync.
        </p>
        <Link href={contributeHref(parent, home.repo, branch)} className="inline-flex items-center gap-1 text-dense text-forge-700 hover:underline dark:text-forge-400">
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> Open a pull request to {parent.name}
        </Link>
      </div>
    )
  }
  // Diverged (or no shared history): never moved. A pull request into the fork merges the parent's.
  return (
    <div className="space-y-2" data-testid="fork-sync-diverged">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        {a.unrelated ? (
          <>
            This branch and <span className="font-mono">{label}</span> share no history, so it can&apos;t be synced.
          </>
        ) : (
          <>
            This branch is {commitsText(a.ahead)} ahead of and {commitsText(a.behind)} behind <span className="font-mono">{label}</span>, so it can&apos;t be
            fast-forwarded: syncing never drops this fork&apos;s own commits.
          </>
        )}
      </p>
      {a.unrelated ? null : (
        <Link
          href={repoHref('/repo/pulls/new', addr, { base: branch, head: `${parent.repoId}:refs/heads/${parentBranch}` })}
          className="inline-flex items-center gap-1 text-dense text-forge-700 hover:underline dark:text-forge-400"
          data-testid="fork-sync-pr"
        >
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> Open a pull request to merge {label} into {branch}
        </Link>
      )}
    </div>
  )
}

/** "Update branch": the fast-forward, with what it records and costs. */
function UpdateBranch({
  home,
  parent,
  parentTip,
  forkTip,
  block,
  reload,
}: {
  home: RepoHome
  parent: RepoRef
  parentTip: string
  forkTip: string
  block: string | null
  reload?: () => void
}): JSX.Element {
  const { sdk, ready } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // One intent per sync: a retry after an unconfirmed write finishes it, never signs twice.
  const [intent] = useState(newIntent)
  const plan = useAsync(() => readSyncManifests(sdk!, home.repo, parent), [ready, repoKey(home.repo), repoKey(parent)], { enabled: ready && sdk !== null })
  const cost = plan.data === null ? null : syncCost(plan.data)
  const unreferenceable = plan.data?.unreferenceable.length ?? 0
  const off = block ?? guard.disabledReason ?? (unreferenceable > 0 ? `${plural(unreferenceable, 'pack')} of ${parent.name} have no copy a fork can name: push the branch from a full clone instead.` : null)

  const update = async (): Promise<void> => {
    if (pending || done || plan.data === null || cost === null || off !== null || !sdk || !signer || !guard.check(cost, 'core', 'sync this fork')) return
    setPending(true)
    setError(null)
    try {
      const data = plan.data
      await spendAction({ running: `Syncing ${home.defaultBranch}…`, done: `${home.defaultBranch} synced with ${parent.name}`, failed: 'Sync stopped part-way' }, (tag) =>
        syncFork(sdk, tag(signer), home.repo, {
          refName: `refs/heads/${home.defaultBranch}`,
          forkTip,
          parentTip,
          plan: data,
          intent: `fork-sync:${home.repo.repoId}:${intent}`,
        }),
      )
      setDone(true)
      reload?.()
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      {plan.data !== null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          {plan.data.manifests.length > 0
            ? `Records ${plural(plan.data.manifests.length, `new pack of ${parent.name}`, `new packs of ${parent.name}`)} by reference (nothing is uploaded), then moves ${home.defaultBranch}.`
            : `Moves ${home.defaultBranch}: this fork already records every pack it needs.`}
        </p>
      ) : plan.error !== null ? (
        <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">
          Couldn&apos;t read the packs: {plan.error}
        </p>
      ) : null}
      {cost !== null ? <CostPreview cost={cost} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={update} loading={pending} disabled={off !== null || cost === null || done} title={off ?? undefined} data-testid="fork-sync-update">
          {done ? 'Updated' : 'Update branch'}
        </Button>
        {off !== null ? <span className="text-[12px] text-caution-700 dark:text-caution-400">{off}</span> : null}
      </div>
      {error ? (
        <div role="alert" className="break-words rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400">
          {error}
        </div>
      ) : null}
    </div>
  )
}
