'use client'

/**
 * The "this devnet is moving" banner (WIPE D-16): one strip under the header, on every page, while the
 * build carries `NEXT_PUBLIC_DEVNET_NOTICE` (`lib/devnet-notice.ts`).
 *
 * - `upcoming`: a heads-up that can be dismissed. The dismissal is remembered in localStorage per
 *   mode, so people who closed it are not nagged on every page, and `moving` shows again.
 * - `moving`: no dismiss; writes are off everywhere (the write guard says why) until a build
 *   for the new devnet replaces this one.
 *
 * It is a `status`, not an alert: it does not interrupt a screen reader on every navigation.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ACTIVE_NETWORK, type NetworkConfig } from '@/lib/constants'
import {
  DEVNET_MOVE_DOC,
  DEVNET_NOTICE,
  devnetNoticeCopy,
  devnetNoticeDismissKey,
  type DevnetNotice,
} from '@/lib/devnet-notice'
import { cn } from '@/lib/utils'

const listeners = new Set<() => void>()
/** Dismissals storage refused to keep (private mode): they last for this page only. */
const memoryDismissed = new Set<string>()

function isDismissed(notice: DevnetNotice): boolean {
  const key = devnetNoticeDismissKey(notice)
  if (memoryDismissed.has(key)) return true
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (): void => listener()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function DevnetNoticeBanner({
  notice = DEVNET_NOTICE,
  config = ACTIVE_NETWORK,
}: {
  notice?: DevnetNotice | null
  config?: NetworkConfig
}): JSX.Element | null {
  // Browser-only storage: until mounted `upcoming` does not show (the server snapshot says
  // "dismissed"), so neither a flash for people who closed it nor a mismatch with the static
  // HTML. `moving` cannot be dismissed, so it is already in the static HTML.
  const dismissed = useSyncExternalStore(
    subscribe,
    () => (notice === null ? true : notice === 'upcoming' && isDismissed(notice)),
    () => notice !== 'moving',
  )
  const dismiss = useCallback(() => {
    if (notice === null) return
    const key = devnetNoticeDismissKey(notice)
    try {
      window.localStorage.setItem(key, '1')
    } catch {
      memoryDismissed.add(key)
    }
    for (const l of listeners) l()
  }, [notice])

  if (notice === null || config.devnetName === null || dismissed) return null
  const copy = devnetNoticeCopy(notice, config.devnetName)
  const moving = notice === 'moving'
  return (
    <div
      role="status"
      data-testid="devnet-notice-banner"
      data-notice={notice}
      className={cn('border-b', moving ? 'border-danger/40 bg-danger/10' : 'border-caution/40 bg-caution/10')}
    >
      <div className="mx-auto flex max-w-[1280px] items-start gap-3 px-4 py-2 text-dense sm:px-6">
        <Info
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            moving ? 'text-danger-700 dark:text-danger-400' : 'text-caution-700 dark:text-caution-400',
          )}
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <span className="font-medium">{copy.lead}</span> {copy.body}{' '}
          <a
            href={DEVNET_MOVE_DOC}
            target="_blank"
            rel="noreferrer noopener"
            className="whitespace-nowrap text-forge-700 underline dark:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center"
          >
            What this means
          </a>
        </p>
        {moving ? null : (
          <Button size="icon" variant="ghost" onClick={dismiss} aria-label="Dismiss this notice" className="-my-1 -mr-2">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}
