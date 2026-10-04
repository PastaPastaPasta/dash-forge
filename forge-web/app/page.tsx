'use client'

/**
 * Landing + discovery. The hero says what Dash Forge is in plain words, the verification chip
 * sits under it (whether this session's Platform connection actually proof-checks reads), "How
 * it works" explains identities, credits and test DASH with links to the guides (QW-013), the
 * network's showcase repos come first (QW-045), then the recent repos from the active network's
 * forge-core when the SDK connects, a clear empty/error state otherwise.
 */

import Link from 'next/link'
import { BookOpen, Coins, Compass, ExternalLink, GitBranch, KeyRound, Lock, Plus, Search, Upload } from 'lucide-react'
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
import { listShowcaseRepos, showcaseFor } from '@/lib/view/showcase'
import { ACTIVE_NETWORK, networkName } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { faucetUrl } from '@/components/top-up-sheet'

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
  const featured = showcaseFor(ACTIVE_NETWORK.key).length > 0
  const showcase = useAsync(
    () => listShowcaseRepos(sdk!, network, ACTIVE_NETWORK.key),
    [ready, network],
    { enabled: deployed && featured && ready && sdk !== null },
  )
  // The recent feed without the featured repos (they are shown above it), once the featured read
  // has settled, so a featured card never shows in the feed and then leaves it.
  const shown = new Set((showcase.data ?? []).map((r) => r.key))
  const recent = featured && showcase.loading ? null : (feed.data?.filter((r) => !shown.has(r.key)) ?? null)
  const faucet = faucetUrl()

  return (
    <AppShell wide>
      {/* Hero */}
      <section className="mx-auto max-w-3xl pb-4 pt-8 text-center sm:pt-14">
        <h1 className="text-3xl leading-tight tracking-tight sm:text-5xl">
          A git forge with <span className="text-forge-700 dark:text-forge-500">no server to trust.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-prose text-anvil-600 dark:text-anvil-300">
          Git repositories, issues, pull requests and reviews, like GitHub, with no server. Everything lives on
          the Dash network, and your browser verifies what it shows. No host can take it down.
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
          <Link href="/start/" data-testid="hero-getting-started">
            <Button variant="ghost" size="lg">
              <BookOpen className="h-4 w-4" aria-hidden /> Getting started
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
        <Feature icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />} title="Verified, not trusted" body="Your browser checks every branch and file it shows. Each repo's Verification card shows what was checked." />
        <Feature icon={<GitBranch className="h-4 w-4 text-forge-500" aria-hidden />} title="Issues & threads in-browser" body="Open issues, comment, close and reopen, and grant collaborators — each write signed by your Platform identity." />
      </section>

      {/* How it works (QW-013): what an identity and credits are, before anyone is asked to sign in. */}
      <section aria-labelledby="how-it-works" className="mx-auto mt-10 max-w-4xl" data-testid="how-it-works">
        <h2 id="how-it-works" className="mb-3 text-xl">How it works</h2>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Step
            icon={<KeyRound className="h-4 w-4 text-forge-500" aria-hidden />}
            title="1. Get a Dash identity"
            body="Your identity is your account, made from a 12-word recovery phrase only you hold. Reading and cloning need no identity."
            link={{ href: DOCS.identity, label: 'Identities and keys' }}
          />
          <Step
            icon={<Coins className="h-4 w-4 text-forge-500" aria-hidden />}
            title="2. Fund it with a little DASH"
            body={
              ACTIVE_NETWORK.network === 'mainnet'
                ? 'Writes (a repo, an issue, a push) cost a small fee in DASH, paid from your identity’s credits and shown before you sign. Reading is free.'
                : `Writes (a repo, an issue, a push) cost a small fee, shown before you sign. On ${networkName()} the DASH is free test money${faucet ? ', from the faucet' : ''}. Reading is free.`
            }
            link={faucet ? { href: faucet, label: `${networkName()} faucet` } : { href: DOCS.costs, label: 'What it costs' }}
          />
          <Step
            icon={<Upload className="h-4 w-4 text-forge-500" aria-hidden />}
            title="3. Push with git"
            body="Create a repo here or with the dg command line, then git push to a dash:// remote. Your code goes to your own storage or to Dash Platform."
            link={{ href: DOCS.quickStart, label: 'Quick start' }}
          />
        </ol>
        <p className="mt-3 text-dense text-anvil-600 dark:text-anvil-400">
          <Link href="/start/" className="hit-area text-forge-700 underline dark:text-forge-300">
            Getting started
          </Link>
          {' · '}
          <a href={DOCS.guides} target="_blank" rel="noreferrer noopener" className="hit-area text-forge-700 underline dark:text-forge-300">
            All user guides
          </a>
          {' · '}
          <a href={DOCS.movingFromGithub} target="_blank" rel="noreferrer noopener" className="hit-area text-forge-700 underline dark:text-forge-300">
            Moving from GitHub
          </a>
        </p>
      </section>

      {/* Featured (QW-045): the network's showcase repos, before the newest ones. */}
      {deployed && featured && (showcase.data?.length ?? 0) > 0 ? (
        <section className="mt-14" aria-labelledby="featured-repos" data-testid="featured-repos">
          <h2 id="featured-repos" className="mb-4 text-xl">Featured repos</h2>
          <RepoGrid repos={showcase.data ?? []} />
        </section>
      ) : null}

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
        ) : recent && recent.length === 0 ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">The newest repos are the featured ones above.</p>
        ) : recent ? (
          <RepoGrid repos={recent} />
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

function Step({ icon, title, body, link }: { icon: ReactNode; title: string; body: string; link: { href: string; label: string } }): JSX.Element {
  return (
    <li className="flex flex-col rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-dense font-semibold">{title}</h3>
      </div>
      <p className="mt-2 flex-1 text-dense text-anvil-600 dark:text-anvil-400">{body}</p>
      <a href={link.href} target="_blank" rel="noreferrer noopener" className="hit-area mt-2 inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-300">
        {link.label} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </li>
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
