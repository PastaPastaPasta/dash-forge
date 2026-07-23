'use client'

/**
 * RepoScaffold — the shared repo-page frame. Resolves the repo home view-model, handles the
 * loading / not-found / error states once, and lays out the header + content + right rail so
 * each route only supplies its own body via a render prop.
 */

import type { ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { Button } from '@/components/ui/button'
import { RepoHeader } from '@/components/repo/repo-header'
import { RepoRail } from '@/components/repo/repo-rail'
import type { TrustChain } from '@/components/ui/trust-panel'
import { useRepoHome } from '@/hooks/use-repo'
import type { RepoHome } from '@/lib/view'
import type { RepoAddress } from '@/hooks/use-query-param'

export function RepoScaffold({
  addr,
  children,
  rail = true,
  chainOverride,
}: {
  addr: RepoAddress
  children: (home: RepoHome) => ReactNode
  rail?: boolean
  chainOverride?: Partial<TrustChain>
}): JSX.Element {
  const { data, loading, error, sdkError, ready, reload } = useRepoHome(addr.owner, addr.name)

  if (!addr.owner || !addr.name) {
    return (
      <AppShell wide>
        <EmptyState
          icon={GitBranch}
          title="No repo addressed"
          body="This page needs ?owner= and &name= in the URL."
          action={<Link href="/"><Button variant="primary">Discover repos</Button></Link>}
        />
      </AppShell>
    )
  }

  if (sdkError) {
    return (
      <AppShell wide>
        <ErrorState title="Could not reach Platform" message={sdkError} />
      </AppShell>
    )
  }

  // While the SDK connects (or the resolve is in flight) show the shell — never flash
  // "not found" before the query has had a chance to run.
  if (!ready || loading) {
    return (
      <AppShell wide>
        <LoadingBlock label={ready ? `Resolving ${addr.name}` : 'Connecting to Platform'} />
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell wide>
        <ErrorState message={error} onRetry={reload} />
      </AppShell>
    )
  }

  if (data === null) {
    return (
      <AppShell wide>
        <EmptyState
          icon={GitBranch}
          title="Repo not found"
          body={`No authentic registry listing resolves ${addr.owner}/${addr.name} on this network.`}
          action={<Link href="/"><Button variant="primary">Discover repos</Button></Link>}
        />
      </AppShell>
    )
  }

  const home = data
  return (
    <AppShell wide>
      <RepoHeader home={home} addr={addr} />
      {rail ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_296px]">
          <div className="min-w-0">{children(home)}</div>
          <RepoRail home={home} addr={addr} chainOverride={chainOverride} />
        </div>
      ) : (
        <div className="min-w-0">{children(home)}</div>
      )}
    </AppShell>
  )
}
