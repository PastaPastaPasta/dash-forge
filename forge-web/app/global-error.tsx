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
          <h1 className="text-xl">{chunk ? "You're offline" : 'Dash Forge hit an error'}</h1>
          <p className="mt-2 text-dense text-anvil-600 dark:text-anvil-300">
            {chunk ? 'The app could not be loaded. It will load by itself once your connection is back.' : 'Reloading usually fixes this.'}
          </p>
          <button
            type="button"
            onClick={() => (chunk ? window.location.reload() : reset())}
            className="mt-4 rounded-md border border-anvil-300 px-3 py-1.5 text-dense hover:bg-anvil-100"
          >
            Try again
          </button>
          <p className="mt-3 break-words font-mono text-[12px] text-anvil-500">{errorMessage(error, 'unknown error')}</p>
        </main>
      </body>
    </html>
  )
}
