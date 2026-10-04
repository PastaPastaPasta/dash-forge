'use client'

/**
 * Sign in (or renew this browser's key) with `dg`, so the recovery phrase never enters the page
 * (TS-06; `lib/auth/key-handoff.ts`). The tab shows a one-time request inside a `dg` command;
 * `dg` registers a limited key with the master key on the terminal and prints it sealed to this
 * tab; the tab opens it, checks it on chain and keeps it in the vault.
 *
 * The one-time private key lives in a ref for as long as the view is open and is wiped when it
 * closes or once a reply was opened: a reply only opens in the tab that asked for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Field, Textarea } from '@/components/ui/input'
import { CopyBlock } from '@/components/storage/copy-block'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { KeyLifetimeSelect } from '@/components/auth/key-lifetime'
import { UnlockMore } from '@/components/auth/unlock-more'
import { UnlockNeededError } from '@/lib/auth/controller'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { BROWSER_KEY_DEFAULTS } from '@/lib/auth'
import { handoffCommand, handoffRequest, type HandoffRequest } from '@/lib/auth/key-handoff'
import { errorMessage } from '@/lib/utils'

/**
 * `renew`: replace the signed-in identity's key. `replaceKeyId`: a key this browser holds but
 * cannot unlock (an expired or forgotten-passphrase key), disabled in the same update.
 */
export function DgHandoffFlow({ onDone, renew = false, replaceKeyId }: { readonly onDone: () => void; readonly renew?: boolean; readonly replaceKeyId?: number }): JSX.Element {
  const { adoptHandoffKey, isLoading, step, keyId, vaults, identity, unlockScope } = useAuth()
  const requestRef = useRef<HandoffRequest | null>(null)
  const [requestText, setRequestText] = useState<string | null>(null)
  const fresh = useCallback(() => {
    requestRef.current?.wipe()
    requestRef.current = handoffRequest(ACTIVE_NETWORK.key)
    setRequestText(requestRef.current.text)
  }, [])
  useEffect(() => {
    fresh()
    return () => {
      requestRef.current?.wipe()
      requestRef.current = null
    }
  }, [fresh])
  const [days, setDays] = useState<number>(BROWSER_KEY_DEFAULTS.days)
  // A renewal that drops the encryption key this browser holds brings it again by default.
  const held = vaults.find((v) => v.identityId === identity)
  const [withEncryption, setWithEncryption] = useState(renew && held?.encryptionKey === true)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const [hasReply, setHasReply] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<() => void>(() => undefined)
  const { fields, protection, problem } = useProtection({
    onSubmit: () => submitRef.current(),
  })

  const replace = renew ? (keyId ?? undefined) : replaceKeyId
  const command =
    requestRef.current && requestText
      ? handoffCommand(requestRef.current, {
          days,
          budgetDash: BROWSER_KEY_DEFAULTS.budgetDash,
          withEncryptionKey: withEncryption,
          ...(replace !== undefined ? { replaceKeyId: replace } : {}),
        })
      : null
  const ready = protection !== null && hasReply && !isLoading && requestRef.current !== null
  const submit = async (): Promise<void> => {
    const request = requestRef.current
    if (!ready || request === null || protection === null) return
    setError(null)
    try {
      await adoptHandoffKey(replyRef.current?.value ?? '', request, protection, { renew })
      if (replyRef.current) replyRef.current.value = ''
      onDone()
    } catch (e) {
      // A reloaded tab holds the signing key only: replacing the vault must carry over what it
      // seals, so unlock it here first, then carry on.
      if (e instanceof UnlockNeededError) setUnlockFirst(true)
      else setError(errorMessage(e))
    }
  }
  const [unlockFirst, setUnlockFirst] = useState(false)
  submitRef.current = () => {
    if (ready) void submit()
  }

  // A reloaded tab holds the signing key only, and a renewal must carry over what the vault
  // seals: unlock first, before dg is asked to pay for a key.
  if (renew && unlockScope === 'signing') {
    return (
      <div data-testid="dg-handoff">
        <UnlockMore forgot={false} title="Unlock this tab to renew its key" testId="dg-unlock" />
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="dg-handoff">
      <p className="text-dense text-anvil-700 dark:text-anvil-200">
        On a computer where <span className="font-mono">dg</span> is signed in as your identity, run this command. It uses your master key there, once, and prints a key that only
        this tab can open.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyLifetimeSelect id="dg-days" value={days} onChange={setDays} />
        <label className="flex items-start gap-2 self-end text-dense">
          <input type="checkbox" className="mt-0.5" checked={withEncryption} onChange={(e) => setWithEncryption(e.target.checked)} data-testid="dg-with-encryption" />
          <span>Also open private repos here</span>
        </label>
      </div>
      {command ? <CopyBlock text={command} label="Copy the dg command" /> : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {replace !== undefined ? `Key #${replace} is disabled in the same update. ` : ''}
        The new key can spend at most {BROWSER_KEY_DEFAULTS.budgetDash} DASH, only on Forge. dg shows the cost and asks before it signs.
      </p>
      <Field label="Paste the line dg printed" htmlFor="dg-reply" hint="It starts with dfkh1: and opens only in this tab.">
        {/* Uncontrolled: what it opens to is a key, and the field is cleared after use. */}
        <Textarea
          id="dg-reply"
          ref={replyRef}
          onChange={(e) => setHasReply(e.target.value.trim() !== '')}
          className="min-h-[64px] font-mono text-[12px]"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
        />
      </Field>
      {fields}
      <ErrorBox error={error} />
      <Button variant="primary" className="w-full" onClick={() => void submit()} loading={isLoading} disabled={!ready}>
        {isLoading && step ? `${step}…` : renew ? <>Renew this browser&apos;s key</> : <>Use this key</>}
      </Button>
      {problem && hasReply ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{problem}</p> : null}
      {unlockFirst ? (
        <UnlockMore
          forgot={false}
          title="Unlock this tab to renew its key"
          testId="dg-unlock"
          then={() => {
            setUnlockFirst(false)
            void submit()
          }}
        />
      ) : null}
    </div>
  )
}
