'use client'

import { useFiat } from '@/hooks/use-fiat'
import { ACTIVE_NETWORK, type Network } from '@/lib/constants'
import { fiatText, type FiatKind } from '@/lib/fiat/format'
import { cn } from '@/lib/utils'

export function FiatNote({ dash, range, kind = 'estimate', network = ACTIVE_NETWORK.network, balance = false, variant = 'note', className }: {
  dash: number
  range?: number
  kind?: FiatKind
  network?: Network
  /** Test balances have no cash value. Costs use their mainnet equivalent. */
  balance?: boolean
  variant?: 'note' | 'bare'
  className?: string
}): JSX.Element | null {
  const eligible = !balance || network === 'mainnet'
  const { settings, rate } = useFiat(eligible)
  const text = eligible ? fiatText(dash, { range, kind, network, rate, currency: settings.currency }) : null
  if (text === null) return null
  return <span data-testid="fiat-note" className={cn('font-mono text-anvil-500 dark:text-anvil-400', className)}>{variant === 'bare' ? text : ` (${text})`}</span>
}
