'use client'

/**
 * An in-app "are you sure?" for actions that sign nothing but cannot be undone from here
 * (forgetting a stored key, removing the encryption key), or that start a master-key signature.
 * It replaces the browser's native `window.confirm`, which cannot be styled, names no action on
 * its button, and on some mobile browsers is suppressed outright.
 *
 * `useConfirmAction()` returns `confirm(options)`, which resolves true on the confirm button and
 * false on Cancel, Escape or a backdrop click, and the dialog element to render. Focus starts on
 * Cancel, so Enter never confirms a destructive action by accident.
 */

import { useCallback, useRef, useState } from 'react'
import { Dialog } from './dialog'
import { Button } from './button'

export interface ConfirmActionOptions {
  readonly title: string
  /** What happens, and what does not (one or two sentences). */
  readonly body: string
  /** The confirm button's label: the action, e.g. "Forget key". */
  readonly confirmLabel: string
  /** Red for destructive actions (the default), primary otherwise. */
  readonly tone?: 'danger' | 'primary'
}

export function useConfirmAction(): readonly [(options: ConfirmActionOptions) => Promise<boolean>, JSX.Element | null] {
  const [open, setOpen] = useState<ConfirmActionOptions | null>(null)
  const settle = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((options: ConfirmActionOptions): Promise<boolean> => {
    // A second request while one is open answers the first "no".
    settle.current?.(false)
    return new Promise<boolean>((resolve) => {
      settle.current = resolve
      setOpen(options)
    })
  }, [])

  const finish = (ok: boolean): void => {
    settle.current?.(ok)
    settle.current = null
    setOpen(null)
  }

  const element = open ? (
    <Dialog
      open
      onClose={() => finish(false)}
      title={open.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)} autoFocus>
            Cancel
          </Button>
          <Button variant={open.tone ?? 'danger'} onClick={() => finish(true)} data-testid="confirm-action">
            {open.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-dense text-anvil-700 dark:text-anvil-200">{open.body}</p>
    </Dialog>
  ) : null

  return [confirm, element] as const
}
