'use client'

/**
 * "Create a new identity" (`ux-dx-spec.md` §2.2 tile 2, §2.5):
 *   1. twelve words, shown once, with the honest backup warning;
 *   2. a quiz on three of them (the flow does not continue until they match);
 *   3. how to protect this browser's key (passkey / passphrase);
 *   4. the deposit QR + address (any Dash wallet; the faucet on dev networks), watched through
 *      the network's own nodes (DAPI); then the asset lock, its proof, and one IdentityCreate that also
 *      registers this browser's limited key — stored in the vault before it is registered.
 * A closed tab resumes from step 4 once the same words are typed in again; an unfinished
 * creation can be discarded (after a warning when its deposit address holds funds).
 *
 * One run at a time: the run's AbortController lives in a ref, is aborted when the sheet
 * unmounts, and the buttons are disabled while a run is active.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, GroupNotice, useProtection } from '@/components/auth/protection-fields'
import { StepFailed, Waiting } from '@/components/auth/step-status'
import { faucetUrl } from '@/components/top-up-sheet'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { TYPICAL_WRITE_CREDITS } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'
import { isAbort } from '@/lib/sdk/facade'
import { PHASE_TEXT, STEP_MS, connectPlatform, loadSdkLibrary, type ConnectPhase } from '@/lib/auth/connect'
import { withTimeout } from '@/lib/timeout'
import { coreEndpoints } from '@/lib/auth/asset-lock'
import {
  clearCreationJournal,
  createIdentityFromMnemonic,
  depositAddressOf,
  depositBalance,
  readCreationJournal,
  IdentityNotCreatedError,
  MIN_DEPOSIT_DUFFS,
  type CreateStage,
  type CreationJournal,
} from '@/lib/auth/create-identity'
import { isValidMnemonic, newMnemonic, normalizeMnemonic, quizPositions } from '@/lib/auth/hd'
import { errorMessage } from '@/lib/utils'

type Step = 'loading' | 'words' | 'quiz' | 'protect' | 'fund' | 'resume'

const STAGE_TEXT: Readonly<Record<CreateStage, string>> = {
  'waiting-deposit': 'Watching for your deposit…',
  locking: 'Locking the deposit for Platform…',
  proving: 'Waiting for the lock to be provable…',
  registering: 'Registering your identity…',
  verifying: 'Checking your browser key on Platform…',
}

export function CreateIdentityFlow({ onDone }: { onDone: () => void }): JSX.Element {
  const { controller, reloadVaults } = useAuth()
  const network = ACTIVE_NETWORK.network
  const [step, setStep] = useState<Step>('loading')
  // The words are the identity: held in a ref (not React state) and dropped on unmount. They
  // are rendered once for the backup, which is unavoidable; nothing else keeps them.
  const mnemonicRef = useRef<string | null>(null)
  const [wordsShown, setWordsShown] = useState(0)
  const mnemonic = wordsShown > 0 ? mnemonicRef.current : null
  const setMnemonic = (m: string | null): void => {
    mnemonicRef.current = m
    setWordsShown((n) => n + 1)
  }
  const [positions, setPositions] = useState<number[]>([])
  const [answers, setAnswers] = useState<string[]>(['', '', ''])
  const [journal, setJournal] = useState<CreationJournal | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [seen, setSeen] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The last run's IdentityCreate did not land (L-06): its message says what the deposit allows,
  // and "Try again" reuses the lock when enough of it is left ('retry').
  const [notCreated, setNotCreated] = useState<'retry' | 'final' | null>(null)
  // The words of the last run, for "Try again" (a resumed creation's words are typed, not shown).
  const runWords = useRef<string | null>(null)
  // The browser key the last run stored: when its identity turns out to exist, "Try again"
  // checks this key instead of paying for a renewal (L-06). Memory only; dropped with the words.
  const storedKey = useRef<{ identityId: string; keyId: number; wif: string } | null>(null)
  const [running, setRunning] = useState(false)
  // Checking typed words before a run (the library may still be downloading).
  const [preparing, setPreparing] = useState(false)
  const [resumeWords, setResumeWordsState] = useState('')
  // The typed words live in the textarea's value property only (a controlled textarea's value
  // is also its DOM text). Clearing the state clears the field; a fresh field starts empty.
  const resumeRef = useRef<HTMLTextAreaElement | null>(null)
  const setResumeWords = (w: string): void => {
    if (w === '' && resumeRef.current) resumeRef.current.value = ''
    setResumeWordsState(w)
  }
  const bindResume = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null && resumeRef.current) resumeRef.current.value = ''
    else if (el !== null) setResumeWordsState('')
    resumeRef.current = el
  }, [])
  // Cleared as soon as a run starts (start() empties it).
  const [discardWarning, setDiscardWarning] = useState<string | null>(null)
  const { fields, protection, problem } = useProtection()
  const words = mnemonic?.split(' ') ?? []
  const run = useRef<AbortController | null>(null)
  // The first step: this device's unfinished creation (IndexedDB), else fresh words (the
  // evo-sdk WASM). Each wait is bounded and named; a failure offers "Try again" (`attempt`).
  const [loadingWhat, setLoadingWhat] = useState('Checking this browser for a creation in progress')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    void (async () => {
      try {
        setLoadingWhat('Checking this browser for a creation in progress')
        const j = await withTimeout(readCreationJournal(network), STEP_MS, "Reading this browser's storage")
        if (cancelled) return
        if (j) {
          setJournal(j)
          setAddress(j.depositAddress)
          setStep('resume')
          return
        }
        await loadSdkLibrary(() => !cancelled && setLoadingWhat(PHASE_TEXT.downloading))
        if (cancelled) return
        setLoadingWhat('Generating your 12 words')
        const m = await withTimeout(newMnemonic(), STEP_MS, 'Generating your 12 words')
        if (cancelled) return
        setMnemonic(m)
        setPositions(quizPositions(12, 3))
        setStep('words')
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [network, attempt])

  // Unmount only: stop a running creation and drop the words.
  useEffect(
    () => () => {
      run.current?.abort()
      mnemonicRef.current = null
      runWords.current = null
      storedKey.current = null
    },
    [],
  )

  const quizOk = positions.length === 3 && positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === words[p])

  /** The deposit address of `m` once the words check out, or null with the error shown. */
  const checkWords = async (m: string): Promise<string | null> => {
    setPreparing(true)
    try {
      await loadSdkLibrary()
      if (!(await withTimeout(isValidMnemonic(m), STEP_MS, 'Checking the words'))) {
        setError('Those words are not a valid recovery phrase.')
        return null
      }
      const deposit = await withTimeout(depositAddressOf(m, network), STEP_MS, 'Deriving the deposit address')
      if (journal && journal.depositAddress !== deposit) {
        setError('These words do not match the creation in progress on this device.')
        return null
      }
      return deposit
    } catch (e) {
      setError(errorMessage(e))
      return null
    } finally {
      setPreparing(false)
    }
  }

  const start = async (phrase: string): Promise<void> => {
    if (!protection || running || preparing) return
    setError(null)
    setNotCreated(null)
    const m = normalizeMnemonic(phrase)
    const v2 = ACTIVE_NETWORK.v2
    if (!v2) {
      setError('forge-v2 is not deployed here.')
      return
    }
    const deposit = await checkWords(m)
    if (deposit === null) return
    runWords.current = m
    const controllerRun = new AbortController()
    run.current = controllerRun
    setRunning(true)
    setAddress(deposit)
    setStep('fund')
    setResumeWords('')
    try {
      const sdk = await connectPlatform(network, (p: ConnectPhase) => setStage(`${PHASE_TEXT[p]}…`))
      setStage(null)
      const { identityId, key } = await createIdentityFromMnemonic(sdk, {
        network,
        mnemonic: m,
        group: v2.group,
        trust: controller.groupTrust(),
        minDepositDuffs: MIN_DEPOSIT_DUFFS,
        signal: controllerRun.signal,
        persistKey: async (id, k, o) => {
          await controller.persistKey({ identityId: id, keyId: k.keyId, wif: k.wif }, protection, o)
          // A staged key (a renewal in flight) is not the key this browser holds yet.
          if (!o?.staged) storedKey.current = { identityId: id, keyId: k.keyId, wif: k.wif }
        },
        // This sheet's own run first; else (the sheet was reopened) the key the vault holds for
        // the identity, opened with the protection chosen now.
        heldKey: async (id) => (storedKey.current?.identityId === id ? storedKey.current : controller.storedKeyFor(id, protection)),
        onStage: (s, detail) => setStage(detail ?? STAGE_TEXT[s]),
        onDeposit: setSeen,
        onCharge: (id, charge) => controller.reportCharge(id, charge),
      })
      reloadVaults()
      await controller.openStored(identityId, null, key.limits)
      await clearCreationJournal(network)
      setMnemonic(null)
      runWords.current = null
      storedKey.current = null
      onDone()
    } catch (e) {
      // Never leave an unlocked key in memory without a session.
      controller.logout()
      if (!isAbort(e)) {
        setError(errorMessage(e))
        setNotCreated(e instanceof IdentityNotCreatedError ? (e.retryable ? 'retry' : 'final') : null)
      }
      reloadVaults()
    } finally {
      if (run.current === controllerRun) run.current = null
      setRunning(false)
    }
  }

  const discard = async (): Promise<void> => {
    // A creation that failed in this sheet has no `journal` state yet: read it.
    const current = journal ?? (await readCreationJournal(network).catch(() => undefined))
    if (!current) return
    setError(null)
    setNotCreated(null)
    runWords.current = null
    storedKey.current = null
    try {
      if (discardWarning === null) {
        const held = await withTimeout(depositBalance(network, current), STEP_MS, 'Checking the deposit address').catch(() => -1)
        if (held !== 0) {
          setDiscardWarning(
            held > 0
              ? `The deposit address still holds ${(held / 1e8).toFixed(4)} DASH. Discarding forgets this creation; only your 12 words can recover those funds. Discard anyway?`
              : "Couldn't check the deposit address for funds. If you sent any, only your 12 words can recover them. Discard anyway?",
          )
          return
        }
      }
      run.current?.abort()
      await withTimeout(clearCreationJournal(network), STEP_MS, "Updating this browser's storage")
      setJournal(null)
      setDiscardWarning(null)
      setResumeWords('')
      // Fresh words come from the loading step (bounded, with "Try again").
      setAnswers(['', '', ''])
      setStep('loading')
      setAttempt((a) => a + 1)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (step === 'loading') {
    return loadError ? (
      <StepFailed error={loadError} onRetry={() => setAttempt((a) => a + 1)} />
    ) : (
      <Waiting label={loadingWhat} />
    )
  }

  if (step === 'resume') {
    return (
      <div className="space-y-3" data-testid="create-resume">
        <p className="text-dense">
          An identity creation is in progress on this device (deposit address <span className="font-mono">{address}</span>). Type
          your 12 words to finish it.
        </p>
        <Field label="Your 12 words" htmlFor="resume-words">
          <Textarea id="resume-words" ref={bindResume} onChange={(e) => setResumeWordsState(e.target.value)} className="min-h-[72px] font-mono" spellCheck={false} autoComplete="off" />
        </Field>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          loading={running || preparing}
          disabled={running || preparing || resumeWords.trim().split(/\s+/).length < 12 || protection === null}
          onClick={() => start(resumeWords)}
        >
          Continue
        </Button>
        {discardWarning ? <p className="text-dense text-caution-700 dark:text-caution-400">{discardWarning}</p> : null}
        <Button variant="ghost" size="sm" disabled={running} onClick={discard}>
          {discardWarning ? 'Discard anyway' : 'Discard this creation'}
        </Button>
        <ErrorBox error={error} />
      </div>
    )
  }

  if (step === 'words') {
    return (
      <div className="space-y-3">
        <p className="text-dense font-medium">Write these 12 words down, in order, on paper.</p>
        <ol data-testid="mnemonic-words" className="grid grid-cols-3 gap-1.5 rounded-md border border-anvil-200 p-3 font-mono text-dense dark:border-anvil-800">
          {words.map((w, i) => (
            <li key={i}>
              <span className="text-anvil-500 dark:text-anvil-400">{i + 1}.</span> <span data-word={i}>{w}</span>
            </li>
          ))}
        </ol>
        <div className="flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The 12 words are the identity. Lose them and nobody can recover it. Keep them offline; Forge only ever keeps a limited
            key in this browser.
          </span>
        </div>
        <Button variant="primary" className="w-full" disabled={words.length === 0} onClick={() => setStep('quiz')}>
          I wrote them down
        </Button>
      </div>
    )
  }

  if (step === 'quiz') {
    return (
      <div className="space-y-3">
        <p className="text-dense">Check your backup: type these words.</p>
        {positions.map((p, i) => (
          <Field key={p} label={`Word ${p + 1}`} htmlFor={`quiz-${p}`}>
            <Input
              id={`quiz-${p}`}
              value={answers[i] ?? ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </Field>
        ))}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setStep('words')}>
            Show words again
          </Button>
          <Button variant="primary" className="flex-1" disabled={!quizOk} onClick={() => setStep('protect')}>
            Continue
          </Button>
        </div>
      </div>
    )
  }

  if (step === 'protect') {
    return (
      <div className="space-y-3">
        {fields}
        <GroupNotice check={() => controller.checkGroup()} />
        <Button
          variant="primary"
          className="w-full"
          loading={running || preparing}
          disabled={running || preparing || protection === null || mnemonic === null}
          onClick={() => mnemonic && start(mnemonic)}
        >
          Continue to funding
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{problem}</p> : null}
        <ErrorBox error={error} />
      </div>
    )
  }

  const faucet = faucetUrl()
  return (
    <div className="space-y-3" data-testid="fund-step">
      <p className="text-dense">
        Send at least <span className="font-mono">0.02 DASH</span> (0.05 suggested) to this address from any Dash wallet. It becomes your
        Platform credits: about {creditsAsDash(TYPICAL_WRITE_CREDITS)} DASH per issue or push.
      </p>
      {address ? <Qr value={address} label={`Deposit address ${address}`} /> : null}
      {address ? <span data-testid="deposit-address" className="sr-only">{address}</span> : null}
      {faucet ? (
        <a href={faucet} target="_blank" rel="noreferrer noopener" className="block text-center text-dense text-forge-700 underline dark:text-forge-400">
          Get test DASH from the {ACTIVE_NETWORK.key} faucet
        </a>
      ) : null}
      <div className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300" aria-live="polite">
        {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        <span data-testid="create-stage">{stage ?? STAGE_TEXT['waiting-deposit']}</span>
        {seen > 0 ? (
          <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400">
            <Check className="h-3.5 w-3.5" aria-hidden /> {(seen / 1e8).toFixed(4)} DASH seen
          </span>
        ) : null}
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        This page watches for your deposit through the Dash network&apos;s own nodes, and asks a block explorer (
        {new URL(coreEndpoints(network).insight).host}, changeable in Settings) only if they cannot answer. Amounts are checked against the raw
        transactions, so neither can take funds or keys. On {ACTIVE_NETWORK.key} the lock is proven once a block chain-locks it, which can take a few
        minutes.
      </p>
      {error && !running && notCreated === 'final' ? (
        // Nothing left to retry with: this deposit cannot create the identity.
        <div className="space-y-3" data-testid="signin-failed">
          <ErrorBox error={error} />
          <p className="text-dense text-anvil-600 dark:text-anvil-300">
            Discard this creation and start again: new words and a new deposit of at least 0.02 DASH.
          </p>
          {discardWarning ? <p className="text-dense text-caution-700 dark:text-caution-400">{discardWarning}</p> : null}
          <Button variant="outline" className="w-full" onClick={discard}>
            {discardWarning ? 'Discard anyway' : 'Discard this creation'}
          </Button>
        </div>
      ) : error && !running ? (
        <StepFailed
          {...(notCreated === 'retry'
            ? { error, retryLabel: 'Try again with the same deposit' }
            : { error: `${error} — anything you sent is recorded on this device: "Try again" resumes (or reopen this sheet later and type your 12 words).` })}
          onRetry={() => {
            const words = runWords.current ?? mnemonic
            if (words) void start(words)
            else {
              setStep('loading')
              setAttempt((a) => a + 1)
            }
          }}
        />
      ) : null}
    </div>
  )
}
