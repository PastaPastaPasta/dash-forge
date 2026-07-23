'use client'

/**
 * Dialog — a dependency-free modal (Radix is not in the bundle). Renders a backdrop + centered
 * panel, closes on Escape / backdrop click, restores focus to the trigger, and moves focus into
 * the panel on open. `aria-modal` + labelled title keep it screen-reader correct.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  /** Footer actions row (right-aligned). */
  footer?: ReactNode
  className?: string
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fixed inset-0 bg-anvil-950/70 backdrop-blur-sm animate-fade-in" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-md rounded-lg border shadow-xl outline-none animate-fade-in',
          'border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-900',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-anvil-200 px-5 py-3.5 dark:border-anvil-800">
          <div>
            <h2 className="text-prose">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-dense text-anvil-500 dark:text-anvil-400">{description}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1.5 -mt-1"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-anvil-200 px-5 py-3 dark:border-anvil-800">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
