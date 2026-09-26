'use client'

import { ThemeProvider } from 'next-themes'
import type { ReactNode } from 'react'
import { AuthProvider } from '@/contexts/auth-context'
import { InboxPoller } from '@/hooks/use-inbox'

/**
 * App-wide client providers. Dark mode is the primary theme (class-based, per style guide);
 * light mode fully supported. `next-themes` toggles the `class` on <html>. {@link AuthProvider}
 * wraps the headless identity session so `useAuth()` works anywhere in the tree; the local
 * notifications poller runs once under it.
 */
export function Providers({ children }: { children: ReactNode }): JSX.Element {
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
