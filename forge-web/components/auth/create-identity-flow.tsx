'use client'

/**
 * "Create a new identity" (`ux-dx-spec.md` §2.2 tile 2, §2.5):
 *   1. twelve words, shown once, with the honest backup warning;
 *   2. a quiz on three of them (the flow does not continue until they match);
 *   3. how to protect this browser's key (passkey / passphrase);
 *   4. the deposit QR + address (any Dash wallet; the faucet on dev networks), watched through
 *      the block explorer; then the asset lock, its proof, and one IdentityCreate that also
 *      registers this browser's limited key.
 * A closed tab resumes from step 4 once the same words are typed in again.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Qr } from '@/components/ui/qr'
import { useProtection } from '@/components/auth/protection-fields'
import { faucetUrl } from '@/components/top-up-sheet'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { errorMessage } from '@/lib/utils'

type Step = 'words' | 'quiz' | 'protect' | 'fund' | 'resume'

const STAGE_TEXT: Readonly<Record<string, string>> = {
  'waiting-deposit': 'Watching for your deposit…',
  locking: 'Locking the deposit for Platform…',
  proving: 'Waiting for the lock to be provable…',
  registering: 'Registering your identity…',
  verifying: 'Checking your browser key on Platform…',
}

export function CreateIdentityFlow({ onDone }: { onDone: () => void }): JSX.Element {
  const { adoptLimitedKey } = useAuth()
  const [step, setStep] = useState<Step>('words')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [positions, setPositions] = useState<number[]>([])
  const [answers, setAnswers] = useState<string[]>(['', '', ''])
  const [address, setAddress] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [seen, setSeen] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [resumeWords, setResumeWords] = useState('')
  const { fields, protection, problem } = useProtection('new identity')
  const words = useMemo(() => mnemonic?.split(' ') ?? [], [mnemonic])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { readCreationJournal } = await import('@/lib/auth/create-identity')
      const j = await readCreationJournal(DEFAULT_NETWORK)
      if (cancelled) return
      if (j) {
        setAddress(j.depositAddress)
        setStep('resume')
        return
      }
      const { newMnemonic, quizPositions } = await import('@/lib/auth/hd')
      const m = await newMnemonic()
      if (cancelled) return
      setMnemonic(m)
      setPositions(quizPositions(12, 3))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Forget the words when the flow closes.
  useEffect(() => () => setMnemonic(null), [])

  const quizOk = positions.length === 3 && positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === words[p])

  const run = async (m: string): Promise<void> => {
    if (!protection) return
    setError(null)
    const controller = new AbortController()
    try {
      const { evoSdkService } = await import('@/lib/sdk')
      const { createIdentityFromMnemonic, depositAddressOf, MIN_DEPOSIT_DUFFS } = await import('@/lib/auth/create-identity')
      const v2 = ACTIVE_NETWORK.v2
      if (!v2) throw new Error('forge-v2 is not deployed here')
      setAddress(await depositAddressOf(m, DEFAULT_NETWORK))
      setStep('fund')
      const { identityId, key } = await createIdentityFromMnemonic(evoSdkService.getSdk(), {
        network: DEFAULT_NETWORK,
        mnemonic: m,
        group: v2.group,
        minDepositDuffs: MIN_DEPOSIT_DUFFS,
        signal: controller.signal,
        onStage: (s, detail) => setStage(detail ?? STAGE_TEXT[s] ?? s),
        onDeposit: setSeen,
      })
      await adoptLimitedKey(identityId, key, protection)
      setMnemonic(null)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

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
        <Button variant="primary" className="w-full" disabled={resumeWords.trim().split(/\s+/).length < 12 || protection === null} onClick={() => run(resumeWords)}>
          Continue
        </Button>
        {stage ? <p className="text-dense text-anvil-500">{stage}</p> : null}
        {error ? <p role="alert" className="text-dense text-danger">{error}</p> : null}
      </div>
    )
  }

  if (step === 'words') {
    return (
      <div className="space-y-3">
        <p className="text-dense font-medium">Write these 12 words down, in order, on paper.</p>
        {words.length === 0 ? (
          <Loader2 className="h-5 w-5 animate-spin text-anvil-400" aria-label="Generating" />
        ) : (
          <ol data-testid="mnemonic-words" className="grid grid-cols-3 gap-1.5 rounded-md border border-anvil-200 p-3 font-mono text-dense dark:border-anvil-800">
            {words.map((w, i) => (
              <li key={i}>
                <span className="text-anvil-400">{i + 1}.</span> <span data-word={i}>{w}</span>
              </li>
            ))}
          </ol>
        )}
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
        <Button variant="primary" className="w-full" disabled={protection === null || mnemonic === null} onClick={() => mnemonic && run(mnemonic)}>
          Continue to funding
        </Button>
        {problem ? <p className="text-[12px] text-anvil-500">{problem}</p> : null}
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
        {error ? null : <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        <span data-testid="create-stage">{stage ?? STAGE_TEXT['waiting-deposit']}</span>
        {seen > 0 ? (
          <span className="inline-flex items-center gap-1 text-verify">
            <Check className="h-3.5 w-3.5" aria-hidden /> {(seen / 1e8).toFixed(4)} DASH seen
          </span>
        ) : null}
      </div>
      <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
        To see your deposit this page asks a Dash block explorer ({new URL(coreHost()).host}). It can delay you but cannot take funds or
        keys. On {ACTIVE_NETWORK.key} the lock is proven once a block chain-locks it, which can take a few minutes.
      </p>
      {error ? (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">
          {error} — your deposit is safe; reopen this sheet to resume.
        </div>
      ) : null}
    </div>
  )
}

function coreHost(): string {
  return ACTIVE_NETWORK.network === 'devnet'
    ? `https://insight.${ACTIVE_NETWORK.devnetName}.networks.dash.org`
    : ACTIVE_NETWORK.network === 'testnet'
      ? 'https://insight.testnet.networks.dash.org'
      : 'https://insight.dash.org'
}
