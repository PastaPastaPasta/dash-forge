'use client'

/**
 * ConfirmDialog — the pre-sign gate every cost-bearing write passes through.
 *
 * Shows the action and its {@link CostPreview}, then checks the write against both budgets
 * (`ux-dx-spec.md` §4 rule 5): the identity's balance and, for a limited key, what is left of
 * the key's budget. When either is short the confirm button opens the top-up sheet with the
 * shortfall instead. Runs the async action, surfacing pending / confirmed / error inline.
 *
 * Each opening of the dialog is one action: `onConfirm` receives an intent token that stays
 * the same across retries of that action (so a retry finishes the first attempt instead of
 * signing twice) and changes the next time the dialog opens. "Confirmed" is shown only for a
 * write Platform has shown; an unconfirmed one says so and keeps the dialog open.
 *
 * While the write runs the dialog shows its steps (`WriteProgressSteps`). While a write runs
 * or is sent but not yet seen, the dialog keeps the action it was confirmed with: its title,
 * description, button words and `onConfirm`, and its fields are disabled, so a page that
 * re-renders under it (an issue now closed: "Reopen issue") neither relabels the action in
 * flight nor turns a check into the opposite write. After an ordinary error the action is let
 * go, so a retry runs what the dialog shows now (edited fields included). A write sent but not
 * yet seen is not an error: the dialog says so calmly, offers "Check again" (the same action and
 * intent: it finishes the change it sent) and checks again by itself a few times.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { newIntent, UnconfirmedWriteError, type CostPreview as Cost } from '@/lib/sdk'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { affordability } from '@/lib/view/funds'
import { creditsAsDash } from '@/lib/view/format'
import { spendAction, type SpendActionLabels } from '@/lib/spend-toast'
import { creditsToDash } from '@/lib/sdk/cost'
import { FiatNote } from '@/components/ui/fiat-note'
import { WriteProgressSteps } from '@/components/write-progress'

/** How long after an unconfirmed write the dialog checks again by itself, and how often. */
export const RECHECK_MS = 15_000
export const RECHECKS = 3

/** The action as the user confirmed it: what the dialog showed and the write it runs. */
interface Confirmed {
  readonly title: string
  readonly description?: string
  readonly confirmLabel: string
  readonly onConfirm: (intent: string) => Promise<void>
}

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /**
   * The pre-sign cost, or null for a free action. A negative cost is a refund. `'pending'`: not
   * known yet (what it depends on is still being read): no cost is shown, and Confirm waits.
   */
  cost: Cost | null | 'pending'
  refund?: boolean
  confirmLabel: string
  /** The dismiss button's words (default "Cancel"). */
  cancelLabel?: string
  /** More of the question under the description (paragraphs, a list), above the cost. */
  children?: ReactNode
  /** Why the action cannot run yet (no key in this browser, a locked tab): shown, and Confirm is disabled. */
  blocked?: ReactNode
  /** The write to run on confirm, with this action's intent token. Throw to show the error. */
  onConfirm: (intent: string) => Promise<void>
  /** A short success note shown briefly before auto-close. */
  successNote?: string
  /**
   * What the action's one toast says while its writes land and once they all did (QW3-039: one
   * toast with their total). Defaults to each write's own title, then `successNote` or "Saved";
   * an action of one write ends under that write's own title.
   */
  toast?: SpendActionLabels
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  cost: costIn,
  refund,
  confirmLabel,
  cancelLabel = 'Cancel',
  children,
  blocked,
  onConfirm,
  successNote,
  toast,
}: ConfirmDialogProps): JSX.Element {
  const { identity, balance, keyLimits } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const guard = useWriteGuard()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Sent, not seen yet: the message, and the automatic checks still to come. */
  const [unconfirmed, setUnconfirmed] = useState<{ message: string; left: number } | null>(null)
  const [done, setDone] = useState(false)
  /** The action as it was confirmed, kept while it runs or is unconfirmed. */
  const [frozen, setFrozen] = useState<Confirmed | null>(null)
  const frozenRef = useRef<Confirmed | null>(null)
  const runRef = useRef<() => Promise<void>>()
  const [intent, setIntent] = useState(newIntent)
  const costPending = costIn === 'pending'
  const cost = costPending ? null : costIn
  const isRefund = refund || (cost !== null && cost.credits < 0)

  useEffect(() => {
    if (open) setIntent(newIntent())
    setUnconfirmed(null)
    setFrozen(null)
    frozenRef.current = null
  }, [open])

  const isBlocked = blocked !== undefined && blocked !== null

  const check =
    identity !== null && cost !== null && !isRefund
      ? affordability(cost, BigInt(balance ?? '0'), keyLimits)
      : ({ ok: true } as const)

  const run = async (): Promise<void> => {
    if (pending || costPending || isBlocked) return
    // A check of a write already sent: its spend was admitted when it was sent.
    if (unconfirmed === null && !check.ok) {
      openTopUp({ blocker: check.blocker, shortfall: check.shortfall })
      return
    }
    setPending(true)
    setError(null)
    const action = (frozenRef.current ??= { title, description, confirmLabel, onConfirm })
    setFrozen(action)
    try {
      // However many writes the action signs, they show one toast with their total (QW3-039).
      // The dialog is modal: every write reported while it runs is this action's.
      await spendAction(toast ?? { done: successNote ?? 'Saved' }, () => action.onConfirm(intent), { scope: true })
      setUnconfirmed(null)
      setDone(true)
      setTimeout(() => {
        setDone(false)
        onClose()
      }, 900)
    } catch (e) {
      const message = guard.failed(e)
      if (e instanceof UnconfirmedWriteError) {
        setUnconfirmed((u) => ({ message, left: u === null ? RECHECKS : Math.max(0, u.left - 1) }))
      } else {
        setUnconfirmed(null)
        frozenRef.current = null
        setFrozen(null)
        setError(message)
      }
    } finally {
      setPending(false)
    }
  }
  runRef.current = run

  // Sent but not seen: check again by itself (the same action: it finishes the write it sent).
  const autoRecheck = open && unconfirmed !== null && unconfirmed.left > 0 && !pending && !isBlocked && !costPending
  useEffect(() => {
    if (!autoRecheck) return
    const timer = setTimeout(() => void runRef.current?.(), RECHECK_MS)
    return () => clearTimeout(timer)
  }, [autoRecheck, unconfirmed])

  const close = (): void => {
    if (pending) return
    setError(null)
    onClose()
  }

  const shown = frozen ?? { title, description, confirmLabel }
  const buttonLabel = done ? 'Done' : unconfirmed !== null ? 'Check again' : check.ok ? shown.confirmLabel : 'Top up to continue'

  return (
    <Dialog
      open={open}
      onClose={close}
      title={shown.title}
      description={shown.description}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={pending}>
            {unconfirmed !== null ? 'Close' : cancelLabel}
          </Button>
          <Button variant={isRefund ? 'danger' : 'primary'} onClick={run} loading={pending} disabled={done || pending || costPending || isBlocked}>
            {buttonLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <fieldset disabled={pending || unconfirmed !== null} className="m-0 min-w-0 space-y-3 border-0 p-0 [&:empty+*]:!mt-0">
          {children}
        </fieldset>
        {costPending ? null : cost ? (
          <CostPreview cost={cost} refund={isRefund} />
        ) : (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">This action is free: no credits are spent.</p>
        )}

        <div role="status" aria-live="polite" className="empty:!mt-0">
          {pending ? <WriteProgressSteps /> : null}
          {unconfirmed !== null && !pending && !done ? (
            <div data-testid="write-unconfirmed" className="flex items-start gap-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense text-anvil-700 dark:border-anvil-750 dark:bg-anvil-850 dark:text-anvil-200">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="break-words">{unconfirmed.message}</p>
                <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
                  {autoRecheck
                    ? `Checking again by itself in ${RECHECK_MS / 1000} seconds. Checking finishes this same change; it is never applied twice.`
                    : 'Still not visible. Check again in a minute: checking finishes this same change; it is never applied twice.'}{' '}
                  If you close this, reload later and look for the change before doing it again.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {!check.ok && unconfirmed === null && !done ? (
          <div className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
            {check.blocker === 'key-budget'
              ? <>This browser&apos;s key has {creditsAsDash(Number(keyLimits?.remaining ?? 0n))} DASH<FiatNote dash={creditsToDash(Number(keyLimits?.remaining ?? 0n))} /> of budget left; Platform needs {creditsAsDash(cost?.admit.budget ?? 0)} DASH<FiatNote dash={creditsToDash(cost?.admit.budget ?? 0)} /> available to accept this write (it then charges about {creditsAsDash(cost?.credits ?? 0)}<FiatNote dash={creditsToDash(cost?.credits ?? 0)} />). Top up or renew the key to continue.</>
              : <>Not enough credits: Platform needs {creditsAsDash(cost?.admit.balance ?? 0)} DASH<FiatNote dash={creditsToDash(cost?.admit.balance ?? 0)} /> available to accept this write, {creditsAsDash(Number(check.shortfall))} DASH<FiatNote dash={creditsToDash(Number(check.shortfall))} /> more than your balance.</>}
          </div>
        ) : null}

        {blocked ?? null}

        {done ? <p className="text-dense text-verify-700 dark:text-verify-400">{successNote ?? 'Confirmed on Platform'}</p> : null}

        {error ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400 break-words">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
