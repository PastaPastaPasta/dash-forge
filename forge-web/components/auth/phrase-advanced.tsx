'use client'

/**
 * Actions that need the identity's recovery phrase or identity file (its master key). On mainnet
 * no normal flow asks for either: they sit behind one collapsed disclosure, never as the next
 * step. Elsewhere (testnet, devnets) they render in place.
 */

import type { ReactNode } from 'react'
import { ACTIVE_NETWORK } from '@/lib/constants'

/** Whether recovery-phrase actions are tucked away here (mainnet). */
export function phraseIsAdvanced(): boolean {
  return ACTIVE_NETWORK.network === 'mainnet'
}

export function PhraseAdvanced({
  children,
  label = 'Advanced: use your recovery phrase or identity file',
  testId = 'phrase-advanced',
  onToggle,
}: {
  children: ReactNode
  label?: string
  testId?: string
  /** Told when the disclosure opens or closes (an action elsewhere on the page may depend on it). */
  onToggle?: (open: boolean) => void
}): JSX.Element {
  if (!phraseIsAdvanced()) return <>{children}</>
  return (
    <details data-testid={testId} className="text-dense" onToggle={(e) => onToggle?.(e.currentTarget.open)}>
      <summary className="cursor-pointer text-[12px] text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100 coarse:py-2">{label}</summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  )
}
