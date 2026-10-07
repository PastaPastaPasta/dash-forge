'use client'

/**
 * Dialog — a dependency-free modal (Radix is not in the bundle). Renders a backdrop + centered
 * panel and closes on Escape / backdrop click. Focus is managed as WAI-ARIA's modal dialog
 * pattern asks: on open it lands on the first `autoFocus` field (else the panel), Tab and
 * Shift+Tab wrap inside the panel, and on close it returns to the element that opened it.
 * Only the topmost of stacked dialogs handles keys. `aria-modal` + labelled title keep it
 * screen-reader correct.
 */

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { initialFocus, trapTab } from '@/lib/focus'
import { Button } from './button'

/** Open dialogs and their panels, innermost last: only the top one traps Tab and answers Escape. */
const openStack: { readonly id: string; readonly panel: HTMLElement }[] = []

/**
 * Open popovers that answer Escape before any dialog (a picker opened inside a dialog), innermost
 * last, with the element each sits in. They are not dialogs: the dialog under one keeps trapping
 * Tab and pulling focus back.
 */
const escapeLayers: { readonly id: string; readonly el: RefObject<HTMLElement | null> }[] = []

/**
 * The popovers that may take an Escape now: those inside the top dialog's panel, or every one
 * when no dialog is open. A popover left open on the page under a dialog never takes the
 * dialog's Escape (nor stops it).
 */
function liveEscapeLayers(): readonly { readonly id: string }[] {
  const top = openStack[openStack.length - 1]
  if (top === undefined) return escapeLayers
  return escapeLayers.filter((l) => l.el.current !== null && top.panel.contains(l.el.current))
}

/**
 * A popover's Escape while `active`: it closes the popover (`onEscape`) and not the dialog under
 * it, which answers Escape again once the popover closes. `el`: the element the popover sits in
 * (inside a dialog's panel, it takes that dialog's Escape; elsewhere, only while no dialog is open).
 */
export function useEscapeLayer(active: boolean, onEscape: () => void, el: RefObject<HTMLElement | null>): void {
  const id = useId()
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active) return
    escapeLayers.push({ id, el })
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.key !== 'Escape') return
      const live = liveEscapeLayers()
      if (live[live.length - 1]?.id !== id) return
      e.preventDefault()
      escapeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const at = escapeLayers.findLastIndex((l) => l.id === id)
      if (at >= 0) escapeLayers.splice(at, 1)
    }
  }, [active, id, el])
}

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
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  // The opener, captured while rendering the open dialog: a child's `autoFocus` moves focus
  // during the commit, before any effect of this component could read it.
  const opener = useRef<Element | null | undefined>(undefined)
  if (!open) opener.current = undefined
  else if (opener.current === undefined && typeof document !== 'undefined') opener.current = document.activeElement
  // The latest onClose, so an inline arrow from the caller does not re-run the effect (which
  // would steal focus back to the first field on every parent render).
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel === null) return
    openStack.push({ id, panel })
    const onKey = (e: KeyboardEvent): void => {
      // Only the top dialog answers; an Escape that cancels IME composition is not a close.
      if (openStack[openStack.length - 1]?.id !== id || e.isComposing) return
      if (e.key === 'Escape') {
        // Taken already (a field or a popover handled it), or a popover inside it (a picker)
        // takes it.
        if (e.defaultPrevented || liveEscapeLayers().length > 0) return
        e.preventDefault()
        closeRef.current()
        return
      }
      trapTab(panel, e)
    }
    // Focus that lands behind the dialog (a click on the page, a programmatic focus) is pulled back.
    const onFocusIn = (e: FocusEvent): void => {
      if (openStack[openStack.length - 1]?.id !== id) return
      if (e.target instanceof Node && !panel.contains(e.target)) panel.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    initialFocus(panel).focus()
    const returnTo = opener.current
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
      const at = openStack.findLastIndex((d) => d.id === id)
      if (at >= 0) openStack.splice(at, 1)
      document.body.style.overflow = prevOverflow
      // Only on a real close (the panel has left the DOM). StrictMode's simulated unmount keeps
      // the panel mounted; returning focus there would pull it off the autoFocus field.
      if (!panel.isConnected && returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus()
    }
  }, [open, id])

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
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-md rounded-lg border shadow-xl outline-none animate-fade-in',
          'border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-900',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-anvil-200 px-5 py-3.5 dark:border-anvil-800">
          <div>
            <h2 id={titleId} className="text-prose">{title}</h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-dense text-anvil-500 dark:text-anvil-400">{description}</p>
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
