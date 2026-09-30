'use client'

/**
 * An inline "Unlock to …" prompt for what a resumed session does not hold (it keeps only the
 * limited signing key): private repos (the encryption key), storage settings and wallet grants.
 * One passkey gesture when a passkey is enrolled, else the passphrase. What it opens stays in
 * this tab's memory only; a new tab asks again. `then`: the action that asked, run again after
 * the unlock (a renewal, a revoke, a wallet login over the stored key).
 */

import { useState } from 'react'
import { Fingerprint, Lock } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/utils'

export function UnlockMore({
  title,
  testId = 'unlock-more',
  then,
  forgot = true,
}: {
  title: string
  testId?: string
  then?: () => void
  /** Offer the recovery route; off where it is already on screen (the sign-in sheet, a dialog). */
  forgot?: boolean
}): JSX.Element {
  const { identity, vaults, controller, isLoading } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const methods = vaults.find((v) => v.identityId === identity)?.methods ?? []
  const go = async (method: { passphrase: string } | 'passkey'): Promise<void> => {
    setError(null)
    try {
      await controller.unlockMore(method)
      setPassphrase('')
      then?.()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div data-testid={testId} className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
      <p className="flex items-center gap-2 text-dense font-medium">
        <Lock className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> {title}
      </p>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        After a reload this browser keeps only its spend-capped signing key. Your encryption key, storage credentials and wallet grants open again for this tab.
      </p>
      {methods.includes('passkey') ? (
        <Button variant="primary" size="sm" onClick={() => void go('passkey')} loading={isLoading} disabled={isLoading}>
          <Fingerprint className="h-3.5 w-3.5" aria-hidden /> Unlock with passkey
        </Button>
      ) : null}
      {methods.includes('passphrase') ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void go({ passphrase })
          }}
        >
          <label htmlFor={`${testId}-passphrase`} className="sr-only">
            Passphrase
          </label>
          <Input
            id={`${testId}-passphrase`}
            type="password"
            autoComplete="current-password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="h-8 max-w-xs"
          />
          <Button type="submit" variant={methods.includes('passkey') ? 'outline' : 'primary'} size="sm" loading={isLoading} disabled={passphrase === '' || isLoading}>
            Unlock
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
      {/* The recovery route, as on the Unlock sheet (QW2-031). */}
      {forgot ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid={`${testId}-forgot`}>
          {methods.includes('passphrase') ? 'Forgot the passphrase' : 'Lost the passkey'}?{' '}
          <button type="button" onClick={() => openLogin('import')} className="hit-area text-forge-700 underline dark:text-forge-400">
            Replace this key with your recovery phrase or identity file
          </button>
        </p>
      ) : null}
    </div>
  )
}
