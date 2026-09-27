'use client'

/**
 * Top up this browser's key (`ux-dx-spec.md` §2.3; `IdentityKeyLimitsUpdate`, protocol 14):
 * add budget to the key this browser signs with and, optionally, push its expiry out. The key
 * id and the private key stay the same. The master key comes from the identity file or the
 * recovery phrase, signs this one update, and is not stored (the file text lives in a ref, not
 * React state, and is dropped after use; the caller mounts this only while it is open, so
 * closing unmounts it and drops everything).
 */

import { useRef, useState } from 'react'
import { create } from 'zustand'
import { CheckCircle2, KeyRound, Upload } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ErrorBox } from '@/components/auth/protection-fields'
import { TOP_UP_DEFAULTS, TOP_UP_MAX_DAYS, TopUpPendingError, masterMaterialFromFile, parseDashAmount, topUpExpiry } from '@/lib/auth'
import { KEY_LIMITS_UPDATE_CREDITS, previewCredits } from '@/lib/sdk'
import type { KeyLimits } from '@/lib/view/funds'
import { creditsAsDash, formatDate } from '@/lib/view/format'
import { cn, errorMessage } from '@/lib/utils'

const DAY_MS = 24 * 60 * 60 * 1000

/** `yyyy-mm-dd` for a date input, in local time. */
function isoDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A date input's value as end-of-day local time (ms), or null when empty / invalid. */
function fromIsoDay(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (m === null) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0).getTime()
}

interface PendingTopUp {
  readonly before: KeyLimits | null
  readonly message: string
}

/**
 * Top-ups sent but not yet seen on chain, per identity. Module-level so closing and reopening
 * the dialog still shows "sent, check again" instead of a form that could send a second
 * `IdentityKeyLimitsUpdate`. Cleared once the chain shows limits different from `before`.
 */
const usePendingTopUps = create<{ byIdentity: Readonly<Record<string, PendingTopUp>> }>(() => ({ byIdentity: {} }))

function setPendingTopUp(identity: string, pending: PendingTopUp | null): void {
  const { [identity]: _dropped, ...rest } = usePendingTopUps.getState().byIdentity
  usePendingTopUps.setState({ byIdentity: pending === null ? rest : { ...rest, [identity]: pending } })
}

export function KeyTopUpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { identity, keyLimits, topUpKey, refreshBalance, isLoading } = useAuth()
  const [amount, setAmount] = useState(String(TOP_UP_DEFAULTS.addDash))
  const current = keyLimits?.expiresAt ?? null
  const suggested = Date.now() + TOP_UP_DEFAULTS.days * DAY_MS
  const [extend, setExtend] = useState(current === null || current < suggested)
  const [expiry, setExpiry] = useState(isoDay(suggested))
  const [mode, setMode] = useState<'file' | 'mnemonic'>('file')
  const fileRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  // The recovery phrase never enters React state: an uncontrolled textarea, read at submit
  // and cleared afterwards. Only "something was typed" is state.
  const phraseRef = useRef<HTMLTextAreaElement>(null)
  const [phraseTyped, setPhraseTyped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ before: KeyLimits | null; after: KeyLimits } | null>(null)
  // Sent, but not visible on chain yet: re-read, never re-send (kept across close / reopen).
  const pending = usePendingTopUps((s) => (identity === null ? null : s.byIdentity[identity] ?? null))
  const setPending = (p: PendingTopUp | null): void => {
    if (identity !== null) setPendingTopUp(identity, p)
  }
  const [checking, setChecking] = useState(false)

  let credits: bigint | null = null
  let amountError: string | null = null
  if (amount.trim() !== '') {
    try {
      credits = parseDashAmount(amount)
    } catch (e) {
      amountError = errorMessage(e)
    }
  }
  let newExpiry: number | null = null
  let expiryError: string | null = null
  if (extend) {
    try {
      newExpiry = topUpExpiry(current, fromIsoDay(expiry))
      if (newExpiry === null) expiryError = 'pick a date later than the current expiry, or leave the expiry as it is'
    } catch (e) {
      expiryError = errorMessage(e)
    }
  }
  const hasMaster = mode === 'file' ? fileName !== '' : phraseTyped
  const changes = credits !== null || newExpiry !== null
  const ready = hasMaster && changes && amountError === null && expiryError === null && !isLoading

  const onFile = async (f: File): Promise<void> => {
    setError(null)
    const text = await f.text()
    try {
      const m = masterMaterialFromFile(text)
      if (m.identityId !== identity) throw new Error('that identity file is for another identity')
      fileRef.current = text
      setFileName(f.name)
    } catch (e) {
      fileRef.current = null
      setFileName('')
      setError(errorMessage(e))
    }
  }

  const clearSecrets = (): void => {
    fileRef.current = null
    setFileName('')
    if (phraseRef.current) phraseRef.current.value = ''
    setPhraseTyped(false)
  }

  const submit = async (): Promise<void> => {
    if (!ready) return
    setError(null)
    const before = keyLimits
    try {
      const input = mode === 'file' ? { fileText: fileRef.current ?? '' } : { mnemonic: phraseRef.current?.value ?? '' }
      const after = await topUpKey(input, { addCredits: credits, expiresAt: newExpiry })
      setDone({ before, after })
    } catch (e) {
      if (e instanceof TopUpPendingError) setPending({ before, message: e.message })
      else setError(errorMessage(e))
    } finally {
      clearSecrets()
    }
  }

  /** Re-read the key (no signature, no fee): did the sent update land? */
  const checkAgain = async (): Promise<void> => {
    if (pending === null) return
    setChecking(true)
    try {
      await refreshBalance()
    } finally {
      setChecking(false)
    }
  }
  // After a refresh, the session's limits show whether the update landed.
  const landed =
    pending !== null &&
    keyLimits !== null &&
    ((keyLimits.total ?? 0n) !== (pending.before?.total ?? 0n) || keyLimits.expiresAt !== (pending.before?.expiresAt ?? null))
  // Once the chain shows the change, the marker has done its job; this view stays until Close.
  const closeDialog = (): void => {
    if (landed) setPending(null)
    onClose()
  }

  const dash = (c: bigint | null): string => (c === null ? '—' : `${creditsAsDash(Number(c))} DASH`)

  return (
    <Dialog open onClose={closeDialog} title="Top up this browser's key" description="Same key, more budget or a later expiry.">
      {pending !== null && done === null ? (
        <div className="space-y-3 text-dense" data-testid="key-top-up-pending" role="status">
          {landed ? (
            <p className="flex items-center gap-2 text-verify-700 dark:text-verify-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> The update landed: this key now has{' '}
              {dash(keyLimits?.total ?? null)} of budget
              {keyLimits?.expiresAt ? `, until ${formatDate(keyLimits.expiresAt)}` : ''}.
            </p>
          ) : (
            <>
              <p className="text-caution-700 dark:text-caution-400">
                The update was sent, but the chain does not show the new limits yet. Do not send it again: a second top-up would
                add the budget twice.
              </p>
              <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{pending.message}</p>
            </>
          )}
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Your master key was used once and was not stored.</p>
          <div className="flex gap-2">
            {landed ? null : (
              <Button variant="outline" className="flex-1" loading={checking} onClick={() => void checkAgain()}>
                Check again
              </Button>
            )}
            <Button variant="primary" className="flex-1" onClick={closeDialog}>
              Close
            </Button>
          </div>
        </div>
      ) : done ? (
        <div className="space-y-3 text-dense" data-testid="key-top-up-done">
          <p className="flex items-center gap-2 text-verify-700 dark:text-verify-400">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Key limits updated on chain.
          </p>
          <dl className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1">
            <dt />
            <dd className="text-anvil-500 dark:text-anvil-400">Before</dd>
            <dd className="text-anvil-500 dark:text-anvil-400">Now (read back from the chain)</dd>
            <dt className="text-anvil-500 dark:text-anvil-400">Budget</dt>
            <dd className="font-mono">{dash(done.before?.total ?? null)}</dd>
            <dd className="font-mono" data-testid="key-top-up-total">{dash(done.after.total)}</dd>
            <dt className="text-anvil-500 dark:text-anvil-400">Left</dt>
            <dd className="font-mono">{dash(done.before?.remaining ?? null)}</dd>
            <dd className="font-mono">{dash(done.after.remaining)}</dd>
            <dt className="text-anvil-500 dark:text-anvil-400">Expires</dt>
            <dd>{done.before?.expiresAt ? formatDate(done.before.expiresAt) : '—'}</dd>
            <dd>{done.after.expiresAt ? formatDate(done.after.expiresAt) : 'never'}</dd>
          </dl>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Your master key was used for this one update and was not stored.</p>
          <Button variant="primary" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4 text-dense"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="text-anvil-600 dark:text-anvil-300">
            Adds budget to the key this browser already signs with, so nothing here has to be re-imported. Your master key
            signs this one update and is not stored. The fee comes from your identity balance.
          </p>
          <Field label="Add to the budget (DASH)" htmlFor="topup-amount" hint={keyLimits?.total != null ? `Now ${dash(keyLimits.remaining)} left of ${dash(keyLimits.total)}.` : undefined}>
            <Input id="topup-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" autoComplete="off" aria-invalid={amountError !== null} />
          </Field>
          {amountError ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{amountError}</p> : null}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={extend} onChange={(e) => setExtend(e.target.checked)} className="h-4 w-4 accent-forge-600" />
              <span>Extend the expiry{current !== null ? ` (now ${formatDate(current)})` : ''}</span>
            </label>
            {extend ? (
              <Field label="New expiry" htmlFor="topup-expiry">
                <Input id="topup-expiry" type="date" value={expiry} min={isoDay(Date.now() + DAY_MS)} max={isoDay(Date.now() + TOP_UP_MAX_DAYS * DAY_MS)} onChange={(e) => setExpiry(e.target.value)} aria-invalid={expiryError !== null} />
              </Field>
            ) : null}
            {expiryError ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{expiryError}</p> : null}
          </div>

          <fieldset className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
            <legend className="px-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">
              <KeyRound className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Master key, used once
            </legend>
            <div role="group" aria-label="Master key source" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
              {(['file', 'mnemonic'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cn('rounded px-3 py-1 text-dense font-medium', mode === m ? 'bg-forge-500/15 text-forge-800 dark:text-forge-300' : 'text-anvil-600 dark:text-anvil-300')}
                >
                  {m === 'file' ? 'Identity file' : 'Recovery phrase'}
                </button>
              ))}
            </div>
            {mode === 'file' ? (
              <>
                <Button type="button" variant="outline" className="w-full" onClick={() => fileInput.current?.click()}>
                  <Upload className="h-4 w-4" aria-hidden /> {fileName || 'Choose the identity file'}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  aria-label="Identity file for the top-up"
                  accept="application/json,.json,.txt"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void onFile(f)
                    e.target.value = ''
                  }}
                />
              </>
            ) : (
              <Field label="Recovery phrase (12 or 24 words)" htmlFor="topup-mnemonic">
                <Textarea
                  id="topup-mnemonic"
                  ref={phraseRef}
                  defaultValue=""
                  onChange={(e) => setPhraseTyped(e.target.value.trim() !== '')}
                  className="min-h-[64px] font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
            )}
          </fieldset>

          <CostPreview cost={previewCredits(KEY_LIMITS_UPDATE_CREDITS)} />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Top-up keeps this key. <strong className="font-medium">Renew</strong> instead registers a new key and disables this
            one; use it if this browser&apos;s key may have leaked.
          </p>
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={isLoading} disabled={!ready}>
            Sign once &amp; top up
          </Button>
        </form>
      )}
    </Dialog>
  )
}
