'use client'

/**
 * How this browser's limited key is protected at rest (`ux-dx-spec.md` §2.3): a passkey (PRF)
 * when the browser supports it, a passphrase (Argon2id) otherwise — or both. Produces the
 * {@link Protection} the vault seals with. A passkey is enrolled on demand, so the ceremony
 * runs only when the user asks for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Fingerprint, KeyRound } from 'lucide-react'
import { enrollPasskey, MIN_PASSPHRASE, passkeysAvailable, type Protection } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { cn, errorMessage } from '@/lib/utils'
import { clockSkewErrorCopy, noteClockSkew } from '@/lib/sdk/clock-skew'

/**
 * `preferPasskey`: the key has no budget or expiry (a shipped wallet's key), so a passkey is the
 * default choice (the primary button, with a caution against a passphrase alone). A passphrase
 * is still accepted: not every authenticator supports PRF, and that is only known after trying.
 */
export function useProtection(opts: { readonly preferPasskey?: boolean } = {}): {
  readonly fields: JSX.Element
  /** The protection, or null with `problem` set when not ready. */
  readonly protection: Protection | null
  readonly problem: string | null
} {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  // The passkey's PRF output is key material: a ref (not React state), zeroed on unmount.
  const passkeyRef = useRef<Protection['passkey'] | null>(null)
  const [hasPasskey, setHasPasskey] = useState(false)
  useEffect(
    () => () => {
      passkeyRef.current?.output.fill(0)
      passkeyRef.current = null
    },
    [],
  )
  const passkey = hasPasskey ? passkeyRef.current : null
  const [enrolling, setEnrolling] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const canPasskey = passkeysAvailable()
  const preferPasskey = opts.preferPasskey === true && canPasskey

  const enroll = async (): Promise<void> => {
    setEnrolling(true)
    setPasskeyError(null)
    try {
      const p = await enrollPasskey(`Dash Forge (${new Date().toISOString().slice(0, 10)})`)
      if (p === null) setPasskeyError("This passkey can't protect keys here (no PRF support). Use a passphrase.")
      else {
        passkeyRef.current = p
        setHasPasskey(true)
      }
    } catch (e) {
      setPasskeyError(`${errorMessage(e, 'Passkey setup was cancelled')} — use a passphrase below instead.`)
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

  let passkeyVariant: 'subtle' | 'primary' | 'outline' = 'outline'
  if (passkey) passkeyVariant = 'subtle'
  else if (preferPasskey) passkeyVariant = 'primary'

  // Passphrases are uncontrolled inputs (never mirrored into a `value` attribute), inside a
  // form so the browser does not log the fields as "not contained in a form". A caller may
  // render `fields` in more than one place: a freshly mounted form has empty inputs, so the
  // state starts empty with it (never a passphrase the screen does not show).
  const onFormMount = useCallback((form: HTMLFormElement | null) => {
    if (form === null) return
    setPassphrase('')
    setConfirm('')
  }, [])
  const fields = (
    <form ref={onFormMount} className="space-y-3 rounded-md border border-anvil-200 p-3 dark:border-anvil-800" onSubmit={(e) => e.preventDefault()}>
      <p className="text-dense font-medium">Protect this browser&apos;s key</p>
      {preferPasskey && !passkey ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="prefer-passkey">
          This key has no spending limit: use a passkey. A passphrase alone can be guessed offline by anyone who copies this browser&apos;s storage.
        </p>
      ) : null}
      {canPasskey ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={passkeyVariant} size="sm" onClick={enroll} loading={enrolling} disabled={passkey !== null}>
            <Fingerprint className="h-3.5 w-3.5" aria-hidden /> {passkey ? 'Passkey added' : 'Use a passkey'}
          </Button>
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Recommended: Touch ID, Windows Hello or a security key.</span>
        </div>
      ) : null}
      {passkeyError ? <p className="text-[12px] text-caution-700 dark:text-caution-400">{passkeyError}</p> : null}
      <Field
        label={passkey ? 'Passphrase (optional backup)' : 'Passphrase'}
        htmlFor="vault-passphrase"
        hint="Encrypts the key on this device (Argon2id, 64 MiB). Never sent anywhere."
      >
        <Input
          id="vault-passphrase"
          type="password"
          autoComplete="new-password"
          onChange={(e) => {
            setPassphrase(e.target.value)
            // The repeat field unmounts (and empties) with the passphrase: so does its state.
            if (e.target.value === '') setConfirm('')
          }}
        />
      </Field>
      {passphraseSet ? (
        <Field label="Repeat passphrase" htmlFor="vault-passphrase-2">
          <Input id="vault-passphrase-2" type="password" autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      ) : null}
      <p className="flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        <KeyRound className="h-3 w-3" aria-hidden /> Locks itself after 12 hours or when you sign out. Reloads keep only the spend-capped key for public repos.
      </p>
    </form>
  )
  return { fields, protection, problem }
}

/** An error line in the sign-in sheet (alert role, wraps long SDK messages). */
export function ErrorBox({ error, className }: { error: string | null; className?: string }): JSX.Element | null {
  // A device clock off the network's fails every sign-in step with the SDK's raw timestamps:
  // say what to fix instead (QW2-018), and let the app shell's banner say it too.
  const clock = error ? clockSkewErrorCopy(error) : null
  useEffect(() => {
    if (error) noteClockSkew(error)
  }, [error])
  if (!error) return null
  return (
    <div role="alert" className={cn('mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words', className)}>
      {clock ? (
        <>
          <span className="font-medium">{clock.title}.</span> {clock.body}
        </>
      ) : (
        error
      )}
    </div>
  )
}

/**
 * Before a key is bound to the forge contract group: runs the on-chain group check and, when the
 * group holds Forge contracts this build does not know (a newer revision the deployer added),
 * lists them so the user sees everything the key will be able to sign for. A refusal is shown
 * too; registering repeats the check and fails with the same reason.
 */
export function GroupNotice({ check }: { check: () => Promise<{ notice: string | null }> }): JSX.Element | null {
  const [text, setText] = useState<{ kind: 'notice' | 'refusal'; body: string } | null>(null)
  const checkRef = useRef(check)
  useEffect(() => {
    let cancelled = false
    checkRef
      .current()
      .then((r) => !cancelled && setText(r.notice ? { kind: 'notice', body: r.notice } : null))
      .catch((e: unknown) => {
        const body = errorMessage(e)
        // Only a trust refusal belongs here; a network hiccup is reported when registering.
        if (!cancelled && body.startsWith('refusing to bind')) setText({ kind: 'refusal', body })
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!text) return null
  return (
    <div
      role={text.kind === 'refusal' ? 'alert' : 'note'}
      data-testid="group-notice"
      className={
        text.kind === 'refusal'
          ? 'rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger-700 dark:text-danger-400 break-words'
          : 'rounded-md border border-anvil-200 px-3 py-2 text-[12px] text-anvil-600 break-words dark:border-anvil-800 dark:text-anvil-300'
      }
    >
      {text.body}
    </div>
  )
}
