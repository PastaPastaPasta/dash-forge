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
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash, dashToUsd } from '@/lib/view/format'

export default function SettingsPage(): JSX.Element {
  const { identity, balance } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const openTopUp = useUiStore((s) => s.openTopUp)

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
            <NetworkBadge always />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <span className="text-dense text-anvil-500 dark:text-anvil-400">Identity ID</span>
            <Oid value={identity} chars={12} label="identity id" />
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
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">This browser&apos;s key</h2>
          <KeysPanel />
        </section>

        <p className="text-center text-[12px] text-anvil-400">
          <Link href="/" className="hover:underline">Back to discovery</Link>
        </p>
      </div>
    </AppShell>
  )
}
