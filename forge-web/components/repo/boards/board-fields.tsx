'use client'

/**
 * Pieces the board layouts, the board settings and the issue sidebar share (design
 * `docs/design/boards.md` §2.2, §4, §5.6): board URLs, how a field value and a view key read,
 * the editor of one field value and the Status select, an item's state icon, a colour dot.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleDot } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { STATE_TEXT } from '@/lib/design/state'
import { DAY_MS, dateDays, fieldOfKey, fieldValueOk, iterationAt, iterationRange, type BoardField, type BoardItem, type BoardSpec, type FieldValue, type IterationRange } from '@/lib/rules/boards'
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
  return BUILTIN_KEY_LABEL[k] ?? fieldOfKey(spec.fields, k)?.name ?? k
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

/** A colour dot and a label beside it, truncated (a column, an option). */
export function DotLabel({ color, children, className }: { readonly color?: string | undefined; readonly children: ReactNode; readonly className?: string }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ColorDot color={color} />
      <span className={cn('truncate', className)}>{children}</span>
    </span>
  )
}

/** An issue's or PR's state icon, as the lists draw it, with its name for screen readers. */
export function ItemStateIcon({ item, className, decorative = false }: { readonly item: Pick<BoardItem, 'kind' | 'state'>; readonly className?: string; /** The state is said in words beside it: no screen-reader text of its own. */ readonly decorative?: boolean }): JSX.Element {
  if (item.kind === 'pr') {
    const v = pullStateView({ open: item.state === 'open', merged: item.state === 'merged' })
    return (
      <>
        <v.Icon className={cn('h-4 w-4 shrink-0', v.klass, className)} aria-hidden />
        {decorative ? null : <span className="sr-only">{`${v.label} pull request`}</span>}
      </>
    )
  }
  const open = item.state === 'open'
  const Icon = open ? CircleDot : CheckCircle2
  return (
    <>
      <Icon className={cn('h-4 w-4 shrink-0', open ? STATE_TEXT.open : STATE_TEXT.done, className)} aria-hidden />
      {decorative ? null : <span className="sr-only">{open ? 'Open issue' : 'Closed issue'}</span>}
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
 * A select whose choice is written at once when made with the pointer, but when made with the
 * keyboard (the arrows step through a closed select's options, which fires `change` on Windows
 * and Linux) only on Enter or when the select is left: stepping past three options is one write,
 * not three. Escape puts it back.
 */
function PickSelect({
  value,
  onPick,
  onCancel,
  id,
  label,
  title,
  autoFocus,
  disabled,
  className,
  children,
}: {
  readonly value: string
  readonly onPick: (v: string) => void
  readonly onCancel?: (() => void) | undefined
  readonly id?: string | undefined
  readonly label: string
  readonly title?: string | undefined
  readonly autoFocus: boolean
  readonly disabled: boolean
  readonly className?: string | undefined
  readonly children: ReactNode
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  // the change came from the keyboard: wait for Enter or the blur
  const keyed = useRef(false)
  // this select was just settled (picked or put back): its blur writes nothing more
  const settled = useRef(false)
  const pick = (v: string): void => {
    settled.current = true
    keyed.current = false
    if (v !== value) onPick(v)
    else onCancel?.()
  }
  return (
    <select
      id={id}
      aria-label={label}
      title={title}
      value={draft}
      autoFocus={autoFocus}
      disabled={disabled}
      onPointerDown={() => {
        keyed.current = false
        settled.current = false
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        if (!keyed.current) pick(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          pick(draft)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          keyed.current = false
          settled.current = true
          setDraft(value)
          onCancel?.()
        } else if (e.key !== 'Tab' && e.key !== 'Shift') {
          keyed.current = true
          settled.current = false
        }
      }}
      onBlur={() => {
        keyed.current = false
        if (settled.current) {
          settled.current = false
          return
        }
        if (draft !== value) onPick(draft)
        else onCancel?.()
      }}
      className={cn(controlClass, 'w-full min-w-0', className)}
    >
      {children}
    </select>
  )
}

/**
 * The editor of one field value: a select for a single-select or iteration field (see
 * {@link PickSelect}), an input for a number, date or text (written on Enter or when it loses
 * focus; Escape puts it back, as does leaving it with a value it refuses). An empty value clears
 * it. `onCommit` gets the new value only when it differs; `onCancel` is told when an edit ends
 * without one.
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
  const text = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState<string | null>(null)
  // Enter or Escape settled the edit: the blur that may follow writes nothing more
  const settled = useRef(false)
  useEffect(() => {
    setDraft(text)
    setError(null)
  }, [text])
  const name = label ?? field.name
  /** Write `raw` if it is a value and differs; false when it is refused. */
  const commit = (raw: string): boolean => {
    const parsed = parseFieldInput(field, raw)
    if ('error' in parsed) {
      setError(parsed.error)
      return false
    }
    setError(null)
    if ((parsed.value ?? undefined) !== value) onCommit(parsed.value)
    else onCancel?.()
    return true
  }
  const putBack = (): void => {
    setDraft(text)
    setError(null)
    onCancel?.()
  }
  if (field.type === 'sel' || field.type === 'iter') {
    const choices = field.type === 'sel' ? (field.options ?? []).map((o) => ({ v: String(o.id), name: o.name })) : iterationChoices(field, now, typeof value === 'number' ? value : undefined).map((r) => ({ v: String(r.index), name: `${r.name} (${dayRangeText(r.start, r.end)})` }))
    return (
      <PickSelect id={id} label={name} value={text} autoFocus={autoFocus} disabled={disabled} className={className} onPick={(v) => void commit(v)} onCancel={onCancel}>
        <option value="">{`No ${field.name.toLowerCase()}`}</option>
        {choices.map((c) => (
          <option key={c.v} value={c.v}>
            {c.name}
          </option>
        ))}
      </PickSelect>
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
        onChange={(e) => {
          settled.current = false
          setDraft(e.target.value)
        }}
        onFocus={() => {
          settled.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            // a refused value stays, with its reason, to be fixed
            if (commit(draft)) settled.current = true
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            settled.current = true
            putBack()
          }
        }}
        onBlur={() => {
          if (settled.current) {
            settled.current = false
            return
          }
          // leaving with a refused value puts the old one back rather than strand the edit
          if (!commit(draft)) putBack()
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

/** Why a closed item's Status offers no column before Done (§2.4 rule 1). */
export const CLOSED_STAYS_DONE = 'Closed items show in Done, or in a column after it.'

/**
 * The Status select: every column, and "No status" while the item has none. For a closed or
 * merged item (`closed`) the columns before Done are offered but disabled: the board shows it in
 * Done whatever its card says (§2.4 rule 1), so such a move would change nothing.
 */
export function StatusSelect({
  spec,
  value,
  onChange,
  onCancel,
  closed = false,
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
  /** The item is closed or merged. */
  readonly closed?: boolean
  readonly id?: string
  readonly label?: string
  readonly autoFocus?: boolean
  readonly disabled?: boolean
  readonly className?: string
}): JSX.Element {
  const doneAt = spec.done === 0 ? -1 : spec.columns.findIndex((c) => c.id === spec.done)
  const held = closed && doneAt >= 0
  return (
    <PickSelect id={id} label={label} title={held ? CLOSED_STAYS_DONE : undefined} value={String(value)} autoFocus={autoFocus} disabled={disabled} className={className} onPick={(v) => onChange(Number(v))} onCancel={onCancel}>
      {value === 0 || !spec.columns.some((c) => c.id === value) ? (
        <option value="0" disabled={held}>
          No status
        </option>
      ) : null}
      {spec.columns.map((c, i) => (
        <option key={c.id} value={String(c.id)} disabled={held && i < doneAt}>
          {c.name}
        </option>
      ))}
    </PickSelect>
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
  const field = fieldOfKey(spec.fields, by)
  if (by === 'status') {
    const col = spec.columns.find((c) => c.id === groupKey)
    return <DotLabel color={col?.color}>{col?.name ?? 'No status'}</DotLabel>
  }
  if (groupKey === null) return <span>{`No ${viewKeyLabel(spec, by).toLowerCase()}`}</span>
  if (field?.type === 'sel') {
    const opt = field.options?.find((o) => o.id === groupKey)
    return <DotLabel color={opt?.color}>{opt?.name ?? String(groupKey)}</DotLabel>
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
