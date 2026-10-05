'use client'

/** `/settings/keys` — Devices & keys (TS-07): every key of your identity; disable a lost device's. */

import Link from 'next/link'
import { KeySquare, Lock, Wallet } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { DevicesKeys } from '@/components/devices-keys'
import { SignInButton } from '@/components/sign-in-button'
import { EmptyState } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'

export default function DevicesKeysPage(): JSX.Element {
  const { identity, locked } = useAuth()
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            <Link href="/settings/" className="hit-area hover:underline">
              Settings
            </Link>{' '}
            / Devices &amp; keys
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-xl">
            <KeySquare className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            Devices &amp; keys
          </h1>
          <p className="mt-1 text-dense text-anvil-600 dark:text-anvil-300">
            Every key on your identity, as the network has it. Each browser, computer and CI runner you sign in from adds one. Lost a device? Disable
            its key here.
          </p>
        </div>
        {!isForgeDeployed() ? (
          <NotDeployedState />
        ) : identity ? (
          <DevicesKeys />
        ) : (
          <EmptyState
            icon={locked ? Lock : Wallet}
            title={locked ? 'Session locked' : 'Sign in to see your keys'}
            body="Your keys are read from your identity on the network."
            action={<SignInButton />}
          />
        )}
      </div>
    </AppShell>
  )
}
