'use client'

/** `/settings` — account settings: identity, network, balance, the local spend ledger, sign out. */

import Link from 'next/link'
import { Wallet } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { IdentityPill } from '@/components/ui/identity-pill'
import { Oid } from '@/components/ui/oid'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { NetworkBadge } from '@/components/ui/network-badge'
import { SpendPanel } from '@/components/spend-panel'
import { KeysPanel } from '@/components/keys-panel'
import { GatewaysField } from '@/components/gateways-field'
import { DisplayPrefsPanel } from '@/components/display-prefs-panel'
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash, dashToUsd } from '@/lib/view/format'

export default function SettingsPage(): JSX.Element {
  const { identity, balance } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const openTopUp = useUiStore((s) => s.openTopUp)

  const gateways = (
    <section aria-labelledby="gateways-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="gateways-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Your IPFS gateways
      </h2>
      <GatewaysField />
    </section>
  )

  if (!identity) {
    return (
      <AppShell>
        <div className="mx-auto max-w-xl space-y-6">
          <EmptyState
            icon={Wallet}
            title="Not signed in"
            body="Sign in to see your balance and account settings."
            action={<Button variant="primary" onClick={() => openLogin()}>Sign in</Button>}
          />
          {gateways}
        </div>
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
            <NetworkBadge always />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <span className="text-dense text-anvil-500 dark:text-anvil-400">Identity ID</span>
            <span data-testid="settings-identity" data-identity={identity}><Oid value={identity} chars={12} label="identity id" /></span>
          </div>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Balance</h2>
          <div className="font-mono text-2xl text-dash-600 dark:text-dash-400">{balanceToDash(balance ?? '0')} DASH</div>
          <div className="mt-1 font-mono text-dense text-anvil-400">
            {credits.toLocaleString()} credits · ≈ {dashToUsd(creditsToDash(credits))}
          </div>
          <button type="button" onClick={() => openTopUp()} className="mt-3 inline-block text-dense text-forge-600 underline dark:text-forge-400">
            Top up →
          </button>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Spend</h2>
          <SpendPanel />
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">Storage</h2>
          <p className="text-dense text-anvil-600 dark:text-anvil-300">
            Your buckets and IPFS nodes for browser pushes, tested from this page, with their keys encrypted in this browser.
          </p>
          <Link href="/settings/storage" className="mt-2 inline-block text-dense text-forge-700 underline dark:text-forge-400">
            Storage settings →
          </Link>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Diffs</h2>
          <DisplayPrefsPanel />
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">This browser&apos;s key</h2>
          <KeysPanel />
        </section>

        {gateways}

        <p className="text-center text-[12px] text-anvil-400">
          <Link href="/" className="hover:underline">Back to discovery</Link>
        </p>
      </div>
    </AppShell>
  )
}
