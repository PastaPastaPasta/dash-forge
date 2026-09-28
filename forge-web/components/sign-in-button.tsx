'use client'

/**
 * The one "you are not signed in" action, wherever a page offers it: **Unlock** when this browser
 * holds a key whose session is locked (the 12 hours ran out, Lock, "Ask to unlock on every
 * visit"), else **Sign in**. Both open the sign-in sheet, which lands on its Unlock view when a
 * key is stored. While a kept session is still being picked up after a reload it shows nothing
 * clickable, so a signed-in user never sees "Sign in" flash.
 */

import { Lock } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Button, type ButtonProps } from '@/components/ui/button'

export function SignInButton({
  size,
  variant = 'primary',
  className,
  label = 'short',
}: Pick<ButtonProps, 'size' | 'variant' | 'className'> & { readonly label?: 'short' | 'long' }): JSX.Element {
  const { locked, resuming, vaultsLoaded, vaultsError } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const common = { size, variant, className }
  // Until it is known whether this browser holds a key (a few ms), neither label.
  if (resuming || (!vaultsLoaded && vaultsError === null)) {
    // In the static page this is what shows before the app hydrates: a tap on it is kept and
    // opens the sheet once the app is up (lib/prehydration.ts, consumed in AppHeader).
    return <Button {...common} loading aria-label="Checking this browser's session" data-replay="sign-in" />
  }
  if (locked) {
    return (
      <Button
        {...common}
        onClick={() => openLogin()}
        data-replay="sign-in"
        data-testid="session-unlock"
        aria-label="Session locked — Unlock"
        title="This browser holds your key, but the session is locked. Unlock to write."
      >
        <Lock className="h-3.5 w-3.5" aria-hidden />
        {label === 'long' ? <span className="hidden sm:inline">Session locked —</span> : null} Unlock
      </Button>
    )
  }
  return (
    <Button {...common} onClick={() => openLogin()} data-replay="sign-in">
      Sign in
    </Button>
  )
}
