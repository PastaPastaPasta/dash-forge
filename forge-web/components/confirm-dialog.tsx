'use client'

/**
 * ConfirmDialog — the pre-sign confirmation gate every cost-bearing write passes through.
 *
 * Shows the action, its {@link CostPreview}, and (when logged in) an affordability check
 * against the credit balance — with a bridge.thepasta.org deep link when credits are short.
 * Runs the async action, surfacing pending / broadcast / confirmed / error inline in the
 * app's voice. Free actions can pass `cost={null}` to skip the price row.
 */

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { CostPreview as Cost } from '@/lib/sdk'
import { useAuth } from '@/contexts/auth-context'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** The pre-sign cost, or null for a free action. */
  cost: Cost | null
  refund?: boolean
  confirmLabel: string
  /** The write to run on confirm. Resolve to close; throw to show the error. */
  onConfirm: () => Promise<void>
  /** A short success note shown briefly before auto-close. */
  successNote?: string
}

const BRIDGE_URL = 'https://bridge.thepasta.org'

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  cost,
  refund,
  confirmLabel,
  onConfirm,
  successNote = 'Broadcast — confirming on Platform',
}: ConfirmDialogProps): JSX.Element {
  const { identity, balance } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const credits = balance ? Number(balance) : 0
  const insufficient =
    identity !== null && cost !== null && !refund && cost.credits > 0 && credits < cost.credits

  const run = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      setDone(true)
      setTimeout(() => {
        setDone(false)
        onClose()
      }, 900)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
          <Button
            variant={refund ? 'danger' : 'primary'}
            onClick={run}
            loading={pending}
            disabled={insufficient || done}
          >
            {done ? 'Done' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {cost ? <CostPreview cost={cost} refund={refund} /> : (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">
            This action is free — no credits or tokens are spent.
          </p>
        )}

        {insufficient ? (
          <div className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense text-caution">
            Not enough credits for this write.{' '}
            <a
              href={BRIDGE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 font-medium underline"
            >
              Top up at the bridge <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        ) : null}

        {done ? (
          <p className="text-dense text-verify">{successNote}</p>
        ) : null}

        {error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
