'use client'

import { ThemeProvider } from 'next-themes'
import { useEffect, type ReactNode } from 'react'
import { AuthProvider } from '@/contexts/auth-context'
import { InboxPoller } from '@/hooks/use-inbox'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { installDapiFetchGate } from '@/lib/sdk/budget'
import { replayPrehydrationClick } from '@/lib/prehydration'

// Before any component runs: every DAPI request of this page, including the Core-over-DAPI
// calls sign-in makes before the SDK connects, goes through the shared request budget.
installDapiFetchGate(NETWORKS[DEFAULT_NETWORK].dapiAddresses)

/**
 * App-wide client providers. Dark mode is the primary theme (class-based, per style guide);
 * light mode fully supported. `next-themes` toggles the `class` on <html>. {@link AuthProvider}
 * wraps the headless identity session so `useAuth()` works anywhere in the tree; the local
 * notifications poller runs once under it.
 */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  // The app has hydrated (this effect runs after the whole tree's): a button tapped before now
  // is clicked again, with its handler attached.
  useEffect(() => {
    replayPrehydrationClick()
  }, [])
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
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
