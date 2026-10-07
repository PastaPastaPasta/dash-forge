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
 */

import { useEffect, useState, type ReactNode } from 'react'
import { newIntent, type CostPreview as Cost } from '@/lib/sdk'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { affordability } from '@/lib/view/funds'
import { creditsAsDash } from '@/lib/view/format'
import { spendAction, type SpendActionLabels } from '@/lib/spend-toast'

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
  const [done, setDone] = useState(false)
  const [intent, setIntent] = useState(newIntent)
  const costPending = costIn === 'pending'
  const cost = costPending ? null : costIn
  const isRefund = refund || (cost !== null && cost.credits < 0)

  useEffect(() => {
    if (open) setIntent(newIntent())
  }, [open])

  const check =
    identity !== null && cost !== null && !isRefund
      ? affordability(cost, BigInt(balance ?? '0'), keyLimits)
      : ({ ok: true } as const)

  const run = async (): Promise<void> => {
    if (pending || costPending) return
    if (!check.ok) {
      openTopUp({ blocker: check.blocker, shortfall: check.shortfall })
      return
    }
    setPending(true)
    setError(null)
    try {
      // However many writes the action signs, they show one toast with their total (QW3-039).
      // The dialog is modal: every write reported while it runs is this action's.
      await spendAction(toast ?? { done: successNote ?? 'Saved' }, () => onConfirm(intent), { scope: true })
      setDone(true)
      setTimeout(() => {
        setDone(false)
        onClose()
      }, 900)
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setPending(false)
    }
  }

  const close = (): void => {
    if (pending) return
    setError(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={isRefund ? 'danger' : 'primary'} onClick={run} loading={pending} disabled={done || pending || costPending || (blocked !== undefined && blocked !== null)}>
            {done ? 'Done' : check.ok ? confirmLabel : 'Top up to continue'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        {costPending ? null : cost ? (
          <CostPreview cost={cost} refund={isRefund} />
        ) : (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">This action is free: no credits are spent.</p>
        )}

        {!check.ok ? (
          <div className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution-700 dark:text-caution-400">
            {check.blocker === 'key-budget'
              ? `This browser's key has ${creditsAsDash(Number(keyLimits?.remaining ?? 0n))} DASH of budget left; Platform needs ${creditsAsDash(cost?.admit.budget ?? 0)} DASH available to accept this write (it then charges about ${creditsAsDash(cost?.credits ?? 0)}). Top up or renew the key to continue.`
              : `Not enough credits: Platform needs ${creditsAsDash(cost?.admit.balance ?? 0)} DASH available to accept this write, ${creditsAsDash(Number(check.shortfall))} DASH more than your balance.`}
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
