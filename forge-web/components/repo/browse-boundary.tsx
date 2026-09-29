'use client'

/**
 * BrowseBoundary — resolves a repo's browse context and renders the honest degraded state when
 * a repo's published browse index does not cover what is stored. On success it hands the caller
 * a ready {@link BrowseReader}. When only the index is missing or behind, the raw kind-0 packs
 * are still fully readable, so the boundary offers (or, for small repos, auto-runs) the
 * in-browser fallback clone: download the live packs, index them client-side, browse from
 * local memory. The state machine itself is {@link useBrowseReader}.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, HardDriveDownload, PackageOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { useBrowseReader } from '@/hooks/use-browse-reader'
import { useTrustView } from '@/hooks/use-trust-view'
import type { BrowseReader } from '@/lib/browse'
import { repoKey, type RepoRef } from '@/lib/repo'
import { formatBytes, invalidateBrowseContext, plural, StorageUnreachableError, type UnavailablePack } from '@/lib/view'
import { readOutages, scheduleReconnect, subscribeReadOutages } from '@/lib/view/reconnect'
import { StorageUnreachableCard } from '@/components/repo/storage-unreachable'
import type { RepoAddress } from '@/hooks/use-query-param'

/**
 * The honest caveat for a partial in-browser clone: some live packs live in external storage
 * nobody could serve, so what is shown is checked but not the whole repo.
 */
function UnavailablePacksNotice({ packs }: { packs: readonly UnavailablePack[] }): JSX.Element {
  const n = packs.length
  const corrupt = packs.filter((p) => p.corrupt).length
  return (
    <div
      role="status"
      className="mb-3 flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
      <div>
        <p>
          {plural(n, 'pack')} could not be fetched from {n === 1 ? 'its' : 'their'} storage; some
          objects may be missing. Everything shown was still hash-checked.
        </p>
        {corrupt > 0 ? (
          <p className="mt-1 font-medium text-danger-700 dark:text-danger-400">
            {corrupt === 1 ? 'A mirror' : 'Mirrors'} served bad data for {plural(corrupt, 'pack')}: bytes that do not match the sha256 in the proof-checked
            manifest. They were refused.
          </p>
        ) : null}
        <ul className="mt-1 space-y-0.5 font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
          {packs.map((p) => (
            <li key={p.packHash}>
              {p.packHash.slice(0, 12)}… — {p.hosts.length > 0 ? p.hosts.join(', ') : 'no browser-fetchable mirror'}
              {p.corrupt ? ' (served bad data)' : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Automatic re-reads after outages that each ended in another outage, before asking the viewer. */
const MAX_FRUITLESS_RECOVERIES = 3

/**
 * Re-read the view after a read of repo `key` got no bytes (L-10), once the connection is back:
 * `epoch` goes up, and the view is keyed on it, so what failed to load (a README, the commit
 * column, a file row) is read again without a reload. Objects that did load are memoized by
 * the reader, so a re-read costs only what was missing (it re-runs the view, M2: it never drops
 * the repo's browse context). After {@link MAX_FRUITLESS_RECOVERIES} re-reads that each met
 * another outage it stops (`stalled`) and the view offers Try again instead (H2). Per repo:
 * another repo starts afresh (M4).
 */
function useReadRecovery(key: string): { epoch: number; stalled: boolean; resume: () => void } {
  const outages = useSyncExternalStore(subscribeReadOutages, () => readOutages(key), () => 0)
  const [state, setState] = useState({ key, handled: outages, epoch: 0, fruitless: 0 })
  const current = state.key === key ? state : { key, handled: outages, epoch: 0, fruitless: 0 }
  if (current !== state) setState(current)
  const stalled = current.fruitless >= MAX_FRUITLESS_RECOVERIES
  useEffect(() => {
    if (outages <= current.handled || stalled) return
    return scheduleReconnect(() =>
      // A re-read that met another outage since the last one did not get anywhere.
      setState((s) => ({ ...s, handled: outages, epoch: s.epoch + 1, fruitless: s.epoch > 0 ? s.fruitless + 1 : 0 })),
    )
  }, [outages, current.handled, stalled])
  // A quiet spell after a re-read (no new outage for a while) means it got through.
  useEffect(() => {
    if (current.fruitless === 0 || outages > current.handled) return
    const t = setTimeout(() => setState((s) => ({ ...s, fruitless: 0 })), 30_000)
    return () => clearTimeout(t)
  }, [current.fruitless, outages, current.handled])
  const resume = useCallback(() => setState((s) => ({ ...s, handled: outages, epoch: s.epoch + 1, fruitless: 0 })), [outages])
  return { epoch: current.epoch, stalled, resume }
}

export function BrowseBoundary({
  repo,
  addr,
  children,
}: {
  repo: RepoRef
  addr?: RepoAddress
  /**
   * The view over a ready reader. `retry` is its "Try again": it drops the repo's browse context,
   * so the view is rebuilt on a freshly resolved reader. Re-running on the same reader fails the
   * same way when that reader predates a push or a merge (L-09).
   */
  children: (reader: BrowseReader, retry: () => void) => ReactNode
}): JSX.Element {
  const state = useBrowseReader(repo)
  const key = repoKey(repo)
  const retry = useCallback(() => invalidateBrowseContext(key), [key])
  // The page reads for its own view, so the Verification summary names what served IT (L-18).
  const view = useTrustView()
  const shared = state.kind === 'ready' ? state.reader : null
  const reader = useMemo(() => shared?.forView(view) ?? null, [shared, view])
  const recovery = useReadRecovery(key)

  switch (state.kind) {
    case 'loading':
      return <LoadingBlock label={state.label} />
    case 'error':
      if (state.cause instanceof StorageUnreachableError) {
        return <StorageUnreachableCard repo={repo} addr={addr} packs={state.cause.packs} retry={state.retry} />
      }
      return <ErrorState title={state.title} message={state.message} cause={state.cause} onRetry={state.retry} />
    case 'no-packs':
      return (
        <EmptyState
          icon={PackageOpen}
          title="Nothing stored to browse yet"
          body="This repo has no stored packs. Push with the helper or via dash:// to populate it."
        />
      )
    case 'ready': {
      // Keyed by the reader: one resolved from a newer pack list (a push, a merge) replaces the
      // view, whose reads then run against it, instead of keeping what the old one showed.
      // And by the recovery epoch: once a read outage is over, the view reads again (L-10).
      const body = (
        <>
          {recovery.stalled ? (
            <div role="status" data-testid="read-recovery-stalled" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-anvil-700 dark:text-anvil-200">
              Parts of this page could not be loaded: the connection keeps dropping.
              <button type="button" onClick={recovery.resume} className="underline coarse:min-h-11">
                Try again
              </button>
            </div>
          ) : null}
          <Fragment key={`${state.version}:${recovery.epoch}`}>{children(reader ?? state.reader, retry)}</Fragment>
        </>
      )
      if (!state.local) return body
      return (
        <div>
          <p className="mb-3 text-dense text-anvil-500 dark:text-anvil-400">
            Viewing a copy loaded into your browser — this repo&apos;s browse index{' '}
            {state.behind ? "doesn't cover everything stored" : "hasn't been published"} yet.
          </p>
          {state.unavailable.length > 0 ? <UnavailablePacksNotice packs={state.unavailable} /> : null}
          {body}
        </div>
      )
    }
    case 'offer':
      return (
        <EmptyState
          icon={PackageOpen}
          title={state.behind ? 'Browse index is behind' : 'Not indexed for browsing yet'}
          body={`${
            state.behind
              ? "This repo's published index does not cover every stored pack, so reading through it would miss recent objects."
              : 'This repo has not published an objectLocator.'
          } Its raw packs are fully readable. Load them here to browse in your browser (about ${formatBytes(state.sizeBytes)}), or clone via dash:// to read it locally.`}
          action={
            <Button variant="primary" onClick={state.start}>
              <HardDriveDownload className="h-4 w-4" aria-hidden />
              Load repo in browser ({formatBytes(state.sizeBytes)})
            </Button>
          }
        />
      )
  }
}
