'use client'

/**
 * The device-clock banner (QW2-018): one line under the header, on every page, while Platform
 * answers are being refused because this device's clock is too far off the network's. Every
 * read and sign-in fails the same way then, and each view's own error would otherwise read
 * as a network problem that "Try again" fixes. It goes away by itself once the clock is right.
 */

import { Clock } from 'lucide-react'
import { useClockSkew } from '@/hooks/use-sdk'
import { clockSkewCopy, skewAmount } from '@/lib/sdk/clock-skew'

export function ClockSkewBanner(): JSX.Element | null {
  const skew = useClockSkew()
  if (skew === null) return null
  const copy = clockSkewCopy(skew)
  const way = skew.aheadMs >= 0 ? 'ahead' : 'behind'
  return (
    <div role="alert" data-testid="clock-skew-banner" className="border-b border-danger/40 bg-danger/10">
      <div className="mx-auto flex max-w-[1280px] items-start gap-3 px-4 py-2 text-dense sm:px-6">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-danger-700 dark:text-danger-400" aria-hidden />
        <div className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <p>
            <span className="font-medium">{copy.title}</span> ({skewAmount(skew.aheadMs)} {way}) — enable automatic time to connect.
          </p>
          <details className="mt-0.5 text-[12px] text-anvil-600 dark:text-anvil-300">
            <summary className="w-fit cursor-pointer hover:text-anvil-900 coarse:inline-flex coarse:min-h-11 coarse:items-center dark:hover:text-anvil-100">
              More
            </summary>
            <p className="mt-1">{copy.body}</p>
          </details>
        </div>
      </div>
    </div>
  )
}
