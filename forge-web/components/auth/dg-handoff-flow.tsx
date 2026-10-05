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

/** A key this browser holds, which the new key replaces (disabled in the same update). */
export interface HandoffTarget {
  readonly identityId: string
  readonly keyId: number
}

/**
 * `renew`: replace the signed-in identity's key. `target`: a key this browser holds but cannot
 * unlock (an expired or forgotten-passphrase key). Otherwise, when this browser holds keys, the
 * user picks the one to replace, or none (another identity).
 */
export function DgHandoffFlow({ onDone, renew = false, target }: { readonly onDone: () => void; readonly renew?: boolean; readonly target?: HandoffTarget }): JSX.Element {
  const { adoptHandoffKey, isLoading, step, keyId, vaults, identity, unlockScope, controller } = useAuth()
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

  // The key the new one replaces. Never left implicit: a key this browser holds and dg does not
  // disable would stay live with nothing holding it (the controller refuses such a reply).
  const stored = vaults.filter((v) => v.staged !== true)
  const [picked, setPicked] = useState<string>(() => stored[0]?.identityId ?? '')
  const pickedVault = stored.find((v) => v.identityId === picked)
  const replace: HandoffTarget | undefined =
    renew && identity !== null && keyId !== null
      ? { identityId: identity, keyId }
      : (target ?? (pickedVault ? { identityId: pickedVault.identityId, keyId: pickedVault.keyId } : undefined))
  // Wallet keys can't be replaced from dg: say so before dg is asked to pay for a key.
  const [blocker, setBlocker] = useState<string | null>(null)
  const replaceIdentity = replace?.identityId
  useEffect(() => {
    let cancelled = false
    setBlocker(null)
    if (replaceIdentity === undefined) return
    controller.handoffBlocker(replaceIdentity).then(
      (b) => !cancelled && setBlocker(b),
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [controller, replaceIdentity])
  const command =
    requestRef.current && requestText
      ? handoffCommand(requestRef.current, {
          days,
          budgetDash: BROWSER_KEY_DEFAULTS.budgetDash,
          withEncryptionKey: withEncryption,
          ...(replace !== undefined ? { replaceKeyId: replace.keyId, identityId: replace.identityId } : {}),
        })
      : null
  const ready = protection !== null && hasReply && !isLoading && requestRef.current !== null
  const submit = async (): Promise<void> => {
    const request = requestRef.current
    if (!ready || request === null || protection === null) return
    setError(null)
    try {
      await adoptHandoffKey(replyRef.current?.value ?? '', request, protection, { renew, ...(replace !== undefined ? { identityId: replace.identityId } : {}) })
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
      {!renew && target === undefined && stored.length > 0 ? (
        <Field label="This browser already holds a key for" htmlFor="dg-replace" hint="That key is disabled in the same update. Pick none for another identity.">
          <select
            id="dg-replace"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="w-full rounded-md border border-anvil-300 bg-transparent px-2 py-1.5 font-mono text-dense coarse:h-11 coarse:text-base dark:border-anvil-700"
          >
            {stored.map((v) => (
              <option key={v.identityId} value={v.identityId}>
                {v.identityId.slice(0, 10)}… (key #{v.keyId})
              </option>
            ))}
            <option value="">None: another identity</option>
          </select>
        </Field>
      ) : null}
      {blocker !== null ? (
        <p role="alert" data-testid="dg-blocked" className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-800 dark:text-caution-300">
          {blocker}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyLifetimeSelect id="dg-days" value={days} onChange={setDays} />
        <label className="flex items-start gap-2 self-end text-dense">
          <input type="checkbox" className="mt-0.5" checked={withEncryption} onChange={(e) => setWithEncryption(e.target.checked)} data-testid="dg-with-encryption" />
          <span>Also open private repos here</span>
        </label>
      </div>
      {command && blocker === null ? <CopyBlock text={command} label="Copy the dg command" /> : null}
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {replace !== undefined ? `Key #${replace.keyId} is disabled in the same update. ` : ''}
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
