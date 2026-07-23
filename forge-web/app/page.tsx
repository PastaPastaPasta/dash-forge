'use client'

/**
 * Landing + discovery. The foundry hero states the thesis (no server to trust), the signature
 * verification chip sits under it, and the discovery feed lists recent registry repos — live
 * testnet data when the SDK connects, a clear empty/error state otherwise.
 */

import Link from 'next/link'
import { GitBranch, Lock, Plus, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { VerificationChip } from '@/components/ui/verification-chip'
import { EmptyState, ErrorState, Spinner } from '@/components/ui/states'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { listRecentRepos } from '@/lib/view'

export default function LandingPage(): JSX.Element {
  const { sdk, ready, error: sdkError, network } = useSdk()
  const feed = useAsync(
    () => listRecentRepos(sdk!, { network, limit: 24 }),
    [ready, network],
    { enabled: ready && sdk !== null },
  )

  return (
    <AppShell wide>
      {/* Hero */}
      <section className="mx-auto max-w-3xl pb-4 pt-8 text-center sm:pt-14">
        <h1 className="text-3xl leading-tight tracking-tight sm:text-5xl">
          A git forge with <span className="text-forge-500">no server to trust.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-prose text-anvil-600 dark:text-anvil-300">
          Browse code, review pull requests, and collaborate — every view backed by
          cryptographic proofs and content hashes, served straight from Dash Platform and IPFS.
          Foundry, not SaaS.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link href="/new">
            <Button variant="primary" size="lg">
              <Plus className="h-4 w-4" aria-hidden /> New repo
            </Button>
          </Link>
          <VerificationChip refs="verified" packs="verified" source="platform" />
        </div>
      </section>

      {/* Capability strip */}
      <section className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
        <Feature icon={<Search className="h-4 w-4 text-forge-500" aria-hidden />} title="Size-independent browse" body="Tree, blob, and commit views ride the browse plane — O(view) bytes at any repo size." />
        <Feature icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />} title="Proof-verified reads" body="Refs by platform proof, packs by sha256. The assay panel shows the whole chain." />
        <Feature icon={<GitBranch className="h-4 w-4 text-forge-500" aria-hidden />} title="Review & merge in-browser" body="Comments, close/reopen, and grants signed by your Platform identity." />
      </section>

      {/* Discovery */}
      <section className="mt-14">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl">Recent repos</h2>
          {feed.loading ? <Spinner label="Reading registry" /> : null}
        </div>

        {sdkError ? (
          <ErrorState title="Could not reach Platform" message={sdkError} />
        ) : feed.error ? (
          <ErrorState message={feed.error} onRetry={feed.reload} />
        ) : feed.data && feed.data.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="The registry is quiet"
            body="No repos have been published to this network's registry yet. Forge the first one."
            action={
              <Link href="/new">
                <Button variant="primary">
                  <Plus className="h-4 w-4" aria-hidden /> New repo
                </Button>
              </Link>
            }
          />
        ) : feed.data ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {feed.data.map((r) => (
              <RepoCard key={r.listingId} repo={r} />
            ))}
          </div>
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
