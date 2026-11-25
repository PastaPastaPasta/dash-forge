'use client'

import Link from 'next/link'
import { Compass, CopyPlus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { creditsToDash } from '@/lib/sdk/cost'
import { PushCostText, PushStorageHint } from '@/components/ui/push-cost-text'
import { FiatNote } from '@/components/ui/fiat-note'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { Button } from '@/components/ui/button'
import { TestNetworkNote } from '@/components/test-network-note'
import { useAuth } from '@/contexts/auth-context'
import { BROWSER_KEY_DEFAULTS } from '@/lib/auth'
import { DOCS } from '@/lib/docs-links'
import { typicalIssueCredits } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

function Guide({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <Link href={href} className="hit-area text-dense text-forge-700 underline coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-forge-400">
      {children}
    </Link>
  )
}

export default function GettingStartedPage(): JSX.Element {
  const { identity } = useAuth()
  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6" data-testid="getting-started">
        <div>
          <h1 className="text-2xl">Getting started</h1>
          <p className="mt-1.5 text-prose text-anvil-600 dark:text-anvil-300">
            Git repositories, issues and pull requests on Dash Platform, verified in your browser. Reading and cloning are free.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {identity ? (
              <Link href="/new/">
                <Button variant="primary">
                  <Plus className="h-4 w-4" aria-hidden /> Create a repository
                </Button>
              </Link>
            ) : (
              <SignInButton />
            )}
            <Link href="/mirror/">
              <Button variant="outline">
                <CopyPlus className="h-4 w-4" aria-hidden /> Mirror a GitHub repo
              </Button>
            </Link>
            <Link href="/explore/">
              <Button variant="ghost">
                <Compass className="h-4 w-4" aria-hidden /> Explore
              </Button>
            </Link>
          </div>
        </div>

        <ol className="space-y-4 border-t border-anvil-200 pt-5 dark:border-anvil-800">
          <li className="space-y-1">
            <h2 className="text-prose font-semibold">1. Create or connect a Dash identity</h2>
            <p className="text-dense text-anvil-600 dark:text-anvil-300">
              Your Dash Platform identity is your account. Create it in a Dash wallet app, or in the browser from a 12-word recovery phrase. Keep the phrase offline: nobody can reset it for you. Browsing needs no identity.
            </p>
          </li>

          <li className="space-y-1.5">
            <h2 className="text-prose font-semibold">2. Fund writes with a little DASH</h2>
            <p className="text-dense text-anvil-600 dark:text-anvil-300">
              Writes cost a small fee shown before you confirm — about {creditsAsDash(typicalIssueCredits())} DASH for an issue<FiatNote dash={creditsToDash(typicalIssueCredits())} />. Reading is free.
            </p>
            <TestNetworkNote />
            <details className="text-dense text-anvil-600 dark:text-anvil-300">
              <summary className="w-fit cursor-pointer font-medium text-anvil-700 hover:text-anvil-900 coarse:inline-flex coarse:min-h-11 coarse:items-center dark:text-anvil-300 dark:hover:text-anvil-100">
                Push costs &amp; storage
              </summary>
              <div className="mt-2 space-y-2 rounded-md border border-anvil-200 bg-anvil-50 p-3 dark:border-anvil-800 dark:bg-anvil-900">
                <p><PushCostText />.</p>
                <p data-testid="start-push-storage"><PushStorageHint /></p>
                <p>Add credits in Settings → Top up, or read <Guide href={DOCS.costs}>what things cost</Guide>.</p>
              </div>
            </details>
          </li>

          <li className="space-y-1">
            <h2 className="text-prose font-semibold">3. Push with git or mirror from GitHub</h2>
            <p className="text-dense text-anvil-600 dark:text-anvil-300">
              Push with <code className="font-mono">dg</code> and <code className="font-mono">git push</code> to a <code className="font-mono">dash://</code> remote, or mirror a GitHub repo in the browser. See the <Guide href={DOCS.quickStart}>quick start</Guide>.
            </p>
          </li>
        </ol>

        <details className="rounded-lg border border-anvil-200 px-4 py-3 text-dense text-anvil-600 dark:border-anvil-800 dark:text-anvil-300">
          <summary className="cursor-pointer font-medium text-anvil-800 coarse:flex coarse:min-h-11 coarse:items-center dark:text-anvil-100">
            How browser sign-in stays safe
          </summary>
          <p className="mt-2">
            Signing in gives this browser a limited key that can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH<FiatNote dash={BROWSER_KEY_DEFAULTS.budgetDash} kind="bound" />, only on Forge, for {BROWSER_KEY_DEFAULTS.days} days by default. A passkey or passphrase can lock it; your master key and recovery phrase are never stored.
          </p>
        </details>

        <section aria-labelledby="start-guides" className="border-t border-anvil-200 pt-5 dark:border-anvil-800">
          <h2 id="start-guides" className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">Guides</h2>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <li><Guide href={DOCS.quickStart}>Quick start</Guide></li>
            <li><Guide href={DOCS.identity}>Identity and keys</Guide></li>
            <li><Guide href={DOCS.costs}>What things cost</Guide></li>
            <li><Guide href={DOCS.movingFromGithub}>Moving from GitHub or GitLab</Guide></li>
            <li><Guide href={DOCS.mirror}>Mirror a GitHub repository</Guide></li>
            <li><Guide href={DOCS.storage}>Bring your own storage</Guide></li>
            <li><Guide href="/private/">Private repositories</Guide></li>
            <li><Guide href={DOCS.guides}>All guides</Guide></li>
          </ul>
        </section>
      </div>
    </AppShell>
  )
}
