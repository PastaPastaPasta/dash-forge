'use client'

/** `/settings` — account settings: identity, network, running balance/spend, sign out. */

import Link from 'next/link'
import { LogOut, Wallet } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { IdentityPill } from '@/components/ui/identity-pill'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash, dashToUsd } from '@/lib/view/format'

export default function SettingsPage(): JSX.Element {
  const { identity, balance, logout } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  if (!identity) {
    return (
      <AppShell>
        <EmptyState
          icon={Wallet}
          title="Not signed in"
          body="Sign in to see your balance and account settings."
          action={<Button variant="primary" onClick={openLogin}>Sign in</Button>}
        />
      </AppShell>
    )
  }

  const credits = balance ? Number(balance) : 0

  return (
    <AppShell>
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-xl">Account</h1>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Identity</h2>
          <div className="flex items-center justify-between">
            <IdentityPill identityId={identity} />
            <span className="rounded bg-dash/10 px-1.5 py-0.5 font-mono text-[11px] uppercase text-dash">{DEFAULT_NETWORK}</span>
          </div>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Balance</h2>
          <div className="font-mono text-2xl text-dash">{balanceToDash(balance ?? '0')} DASH</div>
          <div className="mt-1 font-mono text-dense text-anvil-400">
            {credits.toLocaleString()} credits · ≈ {dashToUsd(creditsToDash(credits))}
          </div>
          <a href="https://bridge.thepasta.org" target="_blank" rel="noreferrer noopener" className="mt-3 inline-block text-dense text-forge-600 underline dark:text-forge-400">
            Top up at the bridge →
          </a>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-dense font-medium">Sign out</div>
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Wipes your signing key from the browser keystore on this device.</p>
            </div>
            <Button variant="danger" onClick={logout}>
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
            </Button>
          </div>
        </section>

        <p className="text-center text-[12px] text-anvil-400">
          <Link href="/" className="hover:underline">Back to discovery</Link>
        </p>
      </div>
    </AppShell>
  )
}
