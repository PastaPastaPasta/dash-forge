'use client'

/**
 * Landing + discovery. The hero says what Dash Forge is in plain words, with "Mirror a GitHub
 * repo" first (CJ-2) and the verification chip beside the calls to action (whether this session's
 * Platform connection actually proof-checks reads). Three "why" tiles back the claim, "How it
 * works" explains identities, credits and test DASH with links to the guides (QW-013), the
 * network's showcase repos come first (QW-045), then the recent repos that have a description
 * and a push (CJ-1; the rest behind "Show all recent repos"), a clear empty/error state otherwise.
 */

import Link from 'next/link'
import { BookOpen, Coins, Compass, CopyPlus, ExternalLink, KeyRound, Lock, ShieldCheck, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { FiatNote } from '@/components/ui/fiat-note'
import { creditsAsDash } from '@/lib/view/format'
import { AppShell } from '@/components/app-shell'
import { RepoCard } from '@/components/repo-card'
import { Button } from '@/components/ui/button'
import { VerificationChip } from '@/components/ui/verification-chip'
import { ErrorState, Spinner } from '@/components/ui/states'
import { ForgeIntro } from '@/components/forge-intro'
import { DownloadProgressBar, UnreachableBanner } from '@/components/ui/platform-status'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useQuorumCheck } from '@/hooks/use-quorum-check'
import { deriveConnectionTrust, type DiscoveredRepo } from '@/lib/view'
import { RECENT_PER_OWNER, dropTestFixtures, landingRecent, listShowcaseRepos, recentFeed, showcaseFor } from '@/lib/view/showcase'
import { creditsToDash, typicalIssueCredits } from '@/lib/sdk'
import { PushCostShort } from '@/components/ui/push-cost-text'
import { TestCreditsBadge, isTestNetwork } from '@/components/ui/test-credits'
import { ACTIVE_NETWORK, networkName } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { faucetUrl } from '@/components/top-up-sheet'
import { verifyGuideUrl } from '@/lib/build-info'

export default function LandingPage(): JSX.Element {
  const { sdk, ready, connection, network, status: sdkStatus, retry: retrySdk } = useSdk()
  // Not while Platform is unreachable: a comparison run then only reports that it could not run.
  const quorum = useQuorumCheck(network, connection === 'trusted')
  const proofs = deriveConnectionTrust(network, connection, quorum)
  const deployed = isForgeDeployed()
  // The page, not just its repos: whether its push lookup was complete decides what "pushed" can mean.
  const feedPage = useAsync(
    () => recentFeed(sdk!, { network, limit: 24 }),
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
  const feed = { ...feedPage, data: feedPage.data?.repos ?? null }
  // A page whose push lookup was cut short or refused cannot tell "not pushed" from "not read".
  const pushesKnown = feedPage.data !== null && feedPage.data.pushesComplete && !feedPage.data.fallback
  // Only described, pushed repos unless the visitor asks for all of them (CJ-1), and at most two
  // per owner either way (ABU-V-03): one identity creating repos in bulk must not own the front page.
  const [showAll, setShowAll] = useState(false)
  const settledFeed = featured && showcase.loading ? null : feed.data
  const listed = settledFeed === null ? null : landingRecent(settledFeed, { exclude: shown, pushesKnown, showAll })
  const recent = listed?.shown ?? null
  const hidden = listed?.notCurated ?? 0
  const capped = listed?.capped ?? 0
  // The rows the feed can show at all: the test fixtures never are (landingRecent).
  const realRows = feed.data === null ? null : dropTestFixtures(feed.data)
  const feedNotFeatured = settledFeed === null ? null : dropTestFixtures(settledFeed).filter((r) => !shown.has(r.key))
  const faucet = faucetUrl()
  const testNetwork = isTestNetwork()

  return (
    <AppShell wide>
      {/* Hero */}
      <section className="mx-auto max-w-3xl pb-2 pt-6 text-center sm:pt-10">
        <h1 className="text-3xl leading-tight tracking-tight sm:text-5xl">
          A git forge with <span className="text-forge-700 dark:text-forge-500">no server to trust.</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-prose text-anvil-600 dark:text-anvil-300">
          Git repositories, issues and pull requests on Dash Platform, verified in your browser. Reading and cloning are free.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Link href="/mirror/" data-testid="hero-mirror">
            <Button variant="primary" size="lg">
              <CopyPlus className="h-4 w-4" aria-hidden /> Mirror a GitHub repo
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

      {/* Featured */}
      {deployed && featured && (showcase.data?.length ?? 0) > 0 ? (
        <section className="mt-10" aria-labelledby="featured-repos" data-testid="featured-repos">
          <h2 id="featured-repos" className="mb-3 text-xl">Featured repos</h2>
          <RepoGrid repos={showcase.data ?? []} />
        </section>
      ) : null}

      {/* Discovery */}
      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-3">
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
        ) : realRows && realRows.length === 0 && feedPage.data?.more ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="landing-recent-hidden">
            None of the newest repos are shown on this site.{' '}
            <Link href="/explore/" className="hit-area text-forge-700 underline dark:text-forge-300">
              Explore
            </Link>{' '}
            lists older ones.
          </p>
        ) : realRows && realRows.length === 0 ? (
          <ForgeIntro title="The forge is quiet: be the first project here" testId="landing-intro" />
        ) : feedNotFeatured && feedNotFeatured.length === 0 ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">The newest repos are the featured ones above.</p>
        ) : recent ? (
          <>
            {recent.length === 0 ? (
              <ForgeIntro title="No new projects this week yet" testId="landing-intro" />
            ) : (
              <RepoGrid repos={recent} />
            )}
            {hidden > 0 ? (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setShowAll(true)} data-testid="show-all-recent">
                Show all recent repos ({hidden} more)
              </Button>
            ) : null}
            {capped > 0 ? (
              <p className="mt-3 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="recent-owner-cap">
                At most {RECENT_PER_OWNER} repos per owner are shown here.{' '}
                <Link href="/explore/" className="hit-area underline">
                  Explore lists them all.
                </Link>
              </p>
            ) : null}
          </>
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

      {/* Why & how it works — one concise strip instead of six repeated cards. */}
      <section aria-label="How Dash Forge works" className="mt-12 border-t border-anvil-200 pt-8 dark:border-anvil-800" data-testid="why-tiles">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Feature
            icon={<ShieldCheck className="h-4 w-4 text-forge-500" aria-hidden />}
            title="No server to trust"
            body="Your browser verifies every branch and file against Dash Platform."
            link={{ href: verifyGuideUrl(), label: 'Verify this build' }}
          />
          <Feature
            icon={<Lock className="h-4 w-4 text-forge-500" aria-hidden />}
            title="Private means encrypted"
            body="Private code, issues and comments encrypt on your device."
            link={{ href: '/private/', label: 'What stays visible' }}
          />
          <Feature
            icon={<Coins className="h-4 w-4 text-forge-500" aria-hidden />}
            title="Small fee to write"
            body={
              testNetwork ? (
                <>
                  <TestCreditsBadge className="mr-1" />
                  Reading is free. Writes use free test DASH on {networkName()}.
                </>
              ) : (
                <>Reading is free. An issue costs ~{creditsAsDash(typicalIssueCredits())} DASH<FiatNote dash={creditsToDash(typicalIssueCredits())} network="mainnet" />.</>
              )
            }
            link={faucet ? { href: faucet, label: `${networkName()} faucet` } : { href: DOCS.costs, label: 'What it costs' }}
          />
        </div>
        <details className="mt-4 text-dense text-anvil-600 dark:text-anvil-400" data-testid="how-it-works">
          <summary className="w-fit cursor-pointer font-medium text-anvil-700 hover:text-anvil-900 coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-anvil-300 dark:hover:text-anvil-100">
            How identities, costs and pushing work
          </summary>
          <ol className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Step
              icon={<KeyRound className="h-4 w-4 text-forge-500" aria-hidden />}
              title="1. Get a Dash identity"
              body="A 12-word recovery phrase is your account. Reading needs none."
              link={{ href: DOCS.identity, label: 'Identities and keys' }}
            />
            <Step
              icon={<Coins className="h-4 w-4 text-forge-500" aria-hidden />}
              title="2. Fund writes"
              body={<>Every write shows its fee first: an issue ~{creditsAsDash(typicalIssueCredits())} DASH<FiatNote dash={creditsToDash(typicalIssueCredits())} network="mainnet" />, <PushCostShort network="mainnet" />.</>}
              link={{ href: DOCS.costs, label: 'What it costs' }}
            />
            <Step
              icon={<Upload className="h-4 w-4 text-forge-500" aria-hidden />}
              title="3. Push with git"
              body="Create a repo here or with dg, then git push to a dash:// remote."
              link={{ href: DOCS.quickStart, label: 'Quick start' }}
            />
          </ol>
        </details>
      </section>
    </AppShell>
  )
}

function RepoGrid({ repos }: { repos: readonly DiscoveredRepo[] }): JSX.Element | null {
  if (repos.length === 0) return null
  return (
    <div className="grid grid-cols-1 gap-3 sm:auto-rows-fr sm:grid-cols-2 lg:grid-cols-3">
      {repos.map((r) => (
        <RepoCard key={r.key} repo={r} />
      ))}
    </div>
  )
}

function Step({ icon, title, body, link }: { icon: ReactNode; title: string; body: ReactNode; link: { href: string; label: string } }): JSX.Element {
  return (
    <li className="flex flex-col rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-dense font-semibold">{title}</h3>
      </div>
      <p className="mt-2 flex-1 text-dense text-anvil-600 dark:text-anvil-400">{body}</p>
      <MaybeExternal href={link.href} className="hit-area mt-2 inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-300">
        {link.label}
      </MaybeExternal>
    </li>
  )
}

/** An in-app route (`/…`) as a client-side link; anything else opens in a new tab, marked as such. */
function MaybeExternal({ href, className, children }: { href: string; className: string; children: ReactNode }): JSX.Element {
  if (href.startsWith('/')) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )
}

function Feature({ icon, title, body, link }: { icon: ReactNode; title: string; body: ReactNode; link: { href: string; label: string } }): JSX.Element {
  const linkClass = 'hit-area mt-2 inline-flex items-center gap-1 text-dense text-forge-700 underline dark:text-forge-300'
  return (
    <div className="flex flex-col rounded-lg border border-anvil-200 bg-anvil-50 p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-dense font-semibold">{title}</h3>
      </div>
      <p className="mt-2 flex-1 text-dense text-anvil-600 dark:text-anvil-400">{body}</p>
      <MaybeExternal href={link.href} className={linkClass}>
        {link.label}
      </MaybeExternal>
    </div>
  )
}
