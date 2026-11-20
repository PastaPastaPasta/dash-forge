'use client'

/**
 * Small pieces the issue list and the issue page share: a label chip in the label's colour,
 * the assignee avatar stack, and the "edited" marker.
 */

import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { labelTextColor, type LabelDef } from '@/lib/repo'
import { Identicon } from '@/components/ui/identicon'
import { timeAgo } from '@/lib/view'
import { cn, shortId } from '@/lib/utils'
import { DISCARDED_COMMENT_EDIT } from '@/lib/view/draft-text'

/** A label chip: the definition's colour when it has one, the theme's accent otherwise. */
export function LabelChip({
  name,
  def,
  className,
  children,
}: {
  name: string
  def?: LabelDef
  className?: string
  children?: ReactNode
}): JSX.Element {
  const text = def?.color ? labelTextColor(def.color) : null
  return (
    <span
      title={def?.description || undefined}
      data-label={name}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
        text === null && 'bg-forge-500/10 text-forge-800 dark:text-forge-400',
        className,
      )}
      style={text === null ? undefined : { backgroundColor: def?.color, color: text }}
    >
      {name}
      {children}
    </span>
  )
}

/** Assignee avatars (identicons, as the identity pill draws them), overlapping, with a count past three. */
export function AssigneeAvatars({ ids, names }: { ids: readonly string[]; names?: ReadonlyMap<string, string | null> }): JSX.Element | null {
  if (ids.length === 0) return null
  const shown = ids.slice(0, 3)
  const label = `Assigned to ${ids.map((id) => names?.get(id) ?? shortId(id)).join(', ')}`
  // role="img": a plain span may not carry aria-label (QW2-066), and the swatches are one picture.
  return (
    <span className="inline-flex items-center" role="img" aria-label={label} title={label} data-testid="assignees">
      {shown.map((id, i) => (
        <Identicon key={id} seed={id} size={20} className={cn('ring-2 ring-white dark:ring-anvil-950', i > 0 && '-ml-1.5')} />
      ))}
      {ids.length > shown.length ? <span className="ml-1 text-[11px] text-anvil-500 dark:text-anvil-400">+{ids.length - shown.length}</span> : null}
    </span>
  )
}

/**
 * The tick box drawn in a picker option (a label, an assignee, a reviewer). Only a picture: the
 * option button carries the state (`aria-pressed` / `aria-selected`), and a real checkbox inside
 * a button is a control nested in a control (axe nested-interactive, QW2-066).
 */
export function CheckMark({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-checked={on || undefined}
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
        // Unticked outline ≥ 3:1 on its surface (WCAG 1.4.11): anvil-500 on white, anvil-400 on anvil-900.
        on ? 'border-forge-700 bg-forge-700' : 'border-anvil-500 bg-white dark:border-anvil-400 dark:bg-anvil-900',
      )}
    >
      {on ? <Check className="h-3 w-3 text-white" strokeWidth={3} /> : null}
    </span>
  )
}

/** "edited" beside a document that was replaced since it was created. */
export function EditedMarker({ createdAt, updatedAt }: { createdAt: number; updatedAt: number | undefined }): JSX.Element | null {
  if (updatedAt === undefined || updatedAt <= createdAt) return null
  return (
    <span className="text-anvil-500 dark:text-anvil-400" title={`Edited ${timeAgo(updatedAt)}`} data-testid="edited-marker">
      · edited
    </span>
  )
}

/** A comment's header with the mark that its stored edit was discarded (Q5-A11, `discardedEdits`). */
export function withDiscardedEdit(header: ReactNode): JSX.Element {
  return (
    <>
      {header}
      <span role="status" className="order-last basis-full text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="comment-edit-dropped">
        {DISCARDED_COMMENT_EDIT}
      </span>
    </>
  )
}

