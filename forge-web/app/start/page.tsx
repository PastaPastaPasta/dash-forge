'use client'

/**
 * `/start` — Getting started (QA wave bonsia, QW-013): what Dash Forge is, and the three things a
 * GitHub user has not met before (an identity instead of an account, credits that pay for writes,
 * and, on a devnet, free test DASH), then where to go next. The long form is in the user guides,
 * linked at the end; the figures come from the same cost model the app quotes.
 */

import Link from 'next/link'
import { BookOpen, Compass, Coins, ExternalLink, KeyRound, Terminal, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { Button } from '@/components/ui/button'
import { faucetUrl } from '@/components/top-up-sheet'
import { useAuth } from '@/contexts/auth-context'
import { BROWSER_KEY_DEFAULTS } from '@/lib/auth'
import { ACTIVE_NETWORK, networkName } from '@/lib/constants'
import { DOCS } from '@/lib/docs-links'
import { pushCostPhrase, typicalIssueCredits } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
      <h2 className="flex items-center gap-2 text-prose font-semibold">
        {icon}
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-dense text-anvil-700 dark:text-anvil-300">{children}</div>
    </section>
  )
}

function Guide({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="hit-area inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400">
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )
}

export default function GettingStartedPage(): JSX.Element {
  const { identity } = useAuth()
  const faucet = faucetUrl()
  const devnet = ACTIVE_NETWORK.network === 'devnet'
  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-4" data-testid="getting-started">
        <div>
          <h1 className="text-2xl">Getting started</h1>
          <p className="mt-2 text-prose text-anvil-600 dark:text-anvil-300">
            Dash Forge hosts git repositories, issues, pull requests and releases, much like GitHub, but with no company server. Everything
            lives on Dash Platform and in storage the owner chooses. Your browser verifies what it shows.
          </p>
        </div>

        <Section icon={<UserRound className="h-4 w-4 text-fg-muted" aria-hidden />} title="Your identity is your account">
          <p>
            Instead of a username and password, you have a <strong>Dash Platform identity</strong> made from a <strong>12-word recovery phrase</strong>.
            Keep it offline. Nobody can reset it for you. You can add a username later.
          </p>
          <p>
            Make one in the browser (<strong>Sign in → Create a new identity</strong>) or in a terminal with <code className="font-mono">dg auth new</code>. Browsing and cloning need no identity at all.
          </p>
        </Section>

        <Section icon={<Coins className="h-4 w-4 text-fg-muted" aria-hidden />} title="Writes cost a little; reading is free">
          <p>
            Every write (a repo, an issue, a comment, a push) is stored on Dash Platform for a small fee from your identity&apos;s{' '}
            <strong>balance</strong>: about {creditsAsDash(typicalIssueCredits())} DASH for an issue, and {pushCostPhrase()}. You see the
            price before you confirm.
          </p>
          <p>You add credits by sending DASH to your identity: a new identity is funded when it is made, and Settings → Top up adds more later.</p>
          {devnet ? (
            <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-caution-800 dark:text-caution-300" data-testid="start-devnet">
              This site runs on <strong>{networkName()}</strong>, a test network. Its DASH is free test money with no value
              {faucet ? (
                <>
                  , from the <Guide href={faucet}>faucet</Guide>
                </>
              ) : null}
              , and the network can be reset.
            </p>
          ) : null}
        </Section>

        <Section icon={<KeyRound className="h-4 w-4 text-fg-muted" aria-hidden />} title="Signing in gives this browser a limited key">
          <p>
            Your master key is used once, to give this browser a key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on
            Forge, for {BROWSER_KEY_DEFAULTS.days} days. A passkey or passphrase protects it. The master key and recovery phrase are never stored.
          </p>
        </Section>

        <Section icon={<Terminal className="h-4 w-4 text-fg-muted" aria-hidden />} title="From the terminal">
          <p>
            <code className="font-mono">dg</code> is the command-line tool (shaped like GitHub&apos;s <code className="font-mono">gh</code>), and plain{' '}
            <code className="font-mono">git push</code> works against <code className="font-mono">dash://</code> remotes. The{' '}
            <Guide href={DOCS.quickStart}>quick start</Guide> goes from nothing to a pushed repository in about 15 minutes.
          </p>
        </Section>

        <Section icon={<BookOpen className="h-4 w-4 text-fg-muted" aria-hidden />} title="Guides">
          {/* Touch: rows 44 px apart, so each guide's 44 px hit area does not overlap the next (QW2-068). */}
          <ul className="list-disc space-y-1 pl-5 coarse:space-y-6">
            <li>
              <Guide href={DOCS.quickStart}>Quick start</Guide>
            </li>
            <li>
              <Guide href={DOCS.identity}>Identity and keys</Guide>: backups, recovery and keeping keys safe
            </li>
            <li>
              <Guide href={DOCS.costs}>What things cost</Guide>, measured
            </li>
            <li>
              <Guide href={DOCS.movingFromGithub}>Moving from GitHub or GitLab</Guide>
            </li>
            {/* Its own row: two links on one wrapped line would overlap their hit areas. */}
            <li>
              <Guide href={DOCS.mirror}>Mirror a GitHub repository</Guide>
            </li>
            <li>
              <Guide href={DOCS.storage}>Bring your own storage</Guide>
            </li>
            <li>
              <Link href="/private/" className="hit-area text-forge-700 underline dark:text-forge-400">
                Private repositories
              </Link>
              : what is encrypted and what stays visible
            </li>
            <li>
              <Guide href={DOCS.guides}>All guides</Guide>
            </li>
          </ul>
        </Section>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          {identity ? null : <SignInButton />}
          <Link href="/explore/">
            <Button variant="outline">
              <Compass className="h-4 w-4" aria-hidden /> Explore repositories
            </Button>
          </Link>
        </div>
      </div>
    </AppShell>
  )
}
