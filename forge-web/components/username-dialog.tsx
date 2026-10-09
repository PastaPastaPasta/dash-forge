'use client'

/**
 * "Choose a username" (#452): pick a DPNS name, see whether it is free and what it costs, and
 * register it here, or copy the `dg` command that does.
 *
 * - The name is checked as typed against Platform's rules (`@/lib/view/username`), then, once
 *   typing pauses, by ONE read of the DPNS `domain` index (`dpnsLabelHolder`; a failed read says
 *   so and never reads as "free").
 * - A contested name (3-19 characters of only letters, 0, 1 and `-`) goes to a masternode vote:
 *   0.1 DASH into the contest and a 2-week vote on mainnet (90 minutes elsewhere). Like `dg`, the
 *   web does not enter one: it says why and offers names that are not contested.
 * - Registering signs a preorder and a domain with the identity's own CRITICAL (else HIGH) key,
 *   from the identity file or the recovery phrase, given once and not stored (this browser's key
 *   is bound to the Forge contracts and Platform refuses it on DPNS: `@/lib/auth/username-register`).
 *   The fee comes from the identity balance and lands in Settings → Spend.
 * - Registered elsewhere (the `dg` command)? "I've registered it — check again" reads the
 *   identity's name and, found, shows it everywhere in this tab.
 *
 * The caller mounts this only while it is open: closing drops what was typed or given.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Copy, Loader2, XCircle } from 'lucide-react'

import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ErrorBox } from '@/components/auth/protection-fields'
import { useMasterKeyInput } from '@/components/auth/master-key-input'
import { useAuth } from '@/contexts/auth-context'
import { useCopy } from '@/hooks/use-copy'
import { useSdk } from '@/hooks/use-sdk'
import { NAME_CONTEST_FUND_CREDITS, NAME_REGISTER_CREDITS, NAME_REGISTER_FLOOR_CREDITS, previewCredits } from '@/lib/sdk'
import { dpnsLabelHolder, lookupDpnsName } from '@/lib/view/dpns'
import { checkUsername, nameRegisterCommand, uncontestedVariants } from '@/lib/view/username'
import { identityHref } from '@/lib/view/profile-links'
import { creditsAsDash } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

/** How long typing must pause before the name is read (one read per pause, not per key). */
export const AVAILABILITY_DEBOUNCE_MS = 400

/** The preview: the measured charge to the bound `dg` quotes. */
const COST = { ...previewCredits(NAME_REGISTER_CREDITS), minCredits: NAME_REGISTER_FLOOR_CREDITS }

/** What the one read said about the name typed. */
type Availability =
  | { readonly label: string; readonly state: 'checking' }
  | { readonly label: string; readonly state: 'free' }
  | { readonly label: string; readonly state: 'taken'; readonly mine: boolean }
  | { readonly label: string; readonly state: 'failed'; readonly error: string }

export function UsernameDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { identity, balance, registerUsername, isLoading } = useAuth()
  const { sdk, ready, network } = useSdk()
  const [typed, setTyped] = useState('')
  const check = checkUsername(typed)
  const label = check.kind === 'ok' ? check.label : null
  const [availability, setAvailability] = useState<Availability | null>(null)
  // Bumped by "Check again" after a failed read: the same name is read once more.
  const [attempt, setAttempt] = useState(0)
  const master = useMasterKeyInput(identity, { id: 'username', fileLabel: 'Identity file for the username' })
  const [submitError, setSubmitError] = useState<string | null>(null)
  // The name now this identity's, and whether this dialog signed for it (else it was found by a re-read).
  const [done, setDone] = useState<{ readonly name: string; readonly signed: boolean } | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [recheckNote, setRecheckNote] = useState<string | null>(null)

  useEffect(() => {
    if (label === null || !ready || !sdk) return
    let live = true
    setAvailability({ label, state: 'checking' })
    const timer = setTimeout(() => {
      dpnsLabelHolder(sdk, label, network).then(
        (holder) => live && setAvailability(holder === null ? { label, state: 'free' } : { label, state: 'taken', mine: holder === identity }),
        (e: unknown) => live && setAvailability({ label, state: 'failed', error: errorMessage(e) }),
      )
    }, AVAILABILITY_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [label, sdk, ready, network, identity, attempt])

  // Only the answer for the name in the field counts (a late answer for an earlier one does not).
  const shown = availability !== null && availability.label === label ? availability : null
  const lowBalance = balance !== null && BigInt(balance) < BigInt(NAME_REGISTER_CREDITS)
  const canSign = label !== null && shown?.state === 'free' && master.ready && !lowBalance && !isLoading
  const error = master.error ?? submitError

  const submit = async (): Promise<void> => {
    if (!canSign || label === null) return
    setSubmitError(null)
    try {
      setDone({ name: await registerUsername(master.take(), label), signed: true })
    } catch (e) {
      setSubmitError(errorMessage(e))
    }
  }

  /** After registering elsewhere: read this identity's name (no signature, no fee). */
  const checkAgain = async (): Promise<void> => {
    if (!sdk || identity === null) return
    setRechecking(true)
    setRecheckNote(null)
    try {
      const name = await lookupDpnsName(sdk, identity, network)
      if (name !== null) setDone({ name, signed: false })
      else setRecheckNote('No username for this identity yet. A registration can take a few seconds to show; try again in a moment.')
    } catch (e) {
      setRecheckNote(`Couldn't read your username (${errorMessage(e)}). Try again in a moment.`)
    } finally {
      setRechecking(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="Choose a username" description="A DPNS name for your identity, shown instead of its id.">
      {done !== null ? (
        <div className="space-y-3 text-dense" data-testid="username-done" role="status">
          <p className="flex items-center gap-2 text-verify-700 dark:text-verify-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> <span><span className="font-mono font-medium">{done.name}</span> is your username.</span>
          </p>
          <p className="text-anvil-600 dark:text-anvil-300">
            It shows in the header, on your profile and in links to your repositories (
            <span className="font-mono">/{done.name.replace(/\.dash$/, '')}/project</span>, <span className="font-mono">@{done.name.replace(/\.dash$/, '')}</span>).
          </p>
          {done.signed ? (
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Your key was used for this one registration and was not stored.</p>
          ) : null}
          <div className="flex gap-2">
            {identity !== null ? (
              <Link href={identityHref(identity)} onClick={onClose} className="inline-flex flex-1 items-center justify-center rounded-md border border-anvil-200 px-3 py-2 text-dense font-medium coarse:min-h-11 dark:border-anvil-750">
                Your profile
              </Link>
            ) : null}
            <Button variant="primary" className="flex-1" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4 text-dense"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Username" htmlFor="username-input">
            <div className="flex items-center gap-1.5">
              <Input
                id="username-input"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value)
                  setSubmitError(null)
                }}
                className="font-mono"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={80}
                aria-invalid={check.kind === 'invalid'}
                aria-describedby="username-status"
                data-testid="username-input"
                autoFocus
              />
              <span className="shrink-0 font-mono text-anvil-500 dark:text-anvil-400">.dash</span>
            </div>
          </Field>

          <div id="username-status" aria-live="polite" className="min-h-5" data-testid="username-status">
            <NameStatus check={check} shown={shown} onPick={setTyped} onRetry={() => setAttempt((n) => n + 1)} />
          </div>

          {label !== null && shown?.state === 'free' ? (
            <>
              {master.element}
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
                Your identity&apos;s own key signs this once (from its file or recovery phrase) and is not stored. This browser&apos;s
                key can&apos;t: Platform keeps it to Dash Forge&apos;s contracts. The fee comes from your identity balance.
              </p>
              <CostPreview cost={COST} />
              {lowBalance ? (
                <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="username-low-balance">
                  Your balance ({creditsAsDash(Number(balance))} DASH) is below the {creditsAsDash(NAME_REGISTER_CREDITS)} DASH a registration may take. Top up first.
                </p>
              ) : null}
              <ErrorBox error={error} />
              <Button type="submit" variant="primary" className="w-full" loading={isLoading} disabled={!canSign} data-testid="username-register">
                Sign once &amp; register {label}.dash
              </Button>
            </>
          ) : null}

          <TerminalRoute label={label ?? ''} onCheckAgain={() => void checkAgain()} rechecking={rechecking} note={recheckNote} />
        </form>
      )}
    </Dialog>
  )
}

/** The line under the field: why the name can't be, is contested, is being read, is free or taken. */
function NameStatus({
  check,
  shown,
  onPick,
  onRetry,
}: {
  check: ReturnType<typeof checkUsername>
  shown: Availability | null
  onPick: (name: string) => void
  onRetry: () => void
}): JSX.Element {
  const muted = 'text-[12px] text-anvil-500 dark:text-anvil-400'
  if (check.kind === 'empty') return <p className={muted}>3–63 letters, digits and “-”. Case is kept; lookups ignore it.</p>
  if (check.kind === 'invalid') return <p className="text-[12px] text-danger-700 dark:text-danger-400">{check.reason}</p>
  if (check.kind === 'contested') {
    const variants = uncontestedVariants(check.label)
    return (
      <div className="space-y-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2" data-testid="username-contested">
        <p className="text-caution-800 dark:text-caution-300">
          <span className="font-mono font-medium">{check.label}.dash</span> is a contested name.
        </p>
        <p className="text-[12px] text-anvil-700 dark:text-anvil-200">
          Names of 3–19 characters made only of letters, 0, 1 and “-” go to a masternode vote: {creditsAsDash(NAME_CONTEST_FUND_CREDITS)} DASH
          to enter, two weeks on mainnet (90 minutes on test networks), and someone else can win it.
        </p>
        <p className="text-[12px] text-anvil-700 dark:text-anvil-200">
          Dash Forge doesn&apos;t enter votes. Add a digit other than 0 or 1, or use 20 or more characters:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {variants.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onPick(v)}
              className="rounded-full border border-anvil-200 px-2.5 py-0.5 font-mono text-[12px] hover:bg-anvil-100 coarse:min-h-11 dark:border-anvil-750 dark:hover:bg-anvil-800"
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (shown === null || shown.state === 'checking') {
    return (
      <p className={`flex items-center gap-1.5 ${muted}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking {check.label}.dash…
      </p>
    )
  }
  if (shown.state === 'free') {
    return (
      <p className="flex items-center gap-1.5 text-verify-700 dark:text-verify-400" data-testid="username-free">
        <CheckCircle2 className="h-4 w-4" aria-hidden /> <span><span className="font-mono">{check.label}.dash</span> is available.</span>
      </p>
    )
  }
  if (shown.state === 'taken') {
    return (
      <p className="flex items-center gap-1.5 text-danger-700 dark:text-danger-400" data-testid="username-taken">
        <XCircle className="h-4 w-4" aria-hidden />
        <span>
          <span className="font-mono">{check.label}.dash</span> {shown.mine ? 'is already yours.' : 'is taken. Try another.'}
        </span>
      </p>
    )
  }
  return (
    <p className="text-[12px] text-caution-700 dark:text-caution-400" data-testid="username-check-failed">
      Couldn&apos;t check {check.label}.dash ({shown.error}).{' '}
      <button type="button" onClick={onRetry} className="hit-area underline">
        Check again
      </button>
    </p>
  )
}

/** Registering with `dg` instead, and the re-read for a name registered that way. */
function TerminalRoute({ label, onCheckAgain, rechecking, note }: { label: string; onCheckAgain: () => void; rechecking: boolean; note: string | null }): JSX.Element {
  const command = nameRegisterCommand(label)
  const [copied, copy] = useCopy(command)
  return (
    <details className="rounded-md border border-anvil-200 px-3 py-2 dark:border-anvil-750" data-testid="username-terminal">
      <summary className="cursor-pointer text-anvil-600 coarse:min-h-11 coarse:py-2 dark:text-anvil-300">Or register it from a terminal</summary>
      <div className="mt-2 space-y-2">
        <div className="flex items-start gap-2 rounded bg-anvil-100 px-2 py-1.5 dark:bg-anvil-800">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-anvil-800 dark:text-anvil-100" data-testid="username-command">{command}</code>
          <button type="button" onClick={() => void copy()} className="hit-area shrink-0 text-anvil-500 hover:text-anvil-800 dark:text-anvil-400 dark:hover:text-anvil-100" aria-label="Copy the command">
            <Copy className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          {copied ? 'Copied. ' : ''}Leave out <span className="font-mono">--master</span> to type the recovery phrase instead. Then come back:
        </p>
        <Button type="button" variant="outline" className="w-full" loading={rechecking} onClick={onCheckAgain} data-testid="username-check-again">
          I&apos;ve registered it — check again
        </Button>
        {note ? <p className="text-[12px] text-anvil-600 dark:text-anvil-300" role="status">{note}</p> : null}
      </div>
    </details>
  )
}
