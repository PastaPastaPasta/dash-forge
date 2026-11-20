/**
 * How a cost reads on a test network: the DASH is free test money, and the dollar figure beside it
 * (FiatNote's "on mainnet") is what the same write would cost on mainnet. Renders nothing on mainnet.
 */

import { ACTIVE_NETWORK, networkName, type Network } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function isTestNetwork(network: Network = ACTIVE_NETWORK.network): boolean {
  return network !== 'mainnet'
}

export function TestCreditsBadge({ className }: { className?: string }): JSX.Element | null {
  if (!isTestNetwork()) return null
  const name = networkName()
  return (
    <span
      data-testid="test-credits-badge"
      className={cn('inline-flex items-center rounded-full border border-dash/40 bg-dash/10 px-2 py-px text-[11px] font-medium leading-4 text-dash-600 dark:text-dash-400', className)}
    >
      {name.charAt(0).toUpperCase() + name.slice(1)} · free test credits
    </span>
  )
}

export function TestCreditsNote({ className }: { className?: string }): JSX.Element | null {
  if (!isTestNetwork()) return null
  return (
    <span data-testid="test-credits-note" className={className}>
      On {networkName()} you pay with free test DASH; dollar figures show what the same thing would cost on mainnet.
    </span>
  )
}
