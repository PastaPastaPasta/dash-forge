'use client'

/**
 * The last-resort boundary: an error in the root layout itself (the providers, the shell), where
 * `app/error.tsx` cannot render. It replaces the whole document, so it brings its own <html>.
 * A chunk that failed to load while offline reloads once the connection is back, within the same
 * reload budget as `app/error.tsx`.
 */

import { useEffect } from 'react'
import { autoReload, isLoadFailure } from '@/lib/auto-reload'
import { scheduleReconnect } from '@/lib/view/reconnect'
import { errorMessage } from '@/lib/utils'
import './globals.css'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): JSX.Element {
  const chunk = isLoadFailure(error)
  useEffect(() => (chunk ? scheduleReconnect(autoReload) : undefined), [chunk])
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center" data-testid="app-global-error">
          <h1 className="text-xl">{chunk ? "You're offline" : 'Something went wrong'}</h1>
          <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
            {chunk ? 'The app will reload when your connection returns.' : 'Reloading usually fixes this.'}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => (chunk ? window.location.reload() : reset())}
              className="inline-flex h-9 items-center justify-center rounded-md bg-forge-700 px-3.5 text-dense font-medium text-white hover:bg-forge-800 coarse:min-h-11"
            >
              Try again
            </button>
            <a
              href="/"
              className="inline-flex h-9 items-center justify-center rounded-md border border-anvil-300 px-3.5 text-dense font-medium hover:bg-anvil-100 coarse:min-h-11 dark:border-anvil-700 dark:hover:bg-anvil-800"
            >
              Go home
            </a>
          </div>
          <details className="mt-4 max-w-md text-dense text-anvil-500 dark:text-anvil-400">
            <summary className="cursor-pointer coarse:min-h-11">Details</summary>
            <p className="mt-1 break-words font-mono text-[12px]">{errorMessage(error, 'unknown error')}</p>
          </details>
        </main>
      </body>
    </html>
  )
}
