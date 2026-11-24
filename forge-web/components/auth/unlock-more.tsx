'use client'

/**
 * An inline "Unlock to …" prompt for what a resumed session does not hold (it keeps only the
 * limited signing key): private repos (the encryption key), storage settings and wallet grants.
 * One passkey gesture when a passkey is enrolled, else the passphrase. What it opens stays in
 * this tab's memory only; a new tab asks again. `then`: the action that asked, run again after
 * the unlock (a renewal, a revoke, a wallet login over the stored key).
 */

import { ACTIVE_NETWORK } from '@/lib/constants'
import { useCallback, useRef, useState } from 'react'
import { Fingerprint, Lock } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/utils'
import type { UnlockMethod } from '@/lib/auth/vault'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'

/**
 * The prompt over members-only content this tab cannot read yet (DESIGN §4.8, §10):
 * `<UnlockMore title={UNLOCK_MEMBERS_ONLY} />`. The unlock is per tab, not per repo: one gesture
 * opens the encryption key for every repo in the tab (`encryptionKeyState` says whether it is
 * needed), and every private read re-resolves when `useAuth().unlockScope` turns `full`.
 */
export const UNLOCK_MEMBERS_ONLY = 'Unlock to read members-only content'

/** The same prompt over messages sent to specific people (this reader among them). */
export const UNLOCK_LETTERS = 'Unlock to read messages sent to you'

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
  const { identity, vaults, controller, isLoading, locked } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  // The passphrase lives only in the input's value property (an uncontrolled input): React
  // mirrors a controlled input's value into the `value` attribute, which puts it in the DOM.
  const passphraseRef = useRef<HTMLInputElement | null>(null)
  const [hasPassphrase, setHasPassphrase] = useState(false)
  // Wipe the field as React detaches it (a cleanup effect runs too late: the ref is null); a
  // remounted field is empty, and so is the flag.
  const bindPassphrase = useCallback((el: HTMLInputElement | null) => {
    if (el === null && passphraseRef.current) passphraseRef.current.value = ''
    if (el === null) setHasPassphrase(false)
    passphraseRef.current = el
  }, [])
  const [error, setError] = useState<string | null>(null)
  const methods = vaults.find((v) => v.identityId === identity)?.methods ?? []
  const go = async (method: UnlockMethod): Promise<void> => {
    setError(null)
    try {
      await controller.unlockMore(method)
      if (passphraseRef.current) passphraseRef.current.value = ''
      setHasPassphrase(false)
      then?.()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  // The whole session is locked (no signing key in this tab either): the header's Unlock, here.
  if (identity === null && locked) {
    return (
      <div data-testid={testId} className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
        <p className="flex items-center gap-2 text-dense font-medium">
          <Lock className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> {title}
        </p>
        <Button variant="primary" size="sm" onClick={() => openLogin()} data-testid={`${testId}-open`}>
          Unlock
        </Button>
      </div>
    )
  }
  return (
    <div data-testid={testId} className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
      <p className="flex items-center gap-2 text-dense font-medium">
        <Lock className="h-4 w-4 text-anvil-500 dark:text-anvil-400" aria-hidden /> {title}
      </p>
      {methods.length === 1 && methods[0] === 'device' ? null : (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">After a reload only the signing key opens by itself. Unlock once for this tab.</p>
      )}
      {methods.length === 1 && methods[0] === 'device' ? <ProtectThisKey testId={testId} then={then} /> : null}
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
            const passphrase = passphraseRef.current?.value ?? ''
            if (passphrase !== '') void go({ passphrase })
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
            ref={bindPassphrase}
            onChange={(e) => setHasPassphrase(e.target.value !== '')}
            className="h-8 max-w-xs"
          />
          <Button type="submit" variant={methods.includes('passkey') ? 'outline' : 'primary'} size="sm" loading={isLoading} disabled={!hasPassphrase || isLoading}>
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
          {methods.includes('passphrase') ? 'Forgot the passphrase' : methods.includes('passkey') ? 'Lost the passkey' : 'Key not working'}?{' '}
          <button type="button" onClick={() => openLogin(ACTIVE_NETWORK.network === 'mainnet' ? 'wallet' : 'import')} className="hit-area text-forge-700 underline dark:text-forge-400">
            {ACTIVE_NETWORK.network === 'mainnet' ? 'Sign in again with your wallet' : 'Replace this key with your recovery phrase or identity file'}
          </button>
        </p>
      ) : null}
    </div>
  )
}

/**
 * A key kept by this browser alone opens for signing only: private content, storage settings and
 * wallet grants need a passkey or passphrase on it first (no new key, no fee).
 */
function ProtectThisKey({ testId, then }: { testId: string; then?: () => void }): JSX.Element {
  const { controller, isLoading } = useAuth()
  const { fields, protection, problem } = useProtection({ allowDevice: false })
  const [error, setError] = useState<string | null>(null)
  const go = async (): Promise<void> => {
    if (protection === null) {
      setError(problem)
      return
    }
    setError(null)
    try {
      await controller.protectKey(protection)
      then?.()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="space-y-2" data-testid={`${testId}-protect`}>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Add a passkey or password to this browser&apos;s key first.</p>
      {fields}
      <Button variant="primary" size="sm" loading={isLoading} onClick={() => void go()}>
        Protect and unlock
      </Button>
      <ErrorBox error={error} />
    </div>
  )
}
