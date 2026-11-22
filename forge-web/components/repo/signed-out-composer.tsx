'use client'

/**
 * What a signed-out visitor sees in place of an issue's or a PR's comment box: one line saying
 * why there is no box, the sign-in button, and what a comment costs. A full editor they can type
 * in, with a greyed "Sign in to comment" that only woke up once they had typed, read as broken.
 */

import { MessageSquare } from 'lucide-react'

import { useAuth } from '@/contexts/auth-context'
import { SignInButton } from '@/components/sign-in-button'
import { CostPreview } from '@/components/ui/cost-preview'
import type { CostPreview as Cost } from '@/lib/sdk'

/**
 * Whether to show {@link SignedOutComposer}: nobody signed in, and no stored key to unlock (a
 * locked session keeps the box and its "Unlock to comment"). While a kept session or the stored
 * keys are still being read the box stays, so a signed-in or locked user never sees this flash.
 */
export function useSignedOut(): boolean {
  const { identity, locked, resuming, vaultsLoaded, vaultsError } = useAuth()
  // Until the stored keys are read, `locked` can't be known: keep the box rather than flash this.
  return identity === null && !locked && !resuming && (vaultsLoaded || vaultsError !== null)
}

export function SignedOutComposer({ cost }: { cost: Cost }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="signed-out-composer">
      <MessageSquare className="h-5 w-5 shrink-0 text-anvil-400 dark:text-anvil-500" aria-hidden />
      <div className="min-w-0 flex-1">
        <h3 className="text-dense font-medium text-anvil-900 dark:text-anvil-50">Sign in to join the conversation</h3>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Comments are signed by your Dash identity and paid for in credits.</p>
      </div>
      <CostPreview cost={cost} className="text-[12px]" />
      <SignInButton size="sm" />
    </div>
  )
}
