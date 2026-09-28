'use client'

/**
 * Landing + discovery. The foundry hero states the thesis (no server to trust), the signature
 * verification chip sits under it — reporting whether this session's Platform connection
 * actually proof-checks reads — and the discovery feed lists recent repos from the active
 * network's forge-core when the SDK connects, a clear empty/error state otherwise.
 */

import Link from 'next/link'
import { Compass, GitBranch, Lock, Plus, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { VerificationChip } from '@/components/ui/verification-chip'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'
import { DownloadProgressBar, UnreachableBanner } from '@/components/ui/platform-status'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useQuorumCheck } from '@/hooks/use-quorum-check'
import { deriveConnectionTrust, listRecentRepos, type DiscoveredRepo } from '@/lib/view'

export default function LandingPage(): JSX.Element {
  const { sdk, ready, connection, network, status: sdkStatus, retry: retrySdk } = useSdk()
  // Not while Platform is unreachable: a comparison run then only reports that it could not run.
  const quorum = useQuorumCheck(network, connection === 'trusted')
  const proofs = deriveConnectionTrust(network, connection, quorum)
  const deployed = isForgeDeployed()
  const feed = useAsync(
    () => listRecentRepos(sdk!, { network, limit: 24 }),
    [ready, network],
    { enabled: deployed && ready && sdk !== null },
  )

  return (
    <AppShell wide>
      {/* Hero */}
      <section className="mx-auto max-w-3xl pb-4 pt-8 text-center sm:pt-14">
        <h1 className="text-3xl leading-tight tracking-tight sm:text-5xl">
          A git forge with <span className="text-forge-700 dark:text-forge-500">no server to trust.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-prose text-anvil-600 dark:text-anvil-300">
          Browse code, discuss issues and pull requests, and collaborate. Platform reads are
          checked against quorum proofs and file contents against their git hashes, straight
          from Dash Platform or the storage the repo owner chose. Foundry, not SaaS.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link href="/new/">
            <Button variant="primary" size="lg">
              <Plus className="h-4 w-4" aria-hidden /> New repo
            </Button>
          </Link>
          <Link href="/explore/">
            <Button variant="outline" size="lg">
              <Compass className="h-4 w-4" aria-hidden /> Explore
            </Button>
          </Link>
          <VerificationChip
            segments={[
              {
                label: `${network} reads`,
                state: proofs.state,
                detail: sdkStatus.phase === 'error' ? 'Not connected' : proofs.checking ? 'Checking…' : undefined,
              },
            ]}
          />
        </div>
      </section>

      {/* Capability strip */}
      <section className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
        <Feature icon={<Search className="h-4 w-4 text-forge-500" aria-hidden />} title="Size-independent browse" body="With a published browse index, tree, blob, and commit views fetch only the bytes they show, at any repo size." />
        <Feature icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />} title="Proof-checked reads" body="Refs by Platform proof, file contents by git hash. Each repo's Verification card shows what this session actually checked." />
        <Feature icon={<GitBranch className="h-4 w-4 text-forge-500" aria-hidden />} title="Issues & threads in-browser" body="Open issues, comment, close and reopen, and grant collaborators — each write signed by your Platform identity." />
      </section>

      {/* Discovery */}
      <section className="mt-14">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl">Recent repos</h2>
          <div className="flex items-center gap-3">
            {feed.loading ? <Spinner label="Reading forge-core" /> : null}
            <Link href="/explore/" className="hit-area text-dense text-forge-700 underline dark:text-forge-300">
              Explore more
            </Link>
          </div>
        </div>

        {!deployed ? (
          <NotDeployedState />
        ) : sdkStatus.phase === 'error' ? (
          <UnreachableBanner status={sdkStatus} onRetry={retrySdk} cached={feed.data !== null} />
        ) : null}
        {!deployed ? null : feed.error ? (
          <ErrorState message={feed.error} onRetry={feed.reload} />
        ) : feed.data && feed.data.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="The forge is quiet"
            body="No repos have been created on this network yet. Forge the first one."
            action={
              <Link href="/new/">
                <Button variant="primary">
                  <Plus className="h-4 w-4" aria-hidden /> New repo
                </Button>
              </Link>
            }
          />
        ) : feed.data ? (
          <RepoGrid repos={feed.data} />
        ) : sdkStatus.phase === 'error' ? null : sdkStatus.phase === 'downloading' ? (
          <DownloadProgressBar status={sdkStatus} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg border border-anvil-200 bg-anvil-100/60 dark:border-anvil-800 dark:bg-anvil-900" />
            ))}
          </div>
        )}
      </section>
    </AppShell>
  )
}

function RepoGrid({ repos }: { repos: readonly DiscoveredRepo[] }): JSX.Element | null {
  if (repos.length === 0) return null
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {repos.map((r) => (
        <RepoCard key={r.key} repo={r} />
      ))}
    </div>
  )
}

function Feature({ icon, title, body }: { icon: ReactNode; title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-anvil-200 bg-anvil-50 p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-dense font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-400">{body}</p>
    </div>
  )
}
