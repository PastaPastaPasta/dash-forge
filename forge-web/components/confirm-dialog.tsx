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

import { useEffect, useState } from 'react'
import { newIntent, type CostPreview as Cost } from '@/lib/sdk'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { affordability } from '@/lib/view/funds'
import { creditsAsDash } from '@/lib/view/format'
import { writeErrorMessage } from '@/lib/view/write-errors'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** The pre-sign cost, or null for a free action. A negative cost is a refund. */
  cost: Cost | null
  refund?: boolean
  confirmLabel: string
  /** The write to run on confirm, with this action's intent token. Throw to show the error. */
  onConfirm: (intent: string) => Promise<void>
  /** A short success note shown briefly before auto-close. */
  successNote?: string
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  cost,
  refund,
  confirmLabel,
  onConfirm,
  successNote = 'Confirmed on Platform',
}: ConfirmDialogProps): JSX.Element {
  const { identity, balance, keyLimits } = useAuth()
  const openTopUp = useUiStore((s) => s.openTopUp)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [intent, setIntent] = useState(newIntent)
  const isRefund = refund || (cost !== null && cost.credits < 0)

  useEffect(() => {
    if (open) setIntent(newIntent())
  }, [open])

  const check =
    identity !== null && cost !== null && !isRefund
      ? affordability(cost.credits, BigInt(balance ?? '0'), keyLimits)
      : ({ ok: true } as const)

  const run = async (): Promise<void> => {
    if (pending) return
    if (!check.ok) {
      openTopUp({ blocker: check.blocker, shortfall: check.shortfall })
      return
    }
    setPending(true)
    setError(null)
    try {
      await onConfirm(intent)
      setDone(true)
      setTimeout(() => {
        setDone(false)
        onClose()
      }, 900)
    } catch (e) {
      const { message, keyLimit } = writeErrorMessage(e)
      if (keyLimit) openTopUp({ blocker: 'key-budget' })
      setError(message)
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
            Cancel
          </Button>
          <Button variant={isRefund ? 'danger' : 'primary'} onClick={run} loading={pending} disabled={done || pending}>
            {done ? 'Done' : check.ok ? confirmLabel : 'Top up to continue'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {cost ? (
          <CostPreview cost={cost} refund={isRefund} />
        ) : (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">This action is free: no credits are spent.</p>
        )}

        {!check.ok ? (
          <div className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution">
            {check.blocker === 'key-budget'
              ? `This browser's key has ${creditsAsDash(Number(keyLimits?.remaining ?? 0n))} DASH of budget left; this write needs ${creditsAsDash(cost?.credits ?? 0)}. Renew the key to continue.`
              : `Not enough credits: short by ${creditsAsDash(Number(check.shortfall))} DASH.`}
          </div>
        ) : null}

        {done ? <p className="text-dense text-verify">{successNote}</p> : null}

        {error ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
