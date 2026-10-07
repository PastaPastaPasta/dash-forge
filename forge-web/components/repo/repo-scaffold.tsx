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
import { failedRows, selectRef, type RepoHome, type RepoHomeRefs, type SelectedRef } from '@/lib/view'
import { useRepoTrust } from '@/hooks/use-repo-trust'
import { TrustFailureBanner } from '@/components/ui/trust-alert'
import { TrustPanel } from '@/components/ui/trust-panel'
import { repoHref, useExpiredLink, type RepoAddress } from '@/hooks/use-query-param'
import { SignedOutView } from '@/contexts/auth-context'
import { usePublicView } from '@/hooks/use-public-view'
import { PublicViewBanner, ViewAsPublicButton } from '@/components/repo/audience'

export function RepoScaffold({
  addr,
  children,
  rail = true,
  verification = false,
  refParam = '',
  sealedOk = false,
  browse = false,
  refs = 'all',
}: {
  addr: RepoAddress
  /** The page body; `reload` re-reads the repo home (after a write that changes it). */
  children: (home: RepoHome, reload: () => void) => ReactNode
  rail?: boolean
  /**
   * With no rail: lead the page with the rail's Verification card, collapsed to one line (code
   * pages give the width to the code and keep the card).
   */
  verification?: boolean
  /** The `?ref=` selection of a ref-aware route — the rail's assay attests this ref's tip. */
  refParam?: string
  /**
   * The page renders for a private repo the viewer cannot decrypt (Settings: the member list is
   * public). Every other page shows the private state instead of its content (§6.3).
   */
  sealedOk?: boolean
  /** The page reads code (home, tree, blob, commits): start the browse index with the refs. */
  browse?: boolean
  /**
   * `default`: the page shows no ref but the default branch (the issue and PR lists), so its home
   * resolves that branch alone ({@link RepoHomeRefs}).
   */
  refs?: RepoHomeRefs
}): JSX.Element {
  const repoHome = useRepoHome(addr, { browse, refs })
  // "View as public" (DESIGN §10): the whole page, the repo's own state included, read signed out.
  const [publicView, setPublicView] = usePublicView(repoHome.data?.repo.repoId ?? '')
  const body = <ScaffoldBody {...{ addr, children, rail, verification, refParam, sealedOk, repoHome }} />
  if (!publicView) return body
  return (
    <>
      <PublicViewBanner repoId={repoHome.data?.repo.repoId ?? ''} onExit={() => setPublicView(false)} />
      <SignedOutView>{body}</SignedOutView>
    </>
  )
}

function ScaffoldBody({
  addr,
  children,
  rail,
  verification,
  refParam,
  sealedOk,
  repoHome,
}: {
  addr: RepoAddress
  children: (home: RepoHome, reload: () => void) => ReactNode
  rail: boolean
  verification: boolean
  refParam: string
  sealedOk: boolean
  repoHome: ReturnType<typeof useRepoHome>
}): JSX.Element {
  const { data, loading, error, cause, settled, ready, reload } = repoHome
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
      <ViewAsPublicButton home={home} />
      {rail ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_296px]">
          <div className="min-w-0">{children(home, reload)}</div>
          <RepoRail home={home} addr={addr} selected={selected} />
        </div>
      ) : (
        <div className="min-w-0 space-y-4">
          {verification ? <RepoVerification home={home} selected={selected} /> : null}
          <div className="min-w-0">{children(home, reload)}</div>
        </div>
      )}
    </>
  )
}

/**
 * The Verification card of a page with no rail (code pages, compare): a leaf, so a content check
 * re-renders only it.
 */
export function RepoVerification({ home, selected }: { home: RepoHome; selected: SelectedRef }): JSX.Element {
  return <TrustPanel report={useRepoTrust(home, selected)} />
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
