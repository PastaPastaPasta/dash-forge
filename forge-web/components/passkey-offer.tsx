'use client'

/**
 * The one-time Passkey Vault backup offer, in a slim bar under the header after an interactive
 * sign-in or unlock. The backup moves this sign-in to another device; it does not recover an
 * account. It is not the passkey that may lock this browser's key, and says so when that one
 * exists; it waits for a later sign-in after a fresh sign-up (`deferOfferThisLoad`). It never nags (`lib/auth/passkey-vault/offer.ts`): at most twice per identity on this
 * browser, once per page load, never after "Not now" or a click on "Set up a passkey", never for a
 * reloaded tab (which holds only the signing key), and never where a passkey could not hold this
 * key (a pasted key, or one with no budget or no expiry) or the feature is hidden.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Fingerprint, X } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button, buttonClass } from '@/components/ui/button'
import { readMarkers } from '@/lib/auth/passkey-vault/markers'
import { dismissOffer, noteOffered, offerDeferred, shouldOffer } from '@/lib/auth/passkey-vault/offer'
import { ACTIVE_NETWORK } from '@/lib/constants'

export function PasskeyOffer(): JSX.Element | null {
  const { identity, storage, unlockScope, platformPasskeyProblem, keyLimits, unlimitedKey, unboundedKey, vaults } = useAuth()
  const [showing, setShowing] = useState<string | null>(null)
  // The identity already asked about in this page load: one question per page load.
  const asked = useRef<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const eligible =
    identity !== null &&
    storage === 'vault' &&
    unlockScope === 'full' &&
    platformPasskeyProblem === null &&
    !unlimitedKey &&
    !unboundedKey &&
    keyLimits?.total != null &&
    keyLimits.expiresAt !== null &&
    // A spent or expired key would be refused when added: no offer for it.
    keyLimits.expiresAt > Date.now() &&
    (keyLimits.remaining === null || keyLimits.remaining > 0n)
  useEffect(() => {
    if (!eligible || identity === null || asked.current === identity) return
    asked.current = identity
    const network = ACTIVE_NETWORK.network
    void (async () => {
      if (offerDeferred(network, identity) || !shouldOffer(network, identity)) return
      // A passkey made or used here already answers the question.
      const mine = await readMarkers(network, identity).catch(() => [])
      if (mine.length > 0) return dismissOffer(network, identity)
      if (noteOffered(network, identity) && alive.current) setShowing(identity)
    })()
  }, [eligible, identity])

  if (!eligible || showing !== identity || identity === null) return null
  const done = (): void => {
    dismissOffer(ACTIVE_NETWORK.network, identity)
    setShowing(null)
  }
  const sealedWithPasskey = vaults.some((v) => v.identityId === identity && v.methods.includes('passkey'))
  return (
    <div role="status" data-testid="passkey-offer" className="border-b border-anvil-200 bg-anvil-50 dark:border-anvil-800 dark:bg-anvil-900">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-dense sm:px-6">
        <Fingerprint className="h-4 w-4 shrink-0 text-forge-500" aria-hidden />
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <span className="font-medium">Passkey Vault backup:</span> sign in on your other devices too.{' '}
          <span className="hidden sm:inline">
            {sealedWithPasskey ? "Your passkey already locks this browser's key; this is a separate, optional backup. " : 'Optional. '}
            It doesn&apos;t recover an account.
          </span>
        </p>
        <div className="flex items-center gap-1">
          <Link href="/settings/keys/#passkeys" onClick={done} className={buttonClass({ size: 'sm', variant: 'primary' })} data-testid="passkey-offer-setup">
            Set up backup
          </Link>
          <Button size="sm" variant="ghost" onClick={done} data-testid="passkey-offer-dismiss">
            Not now
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setShowing(null)} aria-label="Hide for now">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
