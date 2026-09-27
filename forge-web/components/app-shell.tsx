'use client'

/**
 * AppShell — the chrome every page renders inside: header, the (globally mounted) login modal,
 * a max-width content column, and the footer. Pages pass their body as children.
 */

import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { AppFooter } from '@/components/app-footer'
import { LoginModal } from '@/components/login-modal'
import { PlatformBusy } from '@/components/platform-busy'
import { StorageUpdated } from '@/components/storage-updated'
import { TopUpSheet } from '@/components/top-up-sheet'
import { Toaster } from '@/components/ui/toaster'

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
      {/* First Tab stop: skip the header's controls (WCAG 2.4.1). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-dense focus:font-medium focus:text-anvil-900 focus:shadow-lg dark:focus:bg-anvil-900 dark:focus:text-anvil-50"
      >
        Skip to content
      </a>
      <AppHeader />
      <main
        id="main"
        tabIndex={-1}
        className={`mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 ${wide ? 'max-w-[1280px]' : 'max-w-[1080px]'}`}
      >
        {children}
      </main>
      <AppFooter />
      <LoginModal />
      <TopUpSheet />
      <Toaster />
      <PlatformBusy />
      <StorageUpdated />
    </div>
  )
}
