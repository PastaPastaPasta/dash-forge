'use client'

/**
 * AppShell — the chrome every page renders inside: header, the (globally mounted) login modal,
 * a max-width content column, and the footer. Pages pass their body as children.
 */

import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { AppFooter } from '@/components/app-footer'
import { LoginModal } from '@/components/login-modal'

export function AppShell({
  children,
  wide = false,
}: {
  children: ReactNode
  /** Use the full 1280px column (repo pages) vs a narrower reading column. */
  wide?: boolean
}): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6 ${wide ? 'max-w-[1280px]' : 'max-w-[1080px]'}`}>
        {children}
      </main>
      <AppFooter />
      <LoginModal />
    </div>
  )
}
