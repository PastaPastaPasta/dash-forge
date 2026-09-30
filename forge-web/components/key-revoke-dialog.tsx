'use client'

/**
 * "Revoke on chain" (Settings → This browser's key, QW2-017): disable this browser's key on
 * Platform with the master key, from the identity file or the recovery phrase (an identity
 * created in this browser has no file), then forget it here. The dialog says what happens
 * before anything is picked, as Top up and Renew do. The master key signs this one update and
 * is not stored (`useMasterKeyInput`: a ref and an uncontrolled field, cleared on use).
 */

import { useState } from 'react'
import { ShieldOff } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorBox } from '@/components/auth/protection-fields'
import { useMasterKeyInput } from '@/components/auth/master-key-input'
import { UnlockMore } from '@/components/auth/unlock-more'
import { UnlockNeededError } from '@/lib/auth/controller'
import type { MasterInput } from '@/lib/auth'
import { errorMessage } from '@/lib/utils'

export function KeyRevokeDialog({ unlimited, onClose }: { unlimited: boolean; onClose: () => void }): JSX.Element {
  const { identity, keyId, revokeStored, isLoading } = useAuth()
  const master = useMasterKeyInput(identity, { id: 'revoke', fileLabel: 'Identity file to revoke with' })
  const [submitError, setError] = useState<string | null>(null)
  const error = master.error ?? submitError
  // A reloaded tab holds the signing key only: a revoke must see every key held, so it unlocks
  // first and then runs again with what was given (kept only until then).
  const [retry, setRetry] = useState<MasterInput | null>(null)
  const noun = unlimited ? 'the keys this browser holds' : "this browser's key"

  const revoke = async (input: MasterInput): Promise<void> => {
    if (identity === null) return
    setError(null)
    try {
      await revokeStored(identity, input)
      onClose()
    } catch (e) {
      if (e instanceof UnlockNeededError) setRetry(input)
      else setError(errorMessage(e))
    }
  }

  return (
    <Dialog open onClose={onClose} title={unlimited ? 'Disable key on chain' : 'Revoke this key on chain'} description={`Disables ${noun} everywhere, then forgets it here.`}>
      <form
        className="space-y-4 text-dense"
        data-testid="key-revoke-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (master.ready && !isLoading) void revoke(master.take())
        }}
      >
        <p className="text-anvil-600 dark:text-anvil-300">
          Your master key signs one identity update that disables {noun}
          {keyId !== null ? ` (key #${keyId})` : ''} on Platform, so it can sign nothing anywhere, even where it was copied. This browser then
          forgets it, and signs nothing until you sign in again. The master key is used once and is not stored. The fee comes from your
          identity balance.
        </p>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Only need this browser to stop signing? Sign out &amp; forget key instead: nothing is sent, and the key stays valid on chain until it
          expires.
        </p>
        {master.element}
        <ErrorBox error={error} />
        {retry !== null ? (
          <UnlockMore
            forgot={false}
            title="Unlock this tab to revoke on chain"
            testId="revoke-unlock"
            then={() => {
              const input = retry
              setRetry(null)
              void revoke(input)
            }}
          />
        ) : null}
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" className="flex-1" loading={isLoading} disabled={!master.ready || isLoading}>
            <ShieldOff className="h-3.5 w-3.5" aria-hidden /> {unlimited ? 'Sign once & disable' : 'Sign once & revoke'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
