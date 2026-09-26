'use client'

/**
 * How this browser's limited key is protected at rest (`ux-dx-spec.md` §2.3): a passkey (PRF)
 * when the browser supports it, a passphrase (Argon2id) otherwise — or both. Produces the
 * {@link Protection} the vault seals with. A passkey is enrolled on demand, so the ceremony
 * runs only when the user asks for it.
 */

import { useState } from 'react'
import { Fingerprint, KeyRound } from 'lucide-react'
import { enrollPasskey, MIN_PASSPHRASE, passkeysAvailable, type Protection } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/utils'

export function useProtection(): {
  readonly fields: JSX.Element
  /** The protection, or null with `problem` set when not ready. */
  readonly protection: Protection | null
  readonly problem: string | null
} {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passkey, setPasskey] = useState<Protection['passkey'] | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const canPasskey = passkeysAvailable()

  const enroll = async (): Promise<void> => {
    setEnrolling(true)
    setPasskeyError(null)
    try {
      const p = await enrollPasskey(`Dash Forge (${new Date().toISOString().slice(0, 10)})`)
      if (p === null) setPasskeyError("This passkey can't protect keys here (no PRF support). Use a passphrase.")
      else setPasskey(p)
    } catch (e) {
      setPasskeyError(errorMessage(e, 'passkey setup was cancelled'))
    } finally {
      setEnrolling(false)
    }
  }

  const passphraseSet = passphrase.length > 0
  let problem: string | null = null
  if (passphraseSet && passphrase.length < MIN_PASSPHRASE) problem = `Use at least ${MIN_PASSPHRASE} characters.`
  else if (passphraseSet && passphrase !== confirm) problem = 'The passphrases do not match.'
  else if (!passphraseSet && !passkey) problem = 'Protect the key with a passkey or a passphrase.'

  const protection: Protection | null =
    problem !== null ? null : { ...(passphraseSet ? { passphrase } : {}), ...(passkey ? { passkey } : {}) }

  const fields = (
    <div className="space-y-3 rounded-md border border-anvil-200 p-3 dark:border-anvil-800">
      <p className="text-dense font-medium">Protect this browser&apos;s key</p>
      {canPasskey ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={passkey ? 'subtle' : 'outline'} size="sm" onClick={enroll} loading={enrolling} disabled={passkey !== null}>
            <Fingerprint className="h-3.5 w-3.5" aria-hidden /> {passkey ? 'Passkey added' : 'Use a passkey'}
          </Button>
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Recommended: Touch ID, Windows Hello or a security key.</span>
        </div>
      ) : null}
      {passkeyError ? <p className="text-[12px] text-caution">{passkeyError}</p> : null}
      <Field
        label={passkey ? 'Passphrase (optional backup)' : 'Passphrase'}
        htmlFor="vault-passphrase"
        hint="Encrypts the key on this device (Argon2id, 64 MiB). Never sent anywhere."
      >
        <Input id="vault-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </Field>
      {passphraseSet ? (
        <Field label="Repeat passphrase" htmlFor="vault-passphrase-2">
          <Input id="vault-passphrase-2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      ) : null}
      <p className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        <KeyRound className="h-3 w-3" aria-hidden /> Locks itself after 12 hours or when you sign out.
      </p>
    </div>
  )
  return { fields, protection, problem }
}

/** An error line in the sign-in sheet (alert role, wraps long SDK messages). */
export function ErrorBox({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null
  return (
    <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">
      {error}
    </div>
  )
}
