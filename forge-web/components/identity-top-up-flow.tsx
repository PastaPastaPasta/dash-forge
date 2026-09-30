'use client'

/**
 * Top up the signed-in identity from this browser (QW-012), inside the top-up sheet: the
 * recovery phrase (checked against the identity) gives a deposit address, shown as a QR code
 * and text; the page watches for the payment, locks it and sends the `IdentityTopUp`
 * (`lib/auth/identity-top-up.ts`). Any Dash wallet, or a devnet faucet, can pay the address.
 *
 * The words are held in the textarea and a ref only, dropped once the run ends. A deposit this
 * device recorded but did not finish is offered again when the sheet reopens: typing the same
 * words resumes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { Field, Textarea } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { ErrorBox } from '@/components/auth/protection-fields'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { PHASE_TEXT, connectPlatform, type ConnectPhase } from '@/lib/auth/connect'
import { isValidMnemonic, mnemonicProblem } from '@/lib/auth/hd'
import { MIN_TOP_UP_DUFFS, discardTopUp, readTopUpJournal, topUpIdentity, type TopUpJournal, type TopUpStage } from '@/lib/auth/identity-top-up'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { isAbort } from '@/lib/sdk/facade'
import { creditsAsDash } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

const STAGE_TEXT: Readonly<Record<TopUpStage, string>> = {
  'waiting-deposit': 'Watching for your deposit…',
  locking: 'Locking the deposit for Platform…',
  proving: 'Waiting for the lock to be provable…',
  'topping-up': 'Adding the credits to your identity…',
  checking: 'Checking whether Platform recorded the top-up…',
}

export function IdentityTopUpFlow({ faucet }: { faucet: string | null }): JSX.Element | null {
  const { identity, refreshBalance } = useAuth()
  const network = ACTIVE_NETWORK.network
  const words = useRef<HTMLTextAreaElement | null>(null)
  const bindWords = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null && words.current) words.current.value = ''
    words.current = el
  }, [])
  const [hasWords, setHasWords] = useState(false)
  const [pending, setPending] = useState<TopUpJournal | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  // The deposit is locked: the address takes no more payments for this top-up (the QR goes).
  const [locked, setLocked] = useState(false)
  const [confirm, confirmDialog] = useConfirmAction()
  const [stage, setStage] = useState<string | null>(null)
  const [seen, setSeen] = useState(0)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<bigint | null | undefined>(undefined)
  const run = useRef<AbortController | null>(null)
  // The words of the run in flight (for "Try again"); dropped with it.
  const runWords = useRef<string | null>(null)

  useEffect(() => {
    if (identity === null) return
    let live = true
    readTopUpJournal(network, identity).then(
      (j) => live && setPending(j ?? null),
      () => undefined,
    )
    return () => {
      live = false
      run.current?.abort()
      runWords.current = null
    }
  }, [identity, network])

  if (identity === null) return null

  const start = async (phrase: string): Promise<void> => {
    if (running) return
    setError(null)
    if (!(await isValidMnemonic(phrase).catch(() => false))) {
      setError(mnemonicProblem(phrase))
      return
    }
    const controller = new AbortController()
    run.current = controller
    runWords.current = phrase
    setRunning(true)
    setSeen(0)
    try {
      const sdk = await connectPlatform(network, (p: ConnectPhase) => setStage(`${PHASE_TEXT[p]}…`))
      setStage('Checking the words against your identity…')
      const { balance } = await topUpIdentity(sdk, {
        network,
        identityId: identity,
        mnemonic: phrase,
        signal: controller.signal,
        // Recorded on this device before it is shown.
        onAddress: (a, isLocked) => {
          setAddress(a)
          setLocked(isLocked)
          if (words.current) words.current.value = ''
          setHasWords(false)
        },
        onStage: (s, detail) => {
          setStage(detail ?? STAGE_TEXT[s])
          if (s !== 'waiting-deposit') setLocked(true)
        },
        onDeposit: setSeen,
      })
      runWords.current = null
      setPending(null)
      setDone(balance)
      void refreshBalance().catch(() => undefined)
    } catch (e) {
      if (!isAbort(e)) setError(errorMessage(e))
    } finally {
      if (run.current === controller) run.current = null
      setRunning(false)
    }
  }

  if (done !== undefined) {
    return (
      <p role="status" data-testid="identity-top-up-done" className="flex items-start gap-2 rounded-md border border-verify/30 bg-verify/5 px-3 py-2 text-dense text-verify-700 dark:text-verify-400">
        <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>Topped up{done !== null ? `: your balance is now ${creditsAsDash(Number(done))} DASH` : ''}. It can take a moment to show everywhere.</span>
      </p>
    )
  }

  const discard = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Give up this top-up?',
      body: "Only when it can't finish (the network never confirmed the lock, or Platform keeps refusing it). If the deposit was locked, those credits can't be added any more; anything still unspent at the address goes into your next top-up, which uses the same address.",
      confirmLabel: 'Give up',
    })
    if (!ok) return
    await discardTopUp(network, identity).catch((e: unknown) => setError(errorMessage(e)))
    runWords.current = null
    setPending(null)
    setAddress(null)
    setLocked(false)
    setError(null)
  }

  if (address !== null) {
    return (
      <div className="space-y-3" data-testid="identity-top-up-fund">
        {locked ? (
          // Locked: nothing more should be sent here for this top-up.
          <p className="text-dense" data-testid="identity-top-up-locked">
            Your deposit to <span className="break-all font-mono text-[12px]">{address}</span> is locked for Platform. Don&apos;t send more to
            this address for this top-up.
          </p>
        ) : (
          <>
            <p className="text-dense">
              Send at least <span className="font-mono">{(MIN_TOP_UP_DUFFS / 1e8).toFixed(2)} DASH</span> to this address from any Dash wallet. It
              becomes credits on your identity, less a small network fee.
            </p>
            <div className="flex justify-center">
              <Qr value={address} label={`Top-up address ${address}`} />
            </div>
            <CopyRow text={address} label="Copy the top-up address" />
            {faucet ? (
              <a href={faucet} target="_blank" rel="noreferrer noopener" className="block text-center text-dense text-forge-700 underline dark:text-forge-400">
                Get test DASH from the {ACTIVE_NETWORK.key} faucet (paste the address above)
              </a>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300" aria-live="polite">
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          <span data-testid="identity-top-up-stage">{stage ?? STAGE_TEXT['waiting-deposit']}</span>
          {seen > 0 ? (
            <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400">
              <Check className="h-3.5 w-3.5" aria-hidden /> {(seen / 1e8).toFixed(4)} DASH seen
            </span>
          ) : null}
        </div>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Keep this sheet open until it finishes. If you close it, the deposit is safe: this browser remembers it, and typing your recovery
          phrase here again finishes the top-up.
        </p>
        {error && !running ? (
          <div className="space-y-2">
            <ErrorBox error={error} />
            <Button variant="outline" className="w-full" onClick={() => runWords.current && void start(runWords.current)} disabled={runWords.current === null}>
              Try again
            </Button>
            <button type="button" onClick={() => void discard()} className="hit-area text-[12px] text-danger-700 underline dark:text-danger-400">
              Give up this top-up
            </button>
          </div>
        ) : null}
        {confirmDialog}
      </div>
    )
  }

  return (
    <form
      className="space-y-2"
      data-testid="identity-top-up"
      onSubmit={(e) => {
        e.preventDefault()
        void start(words.current?.value ?? '')
      }}
    >
      {pending ? (
        <p className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400" data-testid="identity-top-up-pending">
          A top-up to <span className="break-all font-mono">{pending.depositAddress}</span> is unfinished on this device. Enter your recovery phrase to
          finish it.
        </p>
      ) : null}
      <Field
        label="Recovery phrase"
        htmlFor="top-up-phrase"
        hint="Your identity's 12 or 24 words give this top-up its own deposit address, which only they control. Checked against your identity, never stored."
      >
        <Textarea
          id="top-up-phrase"
          ref={bindWords}
          onChange={(e) => setHasWords(e.target.value.trim() !== '')}
          className="min-h-[64px] font-mono"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
        />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={running} disabled={!hasWords || running}>
        {running && stage ? stage : pending ? 'Finish the top-up' : 'Show my top-up address'}
      </Button>
      <ErrorBox error={error} />
    </form>
  )
}
