'use client'

/**
 * On a test network's build, once Forge is live on mainnet and the build knows the mainnet site
 * (`lib/network-sites.ts`): one dismissible strip under the header, on every page, saying this
 * site's DASH has no cash value and where mainnet is. The dismissal is remembered in localStorage.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ACTIVE_NETWORK, networkName, type NetworkConfig } from '@/lib/constants'
import { otherNetworkSite, type OtherSite } from '@/lib/network-sites'

export const MAINNET_LIVE_DISMISS_KEY = 'forge.mainnet-live-banner.dismissed'

const listeners = new Set<() => void>()
/** Set when storage refused the dismissal (private mode): it lasts for this page only. */
let memoryDismissed = false

function isDismissed(): boolean {
  if (memoryDismissed) return true
  try {
    return window.localStorage.getItem(MAINNET_LIVE_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

export function MainnetLiveBanner({
  config = ACTIVE_NETWORK,
  site = otherNetworkSite(config),
}: {
  config?: NetworkConfig
  site?: OtherSite | null
}): JSX.Element | null {
  // Browser-only storage: hidden until mounted, so people who closed it see no flash. Also hidden
  // on the mainnet site's own origin, should a test build be served there before the hosts move.
  const hidden = useSyncExternalStore(subscribe, () => isDismissed() || window.location.origin === site?.url, () => true)
  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(MAINNET_LIVE_DISMISS_KEY, '1')
    } catch {
      memoryDismissed = true
    }
    for (const l of listeners) l()
  }, [])

  if (config.network === 'mainnet' || site?.key !== 'mainnet' || hidden) return null
  return (
    <div role="status" data-testid="mainnet-live-banner" className="border-b border-caution/40 bg-caution/10">
      <div className="mx-auto flex max-w-[1280px] items-start gap-3 px-4 py-2 text-dense sm:px-6">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-caution-700 dark:text-caution-400" aria-hidden />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <span className="font-medium">You’re on Forge {networkName(config)},</span> where DASH has no cash value. Forge is live on mainnet at{' '}
          <a
            href={site.url}
            className="whitespace-nowrap text-forge-700 underline dark:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center"
          >
            {site.host}
          </a>
        </p>
        <Button size="icon" variant="ghost" onClick={dismiss} aria-label="Dismiss this notice" className="-my-1 -mr-2">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}
