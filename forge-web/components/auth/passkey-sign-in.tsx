'use client'

/**
 * "Sign in with a passkey" on the sign-in sheet: a passkey added in Dash Forge on another device
 * holds that device's key on Platform, and this device opens it (one prompt). It moves a session
 * between devices with the same key and budget. It does not recover an account: once the key
 * expires or is disabled, the passkey stops working and the identity file or recovery phrase is
 * how you get back in.
 *
 * Hidden while `platformPasskeyProblem` is not null (the page is not Forge's own address, the
 * browser has no passkeys, or the deployed forge-meta has no vault yet). Progress shows beside the
 * tile; a passkey that only unlocks the browser that made it says so; a browser that already keeps
 * a key for the identity offers "Unlock instead".
 */

import { useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { ErrorBox } from '@/components/auth/protection-fields'
import { Tile } from '@/components/auth/sign-in-tile'
import { Button } from '@/components/ui/button'
import { PlatformPasskeyError } from '@/lib/auth/passkey-vault/service'
import { errorMessage } from '@/lib/utils'

export function PasskeySignIn({ onDone, onUnlock }: { onDone: () => void; onUnlock: () => void }): JSX.Element | null {
  const { platformPasskeyProblem, signInWithPasskey, isLoading, step } = useAuth()
  const [failure, setFailure] = useState<{ message: string; held: boolean } | null>(null)
  // Anything but a clean null hides it: the check has not run, or it said no.
  if (platformPasskeyProblem !== null) return null
  const go = async (): Promise<void> => {
    if (isLoading) return
    setFailure(null)
    try {
      await signInWithPasskey()
      onDone()
    } catch (e) {
      setFailure({ message: errorMessage(e), held: e instanceof PlatformPasskeyError && e.code === 'held' })
    }
  }
  return (
    <div className="space-y-2" data-testid="passkey-sign-in">
      <Tile
        testId="tile-passkey"
        icon={Fingerprint}
        title="Sign in with a passkey"
        body="Added in Dash Forge on another device? It moves that sign-in here. It doesn't recover an account."
        onClick={() => void go()}
      />
      {isLoading && step ? (
        <p role="status" className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="passkey-sign-in-step">
          {step}…
        </p>
      ) : null}
      <ErrorBox error={failure?.message ?? null} className="mt-0" />
      {failure?.held ? (
        <Button variant="outline" size="sm" onClick={onUnlock} data-testid="passkey-unlock-instead">
          Unlock instead
        </Button>
      ) : null}
    </div>
  )
}
