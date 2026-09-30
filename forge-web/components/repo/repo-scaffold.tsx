'use client'

/**
 * RepoScaffold — the shared repo-page frame. Resolves the repo home view-model, handles the
 * loading / not-found / error states once, and lays out the header + content + right rail so
 * each route only supplies its own body via a render prop.
 */

import type { ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import Link from 'next/link'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { Button } from '@/components/ui/button'
import { ConnectingBlock, UnreachableBanner } from '@/components/ui/platform-status'
import { RepoHeader } from '@/components/repo/repo-header'
import { RepoShellHeader } from '@/components/repo/repo-shell-header'
import { RepoRail } from '@/components/repo/repo-rail'
import { useRepoHome } from '@/hooks/use-repo'
import { useSdk } from '@/hooks/use-sdk'
import { usePrivateHome } from '@/hooks/use-private-home'
import { PrivateBanner } from '@/components/repo/private-banner'
import { InviteBanner } from '@/components/repo/invite-banner'
import { PrivateRepoState } from '@/components/repo/private-repo-state'
import { RepoNotFound } from '@/components/repo/repo-not-found'
import { failedRows, selectRef, type RepoHome, type SelectedRef } from '@/lib/view'
import { useRepoTrust } from '@/hooks/use-repo-trust'
import { TrustFailureBanner } from '@/components/ui/trust-alert'
import { repoHref, useExpiredLink, type RepoAddress } from '@/hooks/use-query-param'

export function RepoScaffold({
  addr,
  children,
  rail = true,
  refParam = '',
  sealedOk = false,
  browse = false,
}: {
  addr: RepoAddress
  /** The page body; `reload` re-reads the repo home (after a write that changes it). */
  children: (home: RepoHome, reload: () => void) => ReactNode
  rail?: boolean
  /** The `?ref=` selection of a ref-aware route — the rail's assay attests this ref's tip. */
  refParam?: string
  /**
   * The page renders for a private repo the viewer cannot decrypt (Settings: the member list is
   * public). Every other page shows the private state instead of its content (§6.3).
   */
  sealedOk?: boolean
  /** The page reads code (home, tree, blob, commits): start the browse index with the refs. */
  browse?: boolean
}): JSX.Element {
  const { data, loading, error, cause, settled, ready, reload } = useRepoHome(addr, { browse })
  const { status: sdkStatus, retry: retrySdk } = useSdk()
  // A private repo is re-read through the viewer's decryption session (or shown as sealed).
  const privateHome = usePrivateHome(data ?? null, addr)
  const expiredLink = useExpiredLink()

  if (!addr.owner || (!addr.name && !addr.repoId)) {
    return (
      <>
        <EmptyState
          icon={GitBranch}
          title="No repo addressed"
          body="This page needs ?owner= and &name= in the URL."
          action={<Link href="/"><Button variant="primary">Discover repos</Button></Link>}
        />
      </>
    )
  }

  if (!isForgeDeployed()) {
    return (
      <>
        <NotDeployedState />
      </>
    )
  }

  // Platform unreachable (D-058): keep what this tab already read (the home cache) under a
  // banner that says it is not being re-checked; with nothing cached, the banner alone. Either
  // way the connection retries with backoff, and "Try again" reconnects now.
  const offline = sdkStatus.phase === 'error' ? <UnreachableBanner status={sdkStatus} onRetry={retrySdk} cached={data != null} /> : null
  if (offline !== null && data == null) {
    return offline
  }

  // While the SDK connects (or a cold resolve is in flight) show the shell — never flash
  // "not found" before the query has had a chance to run. A warm navigation is seeded
  // synchronously from the home cache (`settled`, including a cached not-found) and renders
  // its real state immediately, even while a background revalidation is still loading.
  if (offline === null && (!ready || (loading && !settled))) {
    // The repo's name and tabs from its address, while the SDK downloads or the repo resolves
    // (L-54): a slow link shows what it is loading, not a bare spinner.
    return (
      <>
        <RepoShellHeader addr={addr} />
        {ready ? <LoadingBlock label={`Resolving ${addr.name}`} /> : <ConnectingBlock status={sdkStatus} />}
      </>
    )
  }

  if (error) {
    return (
      <>
        <ErrorState message={error} cause={cause} onRetry={reload} />
      </>
    )
  }

  if (data === null) return <RepoNotFound addr={addr} />

  if (privateHome?.error) {
    return (
      <>
        <ErrorState title="Couldn't open this private repo" message={privateHome.error} onRetry={privateHome.retry} />
      </>
    )
  }
  if (privateHome === null || privateHome.pending) {
    return (
      <>
        <RepoShellHeader addr={addr} />
        <LoadingBlock label="Checking membership and keys" />
      </>
    )
  }
  const home = privateHome.home

  // A private repo's file and branch links carry tokens that only mean something in the tab
  // that made them (`lib/view/private-nav.ts`).
  if (expiredLink) {
    return (
      <>
        {offline}
        <RepoHeader home={home} addr={addr} />
        <EmptyState
          icon={GitBranch}
          title="This link only works in the tab that opened it"
          body="File and branch names of a private repo are kept out of links. Open the repo and browse to it again."
          action={<Link href={repoHref('/repo', addr)}><Button variant="primary">Open the repo</Button></Link>}
        />
      </>
    )
  }

  // The rail's assay attests the ref the page shows: the `?ref=` selection, else the
  // default branch.
  const selected = selectRef(home.branches, home.tags, home.defaultBranch, refParam)

  // A private repo the viewer cannot decrypt: only what is public (`ux-dx-spec.md` §6.3). No
  // decrypted string exists to render, and no page reads content for it.
  const sealed = home.repo.visibility === 'private' && home.private?.access !== 'member'
  if (sealed && !sealedOk) {
    return (
      <>
        {offline}
        <RepoHeader home={home} addr={addr} />
        <InviteBanner repo={home.repo} />
        <PrivateBanner home={home} />
        <PrivateRepoState repo={home.repo} addr={addr} access={home.private?.access ?? 'outsider'} />
      </>
    )
  }

  return (
    <>
      {offline}
      <RepoTrustBanner home={home} selected={selected} />
      <RepoHeader home={home} addr={addr} />
      <InviteBanner repo={home.repo} />
      <PrivateBanner home={home} />
      {rail ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_296px]">
          <div className="min-w-0">{children(home, reload)}</div>
          <RepoRail home={home} addr={addr} selected={selected} />
        </div>
      ) : (
        <div className="min-w-0">{children(home, reload)}</div>
      )}
    </>
  )
}

/**
 * The Verification card's rows a repo page leads with. Not chain data: the app shell heads every
 * page with it. Not "where the bytes came from": it is Failed only when the content check failed,
 * which is listed already (no storage answering is an outage, "Couldn't verify", which the
 * page's own "Code unavailable" state reports).
 */
const REPO_ROWS = ['tip', 'content'] as const

/**
 * Any Failed row of the Verification card, at the top of a repo page (QW-004): the card sits in
 * the rail, which a phone lays out under the content and some pages do not show at all. A leaf,
 * so a content check re-renders only this and the rail.
 */
function RepoTrustBanner({ home, selected }: { home: RepoHome; selected: SelectedRef }): JSX.Element | null {
  const failures = failedRows(useRepoTrust(home, selected), REPO_ROWS)
  if (failures.length === 0) return null
  return <TrustFailureBanner lead="Nothing that failed its check is shown on this page." failures={failures} />
}
