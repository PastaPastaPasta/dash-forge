'use client'

/**
 * AppShell — the chrome every page renders inside: header, the (globally mounted) login modal,
 * a max-width content column, and the footer. Pages pass their body as children, under the
 * trust-anchor gate: a quorum-key mismatch withholds any page under a banner.
 */

import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { AppFooter } from '@/components/app-footer'
import { DevnetNoticeBanner } from '@/components/devnet-notice-banner'
import { NewKeyAlert } from '@/components/new-key-alert'
import { ContractsMissingState } from '@/components/ui/contracts-missing'
import { useContractsMissing } from '@/hooks/use-sdk'
import { useOfflineNavigation } from '@/hooks/use-offline-navigation'
import { LowFundsBanner } from '@/components/low-funds-banner'
import { ClockSkewBanner } from '@/components/clock-skew-banner'
import { LoginModal } from '@/components/login-modal'
import { PlatformBusy } from '@/components/platform-busy'
import { StorageUpdated } from '@/components/storage-updated'
import { TopUpSheet } from '@/components/top-up-sheet'
import { Toaster } from '@/components/ui/toaster'
import { TrustAnchorGate } from '@/components/ui/trust-alert'

export function AppShell({
  children,
  wide = false,
}: {
  children: ReactNode
  /** Use the full 1280px column (repo pages) vs a narrower reading column. */
  wide?: boolean
}): JSX.Element {
  // The network does not have this build's contracts (a devnet reset): one state for the whole
  // app, not a read error in every view.
  const contractsMissing = useContractsMissing()
  useOfflineNavigation()
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
      <DevnetNoticeBanner />
      <NewKeyAlert />
      <ClockSkewBanner />
      <LowFundsBanner />
      <main
        id="main"
        tabIndex={-1}
        className={`mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 ${wide ? 'max-w-[1280px]' : 'max-w-[1080px]'}`}
      >
        {/* A failed trust anchor heads every page and withholds it (QW-004). */}
        {contractsMissing !== null ? <ContractsMissingState detail={contractsMissing} /> : <TrustAnchorGate>{children}</TrustAnchorGate>}
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
