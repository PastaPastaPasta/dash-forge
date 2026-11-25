'use client'

/**
 * A list row's quiet "…" menu: where a row's actions, a destructive one above all, wait until
 * they are wanted, instead of a button on every row. Each item still goes through its own
 * confirm.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useDismiss } from '@/components/repo/target-rail'
import { cn } from '@/lib/utils'

const ENABLED_ITEMS = '[role="menuitem"]:not(:disabled)'

export interface RowMenuItem {
  readonly label: string
  readonly onSelect: () => void
  readonly destructive?: boolean
  readonly disabled?: boolean
}

export function RowMenu({
  label,
  items,
  disabled = false,
  expanded,
}: {
  label: string
  items: readonly RowMenuItem[]
  disabled?: boolean
  /** Whether what the menu opened (a role picker under the row) is open. */
  expanded?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  useDismiss(open, ref, close)
  // The menu takes focus on its first item; the arrows move through it, Tab leaves it.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLButtonElement>(ENABLED_ITEMS)?.focus()
  }, [open])
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEMS) ?? [])]
    const at = Math.max(0, all.indexOf(document.activeElement as HTMLButtonElement))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      all[e.key === 'Home' ? 0 : all.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open || expanded === true}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        data-testid="row-menu"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-anvil-500 hover:bg-anvil-100 hover:text-anvil-800 disabled:opacity-50 coarse:h-11 coarse:w-11 dark:text-anvil-400 dark:hover:bg-anvil-800 dark:hover:text-anvil-100"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          className="absolute right-0 top-full z-30 mt-1 min-w-[11rem] rounded-md border border-anvil-200 bg-white p-1 shadow-md dark:border-anvil-750 dark:bg-anvil-900"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close()
                item.onSelect()
              }}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left text-dense hover:bg-anvil-100 disabled:opacity-50 coarse:min-h-11 dark:hover:bg-anvil-800',
                item.destructive ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-700 dark:text-anvil-200',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
