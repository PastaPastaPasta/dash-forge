'use client'

/**
 * Pieces the board layouts, the board settings and the issue sidebar share (design
 * `docs/design/boards.md` §2.2, §4, §5.6): board URLs, how a field value and a view key read,
 * the editor of one field value and the Status select, an item's state icon, a colour dot.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleDot } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { STATE_TEXT } from '@/lib/design/state'
import { dateDays, fieldKeyId, fieldValueOk, iterationAt, iterationRange, type BoardField, type BoardItem, type BoardSpec, type FieldValue, type IterationRange } from '@/lib/rules/boards'
import { disabledField } from '@/components/ui/input'
import { pullStateView } from '@/components/repo/pull-state'
import { LabelChip } from '@/components/repo/issue-bits'
import { Author } from '@/components/author'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------------------------
// URLs (§2.1: `/repo/board?owner=&name=&b=<key>`)
// ---------------------------------------------------------------------------------------------

/** A repository's boards list. */
export function boardsHref(addr: RepoAddress, extra: Record<string, string> = {}): string {
  return repoHref('/repo/boards', addr, extra)
}

/** Board `key` of `addr`. */
export function boardHref(addr: RepoAddress, key: number, extra: Record<string, string> = {}): string {
  return repoHref('/repo/board', addr, { b: String(key), ...extra })
}

/** Board `key`'s settings. */
export function boardSettingsHref(addr: RepoAddress, key: number): string {
  return repoHref('/repo/board/settings', addr, { b: String(key) })
}

// ---------------------------------------------------------------------------------------------
// How values read
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` as "Oct 26, 2026" (UTC, as the board stores dates); `year: false` drops the year. */
export function dayText(day: string, { year = true }: { readonly year?: boolean } = {}): string {
  const d = dateDays(day)
  if (d === null) return day
  return new Date(d * DAY_MS).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

/** "Oct 26 – Nov 8, 2026" (the start's year shown only when the two differ). */
export function dayRangeText(start: string, end: string): string {
  if (start === end) return dayText(start)
  const sameYear = start.slice(0, 4) === end.slice(0, 4)
  return `${dayText(start, { year: !sameYear })} – ${dayText(end)}`
}

/** Iteration `k` of an `iter` field by name ("Iteration 3"). */
export function iterationName(field: BoardField, k: number): string {
  return iterationRange(field, k)?.name ?? `${field.name} ${k + 1}`
}

/** A field value as text: an option's name, a number as stored, a date, an iteration's name; '' for none. */
export function fieldValueText(field: BoardField, v: FieldValue | undefined): string {
  if (v === undefined) return ''
  switch (field.type) {
    case 'sel':
      return field.options?.find((o) => o.id === v)?.name ?? ''
    case 'date':
      return dayText(String(v))
    case 'iter':
      return typeof v === 'number' ? iterationName(field, v) : ''
    default:
      return String(v)
  }
}

/** What each built-in view key is called (§2.7). */
export const BUILTIN_KEY_LABEL: Readonly<Record<string, string>> = {
  title: 'Title',
  number: 'Number',
  repo: 'Repository',
  state: 'State',
  author: 'Author',
  assignees: 'Assignees',
  assignee: 'Assignee',
  labels: 'Labels',
  label: 'Label',
  milestone: 'Milestone',
  created: 'Created',
  status: 'Status',
  rank: 'Board order',
}

/** A view key's name: a built-in's, or a custom field's (`f<id>`). */
export function viewKeyLabel(spec: BoardSpec, key: string): string {
  const k = key.startsWith('-') ? key.slice(1) : key
  const builtin = BUILTIN_KEY_LABEL[k]
  if (builtin !== undefined) return builtin
  const m = /^f(\d+)$/.exec(k)
  const field = m ? spec.fields.find((f) => f.id === Number(m[1])) : undefined
  return field?.name ?? k
}

/** A status column's name; "No status" for 0. */
export function columnName(spec: BoardSpec, col: number): string {
  return spec.columns.find((c) => c.id === col)?.name ?? 'No status'
}

// ---------------------------------------------------------------------------------------------
// Small pictures
// ---------------------------------------------------------------------------------------------

/** A column's or option's colour as a dot; a dashed ring where it has none. */
export function ColorDot({ color, className }: { readonly color?: string | undefined; readonly className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', color === undefined && 'border border-dashed border-anvil-400 dark:border-anvil-500', className)}
      style={color === undefined ? undefined : { backgroundColor: color }}
    />
  )
}

/** An issue's or PR's state icon, as the lists draw it, with its name for screen readers. */
export function ItemStateIcon({ item, className }: { readonly item: Pick<BoardItem, 'kind' | 'state'>; readonly className?: string }): JSX.Element {
  if (item.kind === 'pr') {
    const v = pullStateView({ open: item.state === 'open', merged: item.state === 'merged' })
    return (
      <>
        <v.Icon className={cn('h-4 w-4 shrink-0', v.klass, className)} aria-hidden />
        <span className="sr-only">{`${v.label} pull request`}</span>
      </>
    )
  }
  const open = item.state === 'open'
  const Icon = open ? CircleDot : CheckCircle2
  return (
    <>
      <Icon className={cn('h-4 w-4 shrink-0', open ? STATE_TEXT.open : STATE_TEXT.done, className)} aria-hidden />
      <span className="sr-only">{open ? 'Open issue' : 'Closed issue'}</span>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Editing one value
// ---------------------------------------------------------------------------------------------

/** A compact select or input, as the lists' own selects. */
export const controlClass =
  'rounded-md border border-anvil-300 bg-white px-2 py-1 text-dense text-anvil-900 dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100 coarse:min-h-11 ' + disabledField

/**
 * The iterations a picker offers: two before the current one to five after it (from the first
 * when none has started), and `keep` (the item's own) wherever it is.
 */
export function iterationChoices(field: BoardField, now: number, keep?: number): IterationRange[] {
  const cur = iterationAt(field, now)
  const first = iterationRange(field, 0)
  const at = cur ?? (first !== null && now < first.startMs ? 0 : null)
  const ks = new Set<number>()
  if (at !== null) for (let k = Math.max(0, at - 2); k <= at + 5; k++) ks.add(k)
  if (keep !== undefined) ks.add(keep)
  return [...ks]
    .sort((a, b) => a - b)
    .map((k) => iterationRange(field, k))
    .filter((r): r is IterationRange => r !== null)
}

/** What a typed value means for `field`: a value, null (cleared), or why it is refused. */
export function parseFieldInput(field: BoardField, raw: string): { readonly value: FieldValue | null } | { readonly error: string } {
  const t = raw.trim()
  if (t === '') return { value: null }
  let v: FieldValue
  switch (field.type) {
    case 'num':
      v = Number(t)
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return { error: 'Enter a number.' }
      break
    case 'sel':
    case 'iter':
      v = Number(t)
      break
    default:
      v = t
  }
  if (fieldValueOk(field, v)) return { value: v === 0 ? 0 : v }
  switch (field.type) {
    case 'num':
      return { error: 'Numbers go up to 10^15, and down to 0.000001 apart from 0.' }
    case 'date':
      return { error: 'Enter a date.' }
    case 'text':
      return { error: 'Text is at most 200 characters.' }
    default:
      return { error: `That isn't one of ${field.name}'s values.` }
  }
}

/**
 * The editor of one field value: a select for a single-select or iteration field (a choice is
 * written at once), an input for a number, date or text (written on Enter or when it loses
 * focus; Escape cancels). An empty value clears it. `onCommit` gets the new value only when it
 * differs.
 */
export function FieldInput({
  field,
  value,
  now,
  onCommit,
  onCancel,
  id,
  label,
  autoFocus = false,
  disabled = false,
  className,
}: {
  readonly field: BoardField
  readonly value: FieldValue | undefined
  readonly now: number
  readonly onCommit: (value: FieldValue | null) => void
  readonly onCancel?: () => void
  readonly id?: string
  /** The accessible name (the field's, by default). */
  readonly label?: string
  readonly autoFocus?: boolean
  readonly disabled?: boolean
  readonly className?: string
}): JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
    setError(null)
  }, [value])
  const name = label ?? field.name
  const commit = (raw: string): void => {
    const parsed = parseFieldInput(field, raw)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    if ((parsed.value ?? undefined) !== value) onCommit(parsed.value)
    else onCancel?.()
  }
  if (field.type === 'sel' || field.type === 'iter') {
    const choices = field.type === 'sel' ? (field.options ?? []).map((o) => ({ v: String(o.id), name: o.name })) : iterationChoices(field, now, typeof value === 'number' ? value : undefined).map((r) => ({ v: String(r.index), name: `${r.name} (${dayRangeText(r.start, r.end)})` }))
    return (
      <select
        id={id}
        aria-label={name}
        value={value === undefined ? '' : String(value)}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel?.()
          }
        }}
        onBlur={() => onCancel?.()}
        className={cn(controlClass, 'w-full min-w-0', className)}
      >
        <option value="">{`No ${field.name.toLowerCase()}`}</option>
        {choices.map((c) => (
          <option key={c.v} value={c.v}>
            {c.name}
          </option>
        ))}
      </select>
    )
  }
  return (
    <span className="block min-w-0">
      <input
        id={id}
        aria-label={name}
        aria-invalid={error !== null || undefined}
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'num' ? 'decimal' : undefined}
        maxLength={field.type === 'text' ? 200 : undefined}
        value={draft}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            done.current = true
            commit(draft)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            done.current = true
            setDraft(value === undefined ? '' : String(value))
            setError(null)
            onCancel?.()
          }
        }}
        onBlur={() => {
          // Enter and Escape already settled it; a click elsewhere writes what was typed.
          if (done.current) {
            done.current = false
            return
          }
          commit(draft)
        }}
        className={cn(controlClass, 'w-full min-w-0', field.type === 'num' && 'font-mono tabular-nums', className)}
      />
      {error !== null ? (
        <span role="alert" className="mt-0.5 block text-[11px] text-danger-700 dark:text-danger-400">
          {error}
        </span>
      ) : null}
    </span>
  )
}

/** The Status select: every column, and "No status" while the item has none. */
export function StatusSelect({
  spec,
  value,
  onChange,
  onCancel,
  id,
  label = 'Status',
  autoFocus = false,
  disabled = false,
  className,
}: {
  readonly spec: BoardSpec
  readonly value: number
  readonly onChange: (col: number) => void
  readonly onCancel?: () => void
  readonly id?: string
  readonly label?: string
  readonly autoFocus?: boolean
  readonly disabled?: boolean
  readonly className?: string
}): JSX.Element {
  return (
    <select
      id={id}
      aria-label={label}
      value={String(value)}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(e) => {
        const col = Number(e.target.value)
        if (col !== value) onChange(col)
        else onCancel?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel?.()
        }
      }}
      onBlur={() => onCancel?.()}
      className={cn(controlClass, 'w-full min-w-0', className)}
    >
      {value === 0 || !spec.columns.some((c) => c.id === value) ? <option value="0">No status</option> : null}
      {spec.columns.map((c) => (
        <option key={c.id} value={String(c.id)}>
          {c.name}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------------------------
// Groups (§4.1, §4.2)
// ---------------------------------------------------------------------------------------------

/**
 * A group's heading, for a view grouped by `by` (`groupRows`' keys): a column or option with its
 * colour, an iteration with its dates, a person, a label, a milestone, a repository (named as
 * `items` name it); "No <key>" for the empty group.
 */
export function GroupHeading({ spec, by, groupKey, items }: { readonly spec: BoardSpec; readonly by: string; readonly groupKey: string | number | null; readonly items: readonly BoardItem[] }): JSX.Element {
  const field = (() => {
    const id = fieldKeyId(by)
    return id === null ? undefined : spec.fields.find((f) => f.id === id)
  })()
  if (by === 'status') {
    const col = spec.columns.find((c) => c.id === groupKey)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ColorDot color={col?.color} />
        <span className="truncate">{col?.name ?? 'No status'}</span>
      </span>
    )
  }
  if (groupKey === null) return <span>{`No ${viewKeyLabel(spec, by).toLowerCase()}`}</span>
  if (field?.type === 'sel') {
    const opt = field.options?.find((o) => o.id === groupKey)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ColorDot color={opt?.color} />
        <span className="truncate">{opt?.name ?? String(groupKey)}</span>
      </span>
    )
  }
  if (field?.type === 'iter' && typeof groupKey === 'number') {
    const r = iterationRange(field, groupKey)
    return (
      <span className="inline-flex min-w-0 items-baseline gap-2">
        <span className="truncate">{iterationName(field, groupKey)}</span>
        {r !== null ? <span className="text-[12px] font-normal text-anvil-500 dark:text-anvil-400">{dayRangeText(r.start, r.end)}</span> : null}
      </span>
    )
  }
  switch (by) {
    case 'assignee':
      return <Author identityId={String(groupKey)} link={false} />
    case 'label':
      return <LabelChip name={String(groupKey)} />
    case 'repo':
      return <span className="font-mono">{items.find((i) => i.repoId === groupKey)?.repo ?? String(groupKey)}</span>
    default:
      return <span className="truncate">{String(groupKey)}</span>
  }
}
