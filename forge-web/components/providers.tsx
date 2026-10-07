'use client'

import { ThemeProvider } from 'next-themes'
import { useEffect, type ReactNode } from 'react'
import { AuthProvider } from '@/contexts/auth-context'
import { InboxPoller } from '@/hooks/use-inbox'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { installDapiFetchGate } from '@/lib/sdk/budget'
import { stopPrehydrationCatcher } from '@/lib/prehydration'
import { installHashLinkHistory } from '@/lib/hash-links'
import { installSamePageLinks } from '@/hooks/use-route'

// Before any component runs: every DAPI request of this page, including the Core-over-DAPI
// calls sign-in makes before the SDK connects, goes through the shared request budget.
installDapiFetchGate(NETWORKS[DEFAULT_NETWORK].dapiAddresses)

/**
 * App-wide client providers. The theme follows the OS (`prefers-color-scheme`) until the user
 * picks one, which is kept (owner decision on L-66); `next-themes` toggles the `class` on <html>. {@link AuthProvider}
 * wraps the headless identity session so `useAuth()` works anywhere in the tree; the local
 * notifications poller runs once under it.
 */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  // The app is up: taps now reach the buttons' own handlers. A tap caught before this is acted
  // on by the component that owns its button, in its own mount effect (`consumePrehydrationIntent`);
  // this only ends the catching and keeps the intent, whichever of the two effects runs first.
  useEffect(() => {
    stopPrehydrationCatcher()
  }, [])
  // In-page `#fragment` links go through the router's history, so Back after one works (QW4-005).
  useEffect(() => installHashLinkHistory(), [])
  // A link to the page open while the address bar shows its short URL adds no entry (CJ-6).
  useEffect(() => installSamePageLinks(), [])
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <AuthProvider>
        {/* Once, app-wide: page navigations remount the header, never the poller. */}
        <InboxPoller />
        {children}
      </AuthProvider>
    </ThemeProvider>
  )
}
