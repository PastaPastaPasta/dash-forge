'use client'

/** `/settings/storage` — bring your own storage (`ux-dx-spec.md` §3.1). */

import Link from 'next/link'
import { HardDrive, MonitorSmartphone } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { SignInButton } from '@/components/sign-in-button'
import { EmptyState } from '@/components/ui/states'
import { StorageWizard } from '@/components/storage/storage-wizard'
import { useAuth } from '@/contexts/auth-context'
import { dashRange, PUSH_COST_DASH } from '@/lib/sdk/cost'

export default function StorageSettingsPage(): JSX.Element {
  const { identity } = useAuth()

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            <Link href="/settings/" className="hit-area hover:underline">Settings</Link> / Storage
          </p>
          <h1 className="mt-1 text-xl">Storage</h1>
          <p className="mt-1 max-w-2xl text-dense text-anvil-600 dark:text-anvil-300">
            We host nothing. Your git data goes to a bucket or IPFS node you own, and Platform records where it is. A push costs about {dashRange(PUSH_COST_DASH.byo)} DASH, or {dashRange(PUSH_COST_DASH.platform)} with everything on Platform. Readers verify every file.
          </p>
        </div>
        <p className="flex items-center gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-[12px] text-anvil-600 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-300 md:hidden">
          <MonitorSmartphone className="h-4 w-4 shrink-0" aria-hidden /> Use a desktop browser for this step: it needs a few long fields and a copy-paste from your provider’s console.
        </p>
        {identity ? (
          <StorageWizard />
        ) : (
          <EmptyState
            icon={HardDrive}
            title="Sign in to set up storage"
            body="Storage credentials are kept encrypted with this browser’s key, so they need a signed-in session."
            action={<SignInButton />}
          />
        )}
      </div>
    </AppShell>
  )
}
