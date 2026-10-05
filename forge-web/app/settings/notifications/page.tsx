'use client'

/**
 * `/settings/notifications` — where notifications come from: the inbox this browser builds from
 * the chain, and, when the build names one (`NEXT_PUBLIC_NOTIFY_URL`), an optional email and push
 * service (`components/notify-panel.tsx`).
 */

import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { NotifyPanel } from '@/components/notify-panel'
import { NOTIFY_URL } from '@/lib/notify/config'

export default function NotificationSettingsPage(): JSX.Element {
  return (
    <AppShell>
      <div className="mx-auto max-w-xl space-y-6">
        <div>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            <Link href="/settings/" className="hit-area hover:underline">Settings</Link> / Notifications
          </p>
          <h1 className="mt-1 text-xl">Notifications</h1>
        </div>

        <section className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
          <h2 className="mb-2 text-dense font-medium text-anvil-500 dark:text-anvil-400">In this browser</h2>
          <p className="text-dense text-anvil-600 dark:text-anvil-300">
            The inbox reads the chain from this browser while Forge is open: review requests, assignments, mentions and activity in the repos you
            watch. No server is involved.
          </p>
          <Link href="/notifications/" className="hit-area mt-2 inline-block text-dense text-forge-700 underline dark:text-forge-400">
            Open the inbox →
          </Link>
        </section>

        {NOTIFY_URL ? (
          <section aria-labelledby="notify-title" className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800" data-testid="notify-section">
            <h2 id="notify-title" className="mb-3 text-dense font-medium text-anvil-500 dark:text-anvil-400">
              Email and push
            </h2>
            <NotifyPanel />
          </section>
        ) : null}
      </div>
    </AppShell>
  )
}
