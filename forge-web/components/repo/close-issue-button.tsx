'use client'

/**
 * An open issue's close button, as GitHub's (RC2 rider QW-069): "Close issue" closes it as
 * completed, and its menu offers "Close as not planned" and "Close as duplicate", which asks for
 * the issue (of this repo) it duplicates. Each records why on the close (`transition.reason`, and
 * a duplicate's `dupNumber`).
 */

import { useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, CircleSlash, Copy } from 'lucide-react'
import { STATE_TEXT } from '@/lib/design/state'

import type { ClosedAs, CloseReason } from '@/lib/rules/transition'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDismiss } from '@/components/repo/target-rail'

const CHOICES: readonly { readonly reason: CloseReason; readonly label: string; readonly hint: string }[] = [
  { reason: 'completed', label: 'Close as completed', hint: 'Done, closed, fixed, resolved' },
  { reason: 'not_planned', label: 'Close as not planned', hint: "Won't fix, can't repro, stale" },
  { reason: 'duplicate', label: 'Close as duplicate', hint: 'Duplicate of another issue' },
]

/** What a typed duplicate number is wrong with, or null when it may be checked against the repo. */
export function duplicateInputError(text: string, own: number): string | null {
  const t = text.trim().replace(/^#/, '')
  if (!/^\d{1,10}$/.test(t)) return 'Enter the number of the issue it duplicates'
  const n = Number(t)
  if (n < 1 || n > 4294967295) return 'Enter the number of the issue it duplicates'
  if (n === own) return 'An issue cannot be a duplicate of itself'
  return null
}

export function CloseIssueButton({
  number,
  label,
  disabled,
  title,
  onClose,
  checkDuplicate,
}: {
  /** The issue's own number (it cannot duplicate itself). */
  number: number
  /** The main button's words ("Close issue", "Close with comment"). */
  label: string
  disabled: boolean
  title?: string
  onClose: (closed: ClosedAs) => void
  /** Whether #n is an issue of this repo: null when it is, else why not. */
  checkDuplicate: (n: number) => Promise<string | null>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [dup, setDup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = (): void => {
    setOpen(false)
    setDup(null)
    setError(null)
  }
  useDismiss(open, ref, dismiss)
  const choose = (reason: CloseReason): void => {
    if (reason === 'duplicate') {
      setDup('')
      return
    }
    dismiss()
    onClose({ reason, duplicateOf: null })
  }
  const submitDuplicate = async (): Promise<void> => {
    const text = dup ?? ''
    const bad = duplicateInputError(text, number)
    if (bad !== null) {
      setError(bad)
      return
    }
    const n = Number(text.trim().replace(/^#/, ''))
    setChecking(true)
    try {
      const why = await checkDuplicate(n)
      if (why !== null) {
        setError(why)
        return
      }
      dismiss()
      onClose({ reason: 'duplicate', duplicateOf: n })
    } catch {
      setError(`Couldn't check #${n}: try again`)
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="relative inline-flex" ref={ref} data-testid="close-issue">
      <Button variant="outline" className="rounded-r-none" onClick={() => onClose({ reason: 'completed', duplicateOf: null })} disabled={disabled} title={title} data-testid="issue-state-toggle">
        <CheckCircle2 className={`h-3.5 w-3.5 ${STATE_TEXT.done}`} aria-hidden />
        {label}
      </Button>
      <Button
        variant="outline"
        className="-ml-px rounded-l-none px-2"
        onClick={() => (open ? dismiss() : setOpen(true))}
        disabled={disabled}
        aria-label="Close with a reason"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="close-reason-menu"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open ? (
        <div role="menu" className="absolute bottom-full right-0 z-20 mb-1 w-72 rounded-md border border-anvil-200 bg-white p-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-950">
          {CHOICES.map((c) => (
            <button
              key={c.reason}
              type="button"
              role="menuitem"
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-anvil-50 coarse:min-h-11 dark:hover:bg-anvil-900"
              onClick={() => choose(c.reason)}
              data-reason={c.reason}
            >
              {c.reason === 'completed' ? (
                <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${STATE_TEXT.done}`} aria-hidden />
              ) : c.reason === 'not_planned' ? (
                <CircleSlash className={`mt-0.5 h-4 w-4 shrink-0 ${STATE_TEXT.skipped}`} aria-hidden />
              ) : (
                <Copy className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
              )}
              <span>
                <span className="block text-dense font-medium">{c.label}</span>
                <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{c.hint}</span>
              </span>
            </button>
          ))}
          {dup !== null ? (
            <form
              className="border-t border-anvil-200 p-2 dark:border-anvil-750"
              onSubmit={(e) => {
                e.preventDefault()
                void submitDuplicate()
              }}
              data-testid="duplicate-of"
            >
              <label htmlFor="duplicate-of" className="mb-1 block text-[12px] text-anvil-600 dark:text-anvil-400">
                Duplicate of issue #
              </label>
              <div className="flex gap-1">
                <Input id="duplicate-of" inputMode="numeric" autoFocus value={dup} onChange={(e) => { setDup(e.target.value); setError(null) }} placeholder="12" aria-invalid={error !== null} />
                <Button type="submit" variant="primary" size="sm" loading={checking}>
                  Close
                </Button>
              </div>
              {error !== null ? <p className="mt-1 text-[12px] text-danger-700 dark:text-danger-400" role="alert">{error}</p> : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
