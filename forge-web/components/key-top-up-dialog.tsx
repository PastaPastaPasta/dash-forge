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
import { CheckCircle2, KeyRound, Upload } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { ErrorBox } from '@/components/auth/protection-fields'
import { TOP_UP_DEFAULTS, masterMaterialFromFile, parseDashAmount, topUpExpiry } from '@/lib/auth'
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

export function KeyTopUpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { identity, keyLimits, topUpKey, isLoading } = useAuth()
  const [amount, setAmount] = useState(String(TOP_UP_DEFAULTS.addDash))
  const current = keyLimits?.expiresAt ?? null
  const suggested = Date.now() + TOP_UP_DEFAULTS.days * DAY_MS
  const [extend, setExtend] = useState(current === null || current < suggested)
  const [expiry, setExpiry] = useState(isoDay(suggested))
  const [mode, setMode] = useState<'file' | 'mnemonic'>('file')
  const fileRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ before: KeyLimits | null; after: KeyLimits } | null>(null)

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
  const hasMaster = mode === 'file' ? fileName !== '' : mnemonic.trim() !== ''
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

  const submit = async (): Promise<void> => {
    if (!ready) return
    setError(null)
    const before = keyLimits
    try {
      const input = mode === 'file' ? { fileText: fileRef.current ?? '' } : { mnemonic }
      const after = await topUpKey(input, { addCredits: credits, expiresAt: newExpiry })
      fileRef.current = null
      setMnemonic('')
      setDone({ before, after })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const dash = (c: bigint | null): string => (c === null ? '—' : `${creditsAsDash(Number(c))} DASH`)

  return (
    <Dialog open onClose={onClose} title="Top up this browser's key" description="Same key, more budget or a later expiry.">
      {done ? (
        <div className="space-y-3 text-dense" data-testid="key-top-up-done">
          <p className="flex items-center gap-2 text-verify">
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
          {amountError ? <p className="text-[12px] text-danger">{amountError}</p> : null}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={extend} onChange={(e) => setExtend(e.target.checked)} className="h-4 w-4 accent-forge-600" />
              <span>Extend the expiry{current !== null ? ` (now ${formatDate(current)})` : ''}</span>
            </label>
            {extend ? (
              <Field label="New expiry" htmlFor="topup-expiry">
                <Input id="topup-expiry" type="date" value={expiry} min={isoDay(Date.now() + DAY_MS)} onChange={(e) => setExpiry(e.target.value)} aria-invalid={expiryError !== null} />
              </Field>
            ) : null}
            {expiryError ? <p className="text-[12px] text-danger">{expiryError}</p> : null}
          </div>

          <fieldset className="space-y-2 rounded-md border border-anvil-200 p-3 dark:border-anvil-750">
            <legend className="px-1 text-[12px] font-medium text-anvil-600 dark:text-anvil-300">
              <KeyRound className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Master key, used once
            </legend>
            <div role="tablist" aria-label="Master key source" className="inline-flex rounded-md border border-anvil-200 p-0.5 dark:border-anvil-750">
              {(['file', 'mnemonic'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  type="button"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={cn('rounded px-3 py-1 text-dense font-medium', mode === m ? 'bg-forge-500/15 text-forge-700 dark:text-forge-300' : 'text-anvil-600 dark:text-anvil-300')}
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
                <Textarea id="topup-mnemonic" value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} className="min-h-[64px] font-mono" spellCheck={false} autoComplete="off" />
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
