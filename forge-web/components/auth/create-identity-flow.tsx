'use client'

/**
 * "Create a new identity" (`ux-dx-spec.md` §2.2 tile 2, §2.5):
 *   1. twelve words, shown once, with the honest backup warning;
 *   2. a quiz on three of them (the flow does not continue until they match);
 *   3. how to protect this browser's key (passkey / passphrase);
 *   4. the deposit QR + address (any Dash wallet; the faucet on dev networks), watched through
 *      the block explorer; then the asset lock, its proof, and one IdentityCreate that also
 *      registers this browser's limited key — stored in the vault before it is registered.
 * A closed tab resumes from step 4 once the same words are typed in again; an unfinished
 * creation can be discarded (after a warning when its deposit address holds funds).
 *
 * One run at a time: the run's AbortController lives in a ref, is aborted when the sheet
 * unmounts, and the buttons are disabled while a run is active.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { ErrorBox, useProtection } from '@/components/auth/protection-fields'
import { faucetUrl } from '@/components/top-up-sheet'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { ensureSdk } from '@/lib/sdk'
import { isAbort } from '@/lib/sdk/facade'
import { coreEndpoints } from '@/lib/auth/asset-lock'
import {
  clearCreationJournal,
  createIdentityFromMnemonic,
  depositAddressOf,
  depositBalance,
  readCreationJournal,
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
  const [running, setRunning] = useState(false)
  const [resumeWords, setResumeWords] = useState('')
  // Cleared as soon as a run starts (start() empties it).
  const [discardWarning, setDiscardWarning] = useState<string | null>(null)
  const { fields, protection, problem } = useProtection()
  const words = mnemonic?.split(' ') ?? []
  const run = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const j = await readCreationJournal(network)
      if (cancelled) return
      if (j) {
        setJournal(j)
        setAddress(j.depositAddress)
        setStep('resume')
        return
      }
      const m = await newMnemonic()
      if (cancelled) return
      setMnemonic(m)
      setPositions(quizPositions(12, 3))
      setStep('words')
    })()
    return () => {
      cancelled = true
      run.current?.abort()
      mnemonicRef.current = null
    }
  }, [network])

  const quizOk = positions.length === 3 && positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === words[p])

  const start = async (phrase: string): Promise<void> => {
    if (!protection || running) return
    setError(null)
    const m = normalizeMnemonic(phrase)
    if (!(await isValidMnemonic(m))) {
      setError('Those words are not a valid recovery phrase.')
      return
    }
    const deposit = await depositAddressOf(m, network)
    if (journal && journal.depositAddress !== deposit) {
      setError('These words do not match the creation in progress on this device.')
      return
    }
    const v2 = ACTIVE_NETWORK.v2
    if (!v2) {
      setError('forge-v2 is not deployed here.')
      return
    }
    const controllerRun = new AbortController()
    run.current = controllerRun
    setRunning(true)
    setAddress(deposit)
    setStep('fund')
    setResumeWords('')
    try {
      const sdk = await ensureSdk(network)
      const { identityId, key } = await createIdentityFromMnemonic(sdk, {
        network,
        mnemonic: m,
        group: v2.group,
        contracts: [v2.core, v2.collab],
        minDepositDuffs: MIN_DEPOSIT_DUFFS,
        signal: controllerRun.signal,
        persistKey: (id, k) => controller.persistKey({ identityId: id, keyId: k.keyId, wif: k.wif }, protection),
        onStage: (s, detail) => setStage(detail ?? STAGE_TEXT[s]),
        onDeposit: setSeen,
      })
      reloadVaults()
      await controller.openStored(identityId, null, key.limits)
      await clearCreationJournal(network)
      setMnemonic(null)
      onDone()
    } catch (e) {
      // Never leave an unlocked key in memory without a session.
      controller.logout()
      if (!isAbort(e)) setError(errorMessage(e))
      reloadVaults()
    } finally {
      if (run.current === controllerRun) run.current = null
      setRunning(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!journal) return
    if (discardWarning === null) {
      const held = await depositBalance(network, journal.depositAddress).catch(() => -1)
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
    await clearCreationJournal(network)
    setJournal(null)
    setDiscardWarning(null)
    setResumeWords('')
    const m = await newMnemonic()
    setMnemonic(m)
    setPositions(quizPositions(12, 3))
    setAnswers(['', '', ''])
    setStep('words')
  }

  if (step === 'loading') return <Loader2 className="h-5 w-5 animate-spin text-anvil-400" aria-label="Loading" />

  if (step === 'resume') {
    return (
      <div className="space-y-3">
        <p className="text-dense">
          An identity creation is in progress on this device (deposit address <span className="font-mono">{address}</span>). Type
          your 12 words to finish it.
        </p>
        <Field label="Your 12 words" htmlFor="resume-words">
          <Textarea id="resume-words" value={resumeWords} onChange={(e) => setResumeWords(e.target.value)} className="min-h-[72px] font-mono" spellCheck={false} autoComplete="off" />
        </Field>
        {fields}
        <Button
          variant="primary"
          className="w-full"
          loading={running}
          disabled={running || resumeWords.trim().split(/\s+/).length < 12 || protection === null}
          onClick={() => start(resumeWords)}
        >
          Continue
        </Button>
        {discardWarning ? <p className="text-dense text-caution">{discardWarning}</p> : null}
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
              <span className="text-anvil-400">{i + 1}.</span> <span data-word={i}>{w}</span>
            </li>
          ))}
        </ol>
        <div className="flex gap-2 rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution">
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
        <Button
          variant="primary"
          className="w-full"
          loading={running}
          disabled={running || protection === null || mnemonic === null}
          onClick={() => mnemonic && start(mnemonic)}
        >
          Continue to funding
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
        <ErrorBox error={error} />
      </div>
    )
  }

  const faucet = faucetUrl()
  return (
    <div className="space-y-3" data-testid="fund-step">
      <p className="text-dense">
        Send at least <span className="font-mono">0.02 DASH</span> (0.05 suggested) to this address from any Dash wallet. It becomes your
        Platform credits: ~0.0005 DASH per issue or push.
      </p>
      {address ? <Qr value={address} label={`Deposit address ${address}`} /> : null}
      {address ? <span data-testid="deposit-address" className="sr-only">{address}</span> : null}
      {faucet ? (
        <a href={faucet} target="_blank" rel="noreferrer noopener" className="block text-center text-dense text-forge-600 underline dark:text-forge-400">
          Get test DASH from the {ACTIVE_NETWORK.key} faucet
        </a>
      ) : null}
      <div className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300" aria-live="polite">
        {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        <span data-testid="create-stage">{stage ?? STAGE_TEXT['waiting-deposit']}</span>
        {seen > 0 ? (
          <span className="inline-flex items-center gap-1 text-verify">
            <Check className="h-3.5 w-3.5" aria-hidden /> {(seen / 1e8).toFixed(4)} DASH seen
          </span>
        ) : null}
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        To see your deposit this page asks a Dash block explorer ({new URL(coreEndpoints(network).insight).host}, changeable in
        Settings). It can delay you, but amounts are checked against the raw transactions, so it cannot take funds or keys. On {ACTIVE_NETWORK.key} the lock is proven once a block
        chain-locks it, which can take a few minutes.
      </p>
      {error ? <ErrorBox error={`${error} — your deposit is recorded on this device; reopen this sheet and type your 12 words to resume.`} /> : null}
    </div>
  )
}
