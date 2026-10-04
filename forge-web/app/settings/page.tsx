'use client'

/**
 * `/settings` — account settings: identity, network, balance, the local spend ledger, sign out.
 * Appearance and the IPFS gateways are this browser's own, so they show signed out too.
 */

import Link from 'next/link'
import { Lock, Wallet } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
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
import { DisplayPrefsPanel } from '@/components/display-prefs-panel'
import { AppearancePanel } from '@/components/appearance-panel'
import { TrendingPrefPanel } from '@/components/trending-pref-panel'
import { creditsToDash } from '@/lib/sdk'
import { balanceToDash, dashValueNote } from '@/lib/view/format'
import { ACTIVE_NETWORK } from '@/lib/constants'

export default function SettingsPage(): JSX.Element {
  const { identity, balance, locked } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  // Known to have no DPNS name: say how to get one (QW3-035).
  const username = useDpnsLookup(identity ?? '')

  const gateways = (
    <section aria-labelledby="gateways-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="gateways-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Your IPFS gateways
      </h2>
      <GatewaysField />
    </section>
  )

  const appearance = (
    <section aria-labelledby="appearance-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
      <h2 id="appearance-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
        Appearance
      </h2>
      <AppearancePanel />
    </section>
  )

  if (!identity) {
    return (
      <AppShell>
        <div className="mx-auto max-w-xl space-y-6">
          <EmptyState
            heading="h1"
            icon={locked ? Lock : Wallet}
            title={locked ? 'Session locked' : 'Sign in to see your settings'}
            body={
              locked
                ? 'Your key is still in this browser. Unlock it to see your balance, spend and account settings.'
                : 'Your balance, spend history and account settings show here once you sign in.'
            }
            action={<SignInButton />}
          />
          {appearance}
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
            <span data-testid="settings-identity" data-identity={identity}><Oid value={identity} label="identity id" /></span>
          </div>
          {username === null ? <UsernameHint className="mt-3 border-t border-anvil-100 pt-3 dark:border-anvil-850" /> : null}
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">Public profile</h2>
          <p className="text-dense text-anvil-600 dark:text-anvil-300">
            Your name, bio, avatar, company, location and links, shown on your profile page. Public, even beside your private repos.
          </p>
          <Link href="/settings/profile/" className="hit-area mt-2 inline-block text-dense text-forge-700 underline dark:text-forge-400" data-testid="settings-profile-link">
            Edit your profile →
          </Link>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Balance</h2>
          <div className="font-mono text-2xl text-dash-600 dark:text-dash-400">{balanceToDash(balance ?? '0')} DASH</div>
          <div className="mt-1 font-mono text-dense text-anvil-500 dark:text-anvil-400">
            {credits.toLocaleString()} credits · {dashValueNote(creditsToDash(credits), ACTIVE_NETWORK.network)}
          </div>
          <button type="button" onClick={() => openTopUp()} className="hit-area mt-3 inline-block text-dense text-forge-700 underline dark:text-forge-400">
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
          <Link href="/settings/storage/" className="hit-area mt-2 inline-block text-dense text-forge-700 underline dark:text-forge-400">
            Storage settings →
          </Link>
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Commit identity</h2>
          <DisplayPrefsPanel />
        </section>

        {appearance}

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">Stars</h2>
          <TrendingPrefPanel />
        </section>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">This browser&apos;s key</h2>
          <KeysPanel />
        </section>

        <SecurityPanel />

        <EncryptionKeyPanel />

        {gateways}

        <p className="text-center text-[12px] text-anvil-500 dark:text-anvil-400">
          <Link href="/" className="hit-area hover:underline">Back to discovery</Link>
        </p>
      </div>
    </AppShell>
  )
}
