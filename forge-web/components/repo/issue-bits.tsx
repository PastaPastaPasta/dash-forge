'use client'

/**
 * Small pieces the issue list and the issue page share: a label chip in the label's colour,
 * the assignee avatar stack, a markdown editor with Write / Preview tabs, and the "edited"
 * marker.
 */

import { useState, type ReactNode } from 'react'
import { labelTextColor, type LabelDef } from '@/lib/repo'
import { avatarFill, avatarHue } from '@/lib/design/avatar'
import { timeAgo } from '@/lib/view'
import { MarkdownView, type MarkdownLinks } from '@/components/markdown-view'
import { Textarea } from '@/components/ui/input'
import { cn } from '@/lib/utils'

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
        text === null && 'bg-forge-500/10 text-forge-700 dark:text-forge-300',
        className,
      )}
      style={text === null ? undefined : { backgroundColor: def?.color, color: text }}
    >
      {name}
      {children}
    </span>
  )
}

/** Assignee avatars (initial swatches, as the identity pill), overlapping, with a count past three. */
export function AssigneeAvatars({ ids, names }: { ids: readonly string[]; names?: ReadonlyMap<string, string | null> }): JSX.Element | null {
  if (ids.length === 0) return null
  const shown = ids.slice(0, 3)
  const label = `Assigned to ${ids.map((id) => names?.get(id) ?? id.slice(0, 8)).join(', ')}`
  return (
    <span className="inline-flex items-center" aria-label={label} title={label} data-testid="assignees">
      {shown.map((id, i) => (
        <span
          key={id}
          className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white dark:ring-anvil-950', i > 0 && '-ml-1.5')}
          style={{ backgroundColor: avatarFill(avatarHue(id)) }}
          aria-hidden
        >
          {(names?.get(id) ?? id).charAt(0).toUpperCase()}
        </span>
      ))}
      {ids.length > shown.length ? <span className="ml-1 text-[11px] text-anvil-500">+{ids.length - shown.length}</span> : null}
    </span>
  )
}

/** "edited" beside a document that was replaced since it was created. */
export function EditedMarker({ createdAt, updatedAt }: { createdAt: number; updatedAt: number | undefined }): JSX.Element | null {
  if (updatedAt === undefined || updatedAt <= createdAt) return null
  return (
    <span className="text-anvil-400" title={`Edited ${timeAgo(updatedAt)}`} data-testid="edited-marker">
      · edited
    </span>
  )
}

/** A markdown field with Write / Preview tabs (the preview renders exactly what will be shown). */
export function MarkdownEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  links,
  className,
  autoFocus,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  links?: MarkdownLinks
  className?: string
  autoFocus?: boolean
}): JSX.Element {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const tabClass = (on: boolean) =>
    cn(
      'rounded-t px-3 py-1.5 text-dense font-medium',
      on ? 'border border-b-0 border-anvil-200 bg-white text-anvil-900 dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-50' : 'text-anvil-500 hover:text-anvil-800 dark:text-anvil-400',
    )
  return (
    <div className={className}>
      <div role="tablist" aria-label={`${label} editor`} className="flex gap-1">
        <button type="button" role="tab" aria-selected={tab === 'write'} className={tabClass(tab === 'write')} onClick={() => setTab('write')}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} className={tabClass(tab === 'preview')} onClick={() => setTab('preview')}>
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <>
          <label htmlFor={id} className="sr-only">{label}</label>
          <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-h-[120px] rounded-tl-none" autoFocus={autoFocus} />
        </>
      ) : (
        <div role="tabpanel" aria-label={`${label} preview`} className="min-h-[120px] rounded-md rounded-tl-none border border-anvil-300 px-3 py-2 dark:border-anvil-700" data-testid="markdown-preview">
          {value.trim() === '' ? <p className="italic text-anvil-400">Nothing to preview.</p> : <MarkdownView source={value} links={links} />}
        </div>
      )}
      <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">Markdown supported. #12 links an issue, @name a profile.</p>
    </div>
  )
}
