'use client'

/**
 * "Revoke on chain" (Settings → This browser's key, QW2-017): disable this browser's key on
 * Platform with the master key, from the identity file or the recovery phrase (an identity
 * created in this browser has no file), then forget it here. The dialog says what happens and
 * what it costs before anything is picked, as Top up and Renew do (QW3-030). The master key signs
 * this one update and is not stored (`useMasterKeyInput`: a ref and an uncontrolled field,
 * cleared once used; kept only to correct or retry: words or a file of another identity
 * (QW3-028), an unlock asked first, or an update Platform never got).
 *
 * A reloaded tab holds only its spend-capped key, and a revoke must see every key this browser
 * holds: such a tab unlocks first, inline (QW3-006). The unlock sits outside the revoke's form:
 * nested inside it, its Unlock button submitted the page itself (a reload to `/settings/?`), so
 * the dialog vanished and nothing was revoked.
 */

import { useEffect, useState } from 'react'
import { ShieldOff } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { ErrorBox } from '@/components/auth/protection-fields'
import { useMasterKeyInput } from '@/components/auth/master-key-input'
import { UnlockMore } from '@/components/auth/unlock-more'
import { topUpStays } from '@/components/top-up-stays'
import { UnlockNeededError } from '@/lib/auth/controller'
import { IdentityUpdateNotSentError, WrongMasterKeyError } from '@/lib/auth/limited-key'
import { KEY_DISABLE_CREDITS, previewCredits } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

export function KeyRevokeDialog({ unlimited, onClose }: { unlimited: boolean; onClose: () => void }): JSX.Element {
  const { identity, keyId, revokeStored, isLoading, unlockScope } = useAuth()
  const master = useMasterKeyInput(identity, { id: 'revoke', fileLabel: 'Identity file to revoke with' })
  const [submitError, setError] = useState<string | null>(null)
  const error = master.error ?? submitError
  // A revoke that found the tab holding only its signing key (the scope can change under the
  // dialog): unlock, then it runs again with the master key still in the field.
  const [unlockAsked, setUnlockAsked] = useState(false)
  const needsUnlock = unlockScope === 'signing' || unlockAsked
  const noun = unlimited ? 'the keys this browser holds' : "this browser's key"
  // What this browser keeps about the identity's top-ups after the revoke forgets the key (QW3-034).
  const [stays, setStays] = useState<string | null>(null)
  useEffect(() => {
    if (identity === null) return
    let live = true
    void topUpStays(identity).then((s) => live && setStays(s))
    return () => {
      live = false
    }
  }, [identity])

  const revoke = async (): Promise<void> => {
    if (identity === null || !master.ready || isLoading) return
    setError(null)
    try {
      await revokeStored(identity, master.take({ keep: true }))
      master.clear()
      onClose()
    } catch (e) {
      const retry = e instanceof UnlockNeededError || e instanceof WrongMasterKeyError || e instanceof IdentityUpdateNotSentError
      if (!retry) master.clear()
      if (e instanceof UnlockNeededError) setUnlockAsked(true)
      else setError(errorMessage(e))
    }
  }

  return (
    <Dialog open onClose={onClose} title={unlimited ? 'Disable key on chain' : 'Revoke this key on chain'} description={`Disables ${noun} everywhere, then forgets it here.`}>
      <div className="space-y-4 text-dense">
        <p className="text-anvil-600 dark:text-anvil-300">
          Your master key signs one identity update that disables {noun}
          {keyId !== null ? ` (key #${keyId})` : ''} on Platform, so it can sign nothing anywhere, even where it was copied. This browser then
          forgets it, and signs nothing until you sign in again. The master key is used once and is not stored.
        </p>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Only need this browser to stop signing? Sign out &amp; forget key instead: nothing is sent, and the key stays valid on chain until it
          expires.
        </p>
        {stays !== null ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="revoke-top-up-stays">
            {stays}
          </p>
        ) : null}
        {needsUnlock ? (
          <UnlockMore
            forgot={false}
            title="Unlock this tab to revoke on chain"
            testId="revoke-unlock"
            then={() => {
              setUnlockAsked(false)
              // Asked for by a revoke already submitted: carry on with the master key given.
              if (unlockAsked) void revoke()
            }}
          />
        ) : null}
        <form
          className="space-y-4"
          data-testid="key-revoke-dialog"
          onSubmit={(e) => {
            e.preventDefault()
            void revoke()
          }}
        >
          {master.element}
          <ErrorBox error={error} />
          <CostPreview cost={previewCredits(KEY_DISABLE_CREDITS)} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              className="flex-1"
              loading={isLoading}
              disabled={!master.ready || isLoading || needsUnlock}
              title={needsUnlock ? 'Unlock this tab first (above)' : undefined}
            >
              <ShieldOff className="h-3.5 w-3.5" aria-hidden /> {unlimited ? 'Sign once & disable' : 'Sign once & revoke'}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
