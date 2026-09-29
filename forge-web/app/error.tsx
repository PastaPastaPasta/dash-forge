'use client'

/**
 * The app's error boundary (L-56). Its common cause is a page whose code could not be fetched,
 * because the connection dropped before the tab loaded that page's chunk: without this, Next
 * shows a blank "Application error". A connection failure gets the plain offline state and
 * reloads once the connection is back; anything else says what failed, with Try again.
 *
 * Automatic reloads are capped (`lib/auto-reload.ts`): a page that fails the same way after
 * every reload must not loop.
 */

import { useEffect } from 'react'
import { AlertTriangle, WifiOff } from 'lucide-react'
import { isUnreachableError } from '@/lib/sdk/unreachable'
import { errorMessage } from '@/lib/utils'
import { isOffline } from '@/lib/online'
import { scheduleReconnect } from '@/lib/view/reconnect'
import { autoReload, isLoadFailure } from '@/lib/auto-reload'
import { ErrorDetails, RetryButton } from '@/components/ui/states'

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): JSX.Element {
  const chunk = isLoadFailure(error)
  const connection = chunk || isUnreachableError(error) || isOffline()
  useEffect(() => {
    if (!connection) return
    // Online, a chunk that failed to load is fetched again by a reload (backed off). Otherwise
    // wait for the browser to come back online (scheduleReconnect does that while offline).
    if (!chunk && !isOffline()) return
    return scheduleReconnect(autoReload)
  }, [connection, chunk])

  const Icon = connection ? WifiOff : AlertTriangle
  return (
    <main id="main" className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center" data-testid={connection ? 'app-offline' : 'app-error'}>
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-caution/10 text-caution-700 dark:text-caution-400">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h1 role="status" className="text-xl">
        {connection ? "You're offline" : 'This page hit an error'}
      </h1>
      <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
        {connection
          ? 'This page could not be loaded. It will load by itself once your connection is back.'
          : 'Something in this page failed. Trying again usually works; if it keeps failing, reload.'}
      </p>
      <RetryButton onClick={() => (connection ? window.location.reload() : reset())} />
      <ErrorDetails message={errorMessage(error, 'unknown error')} />
    </main>
  )
}
