'use client'

/**
 * The app's error boundary (L-56). Its common cause is a page whose code could not be fetched,
 * because the connection dropped before the tab loaded that page's chunk: without this, Next
 * shows a blank "Application error". A connection failure gets the plain offline state and
 * reloads by itself once the browser is back online; anything else says what failed, with Try
 * again.
 */

import { useEffect } from 'react'
import { AlertTriangle, WifiOff } from 'lucide-react'
import { isUnreachableError } from '@/lib/sdk/unreachable'
import { errorMessage } from '@/lib/utils'
import { isOffline } from '@/lib/online'
import { ErrorDetails, RetryNowButton } from '@/components/ui/states'

/** A failure to fetch the app's own code (a webpack chunk, or the route's RSC payload). */
function isLoadFailure(e: unknown): boolean {
  const name = e instanceof Error ? e.name : ''
  return name === 'ChunkLoadError' || /loading (?:css )?chunk .* failed|failed to fetch dynamically imported module/i.test(errorMessage(e, ''))
}

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): JSX.Element {
  const connection = isLoadFailure(error) || isUnreachableError(error) || isOffline()
  useEffect(() => {
    if (!connection) return
    // The failed chunk is only fetched again by a fresh load of the page.
    const back = (): void => window.location.reload()
    if (navigator.onLine) {
      const t = setTimeout(back, 5_000)
      return () => clearTimeout(t)
    }
    window.addEventListener('online', back)
    return () => window.removeEventListener('online', back)
  }, [connection])

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
          ? 'This page could not be loaded. It will load by itself as soon as your connection is back.'
          : 'Something in this page failed. Trying again usually works; if it keeps failing, reload.'}
      </p>
      <RetryNowButton onClick={() => (connection ? window.location.reload() : reset())} />
      <ErrorDetails message={errorMessage(error, 'unknown error')} />
    </main>
  )
}
