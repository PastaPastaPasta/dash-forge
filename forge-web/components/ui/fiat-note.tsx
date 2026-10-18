'use client'

import { useFiat } from '@/hooks/use-fiat'
import { ACTIVE_NETWORK, type Network } from '@/lib/constants'
import { fiatText, type FiatKind } from '@/lib/fiat/format'

export function FiatNote({ dash, range, kind = 'estimate', network = ACTIVE_NETWORK.network, balance = false, variant = 'note', prefix = '' }: {
  dash: number
  range?: number
  kind?: FiatKind
  network?: Network
  /** Test balances have no cash value. Costs use their mainnet equivalent. */
  balance?: boolean
  variant?: 'note' | 'bare'
  prefix?: string
}): JSX.Element | null {
  // An ineligible note has no rate, so fiatText returns null for it.
  const { settings, rate } = useFiat(!balance || network === 'mainnet')
  const text = fiatText(dash, { range, kind, network, rate, currency: settings.currency })
  if (text === null) return null
  return <span data-testid="fiat-note" className="font-mono text-anvil-500 dark:text-anvil-400">{prefix}{variant === 'bare' ? text : ` (${text})`}</span>
}
