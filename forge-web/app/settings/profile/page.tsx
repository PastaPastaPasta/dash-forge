'use client'

/** `/settings/profile` — your public profile (P1-7): name, bio, avatar, company, location, links. */

import Link from 'next/link'
import { Lock, UserRound, Wallet } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { ProfilePublicNote, ProfileSettings } from '@/components/profile-settings'
import { SignInButton } from '@/components/sign-in-button'
import { EmptyState } from '@/components/ui/states'
import { NotDeployedState, isForgeDeployed } from '@/components/ui/network-badge'
import { useAuth } from '@/contexts/auth-context'

export default function ProfileSettingsPage(): JSX.Element {
  const { identity, locked } = useAuth()
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            <Link href="/settings/" className="hit-area hover:underline">Settings</Link> / Profile
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-xl">
            <UserRound className="h-5 w-5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            Public profile
          </h1>
        </div>
        {!isForgeDeployed() ? (
          <NotDeployedState />
        ) : identity ? (
          <ProfileSettings />
        ) : (
          <>
            <EmptyState
              icon={locked ? Lock : Wallet}
              title={locked ? 'Session locked' : 'Sign in to edit your profile'}
              body="Your profile is a document your identity signs: sign in to write it."
              action={<SignInButton />}
            />
            <ProfilePublicNote />
          </>
        )}
      </div>
    </AppShell>
  )
}
