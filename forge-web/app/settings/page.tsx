'use client'

/**
 * `/settings` — account settings: identity, network, balance, the local spend ledger, sign out.
 * Appearance and the IPFS gateways are this browser's own, so they show signed out too.
 */

import Link from 'next/link'
import { ChevronRight, Lock, Wallet } from 'lucide-react'
import { PricesPanel } from '@/components/prices-panel'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { IdentityPill } from '@/components/ui/identity-pill'
import { Oid } from '@/components/ui/oid'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useDpnsLookup } from '@/hooks/use-dpns-name'
import { UsernameHint } from '@/components/username-hint'
import { NetworkBadge } from '@/components/ui/network-badge'
import { SpendPanel } from '@/components/spend-panel'
import { KeysPanel } from '@/components/keys-panel'
import { EncryptionKeyPanel } from '@/components/encryption-key-panel'
import { SecurityPanel } from '@/components/security-panel'
import { GatewaysField } from '@/components/gateways-field'
import { QuorumServiceField } from '@/components/quorum-service-field'
import { DisplayPrefsPanel } from '@/components/display-prefs-panel'
import { AppearancePanel } from '@/components/appearance-panel'
import { TrendingPrefPanel } from '@/components/trending-pref-panel'
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash } from '@/lib/view/format'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { NOTIFY_URL } from '@/lib/notify/config'
import { FiatNote } from '@/components/ui/fiat-note'

export default function SettingsPage(): JSX.Element {
  const { identity, balance, locked } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const username = useDpnsLookup(identity ?? '')

  const appearance = (
    <section aria-labelledby="appearance-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="appearance-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Appearance
      </h2>
      <AppearancePanel />
    </section>
  )

  const prices = (
    <section aria-labelledby="prices-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="prices-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Prices</h2>
      <PricesPanel />
    </section>
  )

  const advanced = (
    <details className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <summary className="cursor-pointer text-dense font-medium text-anvil-600 coarse:flex coarse:min-h-11 coarse:items-center dark:text-anvil-300">
        Advanced network settings (IPFS gateways &amp; quorum service)
      </summary>
      <div className="mt-4 space-y-5 border-t border-anvil-100 pt-4 dark:border-anvil-850">
        <section aria-labelledby="gateways-title">
          <h2 id="gateways-title" className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">
            Your IPFS gateways
          </h2>
          <GatewaysField />
        </section>
        <section aria-labelledby="quorum-service-title" className="border-t border-anvil-100 pt-4 dark:border-anvil-850">
          <h2 id="quorum-service-title" className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">
            Quorum service
          </h2>
          <QuorumServiceField />
        </section>
      </div>
    </details>
  )

  if (!identity) {
    return (
      <AppShell>
        <div className="mx-auto max-w-xl space-y-5">
          <EmptyState
            heading="h1"
            icon={locked ? Lock : Wallet}
            title={locked ? 'Session locked' : 'Sign in to see your settings'}
            body={
              locked
                ? 'Unlock this browser’s session to manage your account.'
                : 'Sign in to view your balance, spend history and account settings.'
            }
            action={<SignInButton />}
          />
          {appearance}
          {prices}
          {advanced}
        </div>
      </AppShell>
    )
  }

  const credits = balance ? Number(balance) : 0

  return (
    <AppShell>
      <div className="mx-auto max-w-xl space-y-5">
        <h1 className="text-xl">Settings</h1>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <IdentityPill identityId={identity} name={username ?? undefined} />
            <NetworkBadge always />
          </div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <div>
              <div className="text-[12px] text-anvil-500 dark:text-anvil-400">Balance</div>
              <div className="font-mono text-2xl text-dash-600 dark:text-dash-400">
                {balanceToDash(balance ?? '0')} DASH<FiatNote dash={creditsToDash(credits)} balance />
              </div>
              <div className="font-mono text-[12px] text-anvil-500 dark:text-anvil-400">
                {credits.toLocaleString()} credits{ACTIVE_NETWORK.network !== 'mainnet' ? ' · test DASH' : null}
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => openTopUp()}>
              Top up
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <span className="text-dense text-anvil-500 dark:text-anvil-400">Identity ID</span>
            <span data-testid="settings-identity" data-identity={identity}><Oid value={identity} label="identity id" /></span>
          </div>
          <UsernameHint show={username === null} className="mt-3 border-t border-anvil-100 pt-3 dark:border-anvil-850" />
        </section>

        <nav aria-label="Account sections" className="divide-y divide-anvil-200 overflow-hidden rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800">
          <Link href="/settings/profile/" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900" data-testid="settings-profile-link">
            <div>
              <div className="text-dense font-medium">Public profile</div>
              <div className="text-[12px] text-anvil-500 dark:text-anvil-400">Name, bio, avatar, links and signing keys</div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
          </Link>
          <Link href="/settings/storage/" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900">
            <div>
              <div className="text-dense font-medium">Storage</div>
              <div className="text-[12px] text-anvil-500 dark:text-anvil-400">Buckets and IPFS nodes for browser pushes</div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
          </Link>
          <Link href="/settings/notifications/" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900" data-testid="settings-notifications-link">
            <div>
              <div className="text-dense font-medium">Notifications</div>
              <div className="text-[12px] text-anvil-500 dark:text-anvil-400">
                {NOTIFY_URL ? 'Browser inbox, email and push' : 'Browser inbox'}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
          </Link>
        </nav>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Spend</h2>
          <SpendPanel />
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">This browser&apos;s key</h2>
          <KeysPanel />
        </section>

        <SecurityPanel />

        <EncryptionKeyPanel />

        {appearance}

        {prices}

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Commit identity</h2>
          <DisplayPrefsPanel />
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Stars</h2>
          <TrendingPrefPanel />
        </section>

        {advanced}
      </div>
    </AppShell>
  )
}
