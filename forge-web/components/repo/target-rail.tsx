'use client'

/**
 * The right rail an issue and a PR share (platform-parity-spec §1.2, review-parity P4): a
 * section heading, the assignee picker, the label picker and the milestone picker. Members assign
 * and label with a member `event`; the pages confirm and sign.
 *
 * The label and assignee pickers work as GitHub's (QW2-046): ticks are a draft, and closing the
 * picker (Escape, a click outside it, or Apply) hands the whole change to the page at once, for one
 * confirm. Cancel drops the draft.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import { Plus, Settings2, X, type LucideIcon } from 'lucide-react'
import { LABEL_COLORS, LABEL_LIMITS, type LabelDef } from '@/lib/repo'
import { isIdentityId } from '@/lib/utils'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckMark, LabelChip } from '@/components/repo/issue-bits'
import { cn } from '@/lib/utils'
import type { Milestone } from '@/lib/rules/parity'

export function SidebarSection({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b border-anvil-200 pb-4 dark:border-anvil-800">
      <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </h2>
      {children}
    </section>
  )
}

/** A set change a picker hands to its page: what to add and what to remove. */
export interface SetChange {
  readonly add: readonly string[]
  readonly remove: readonly string[]
}

/**
 * The change the viewer's ticks make to `applied`: each ticked value's wanted state (true: on)
 * against what is applied now, or null when none differs. Only what was ticked counts, so a
 * re-read that lands while the picker is open (the page's own write showing, another member's
 * label) never turns into a change the viewer did not make.
 */
export function setChange(applied: readonly string[], ticks: ReadonlyMap<string, boolean>): SetChange | null {
  const now = new Set(applied)
  const add = [...ticks].filter(([x, on]) => on && !now.has(x)).map(([x]) => x)
  const remove = [...ticks].filter(([x, on]) => !on && now.has(x)).map(([x]) => x)
  return add.length === 0 && remove.length === 0 ? null : { add, remove }
}

/** Run `write` for every value `change` adds, then every one it removes, each under its own intent. */
export async function applySetChange(change: SetChange, intent: string, write: (value: string, add: boolean, intent: string) => Promise<unknown>): Promise<void> {
  for (const value of change.add) await write(value, true, `${intent}:add:${value}`)
  for (const value of change.remove) await write(value, false, `${intent}:remove:${value}`)
}

/** Whether a thread's values show every change of `change`. */
export function setChangeShows(values: readonly string[], change: SetChange): boolean {
  return change.add.every((v) => values.includes(v)) && !change.remove.some((v) => values.includes(v))
}

/** The close / reopen button's words, as GitHub's: "Close with comment" while the composer holds text. */
export function stateToggleLabel(open: boolean, withComment: boolean, noun: 'issue' | 'pull request'): string {
  if (withComment) return open ? 'Close with comment' : 'Reopen with comment'
  return open ? `Close ${noun}` : `Reopen ${noun}`
}

/** Close a popover on Escape and on a pointer press outside `ref` while it is open. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement>, onDismiss: () => void): void {
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        dismiss.current()
      }
    }
    const onPointer = (e: PointerEvent): void => {
      if (ref.current !== null && e.target instanceof Node && !ref.current.contains(e.target)) dismiss.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, ref])
}

/**
 * A multi-select picker's state: open or not, and the draft selection while open. Closing it
 * (Escape, a click outside, Apply) hands the change, if any, to `onApply`; `cancel` drops it.
 */
function useDraftPicker(applied: readonly string[], onApply: (change: SetChange) => void): {
  readonly open: boolean
  readonly draft: ReadonlySet<string>
  readonly change: SetChange | null
  readonly ref: RefObject<HTMLDivElement>
  readonly toggleOpen: () => void
  readonly toggle: (x: string) => void
  readonly add: (x: string) => void
  readonly close: () => void
  readonly cancel: () => void
} {
  // The values the viewer ticked while open, each with the state they want; null when closed.
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean> | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const open = ticks !== null
  const on = (x: string): boolean => ticks?.get(x) ?? applied.includes(x)
  const current = new Set([...applied, ...(ticks?.keys() ?? [])].filter(on))
  const change = ticks === null ? null : setChange(applied, ticks)
  const close = (): void => {
    setTicks(null)
    if (change !== null) onApply(change)
  }
  const tick = (x: string, want: boolean): void => setTicks(new Map([...(ticks ?? []), [x, want]]))
  useDismiss(open, ref, close)
  return {
    open,
    draft: current,
    change,
    ref,
    toggleOpen: () => (open ? close() : setTicks(new Map())),
    toggle: (x) => tick(x, !on(x)),
    add: (x) => tick(x, true),
    close,
    cancel: () => setTicks(null),
  }
}

/** The picker's footer: how many changes are pending, Apply, and Cancel. */
function DraftFooter({ change, onApply, onCancel }: { change: SetChange | null; onApply: () => void; onCancel: () => void }): JSX.Element | null {
  if (change === null) return null
  const n = change.add.length + change.remove.length
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-anvil-200 pt-2 dark:border-anvil-750" data-testid="picker-footer">
      <span className="text-[12px] text-anvil-500 dark:text-anvil-400">{n === 1 ? '1 change' : `${n} changes`}</span>
      <span className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onApply}>
          Apply
        </Button>
      </span>
    </div>
  )
}

/** The milestone, and for members a picker of the repo's open milestones (set / clear). */
export function MilestonePicker({
  current,
  choices,
  loading,
  canDefine,
  canEdit,
  onChoose,
  manageHref,
}: {
  current: string | null
  choices: readonly Pick<Milestone, 'title' | 'closed'>[]
  /** The milestones are still being read. */
  loading: boolean
  /** Whether a milestone can be defined here (not yet in a private repo). */
  canDefine: boolean
  canEdit: boolean
  onChoose: (title: string | null) => void
  /** The repo's Milestones page (QW-019): where a member creates and manages them. */
  manageHref?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => setOpen(false))
  const anyOpen = choices.some((c) => !c.closed)
  return (
    <div data-testid="milestone" ref={ref}>
      {current === null ? (
        <p className="text-anvil-500 dark:text-anvil-400">No milestone</p>
      ) : (
        <p className="font-medium text-anvil-800 dark:text-anvil-100">{current}</p>
      )}
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400 coarse:min-h-11">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Set milestone
          </button>
          {open ? (
            <ul className="mt-1 space-y-1" aria-label="Milestones">
              {choices.filter((c) => !c.closed).map((c) => (
                <li key={c.title}>
                  <button type="button" className="hit-area text-left hover:underline" onClick={() => { setOpen(false); onChoose(c.title) }} disabled={c.title === current}>
                    {c.title}
                  </button>
                </li>
              ))}
              {loading ? (
                <li className="text-[12px] text-anvil-500 dark:text-anvil-400">Reading milestones…</li>
              ) : !anyOpen ? (
                <li className="text-[12px] text-anvil-500 dark:text-anvil-400">No open milestones</li>
              ) : null}
              {canDefine && manageHref ? (
                <li>
                  {/* With none open the page opens on its New milestone form; otherwise on the list. */}
                  <Link
                    href={anyOpen ? manageHref : `${manageHref}${manageHref.includes('?') ? '&' : '?'}new=1`}
                    className="hit-area inline-flex items-center gap-1 text-[12px] text-forge-700 hover:underline dark:text-forge-400"
                    data-testid="manage-milestones"
                  >
                    {anyOpen ? <Settings2 className="h-3 w-3" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />} {anyOpen ? 'Manage milestones' : 'Create a milestone'}
                  </Link>
                </li>
              ) : null}
              {current !== null ? (
                <li>
                  <button type="button" className="hit-area text-left text-danger-700 hover:underline dark:text-danger-400" onClick={() => { setOpen(false); onChoose(null) }}>
                    Clear the milestone
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The assignees, and for members a picker of the repo’s members (assign / unassign). */
export function AssigneePicker({
  assignees,
  members,
  canEdit,
  onApply,
}: {
  assignees: readonly string[]
  members: readonly string[]
  canEdit: boolean
  /** The assignees to add and remove, together (one confirm). */
  onApply: (change: SetChange) => void
}): JSX.Element {
  const picker = useDraftPicker(assignees, onApply)
  const { open, draft } = picker
  const [other, setOther] = useState('')
  const candidates = [...new Set([...assignees, ...members, ...draft])]
  return (
    <div ref={picker.ref}>
      {assignees.length === 0 ? <p className="text-anvil-500 dark:text-anvil-400">No one assigned</p> : null}
      <ul className="space-y-1.5" aria-label="Assignees">
        {assignees.map((a) => (
          <li key={a} className="flex items-center gap-2">
            <Author identityId={a} />
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={picker.toggleOpen} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400 coarse:min-h-11">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit assignees
          </button>
          {open ? (
            <div className="mt-2 space-y-1 rounded-md border border-anvil-200 p-2 dark:border-anvil-750" role="group" aria-label="Choose assignees">
              {candidates.map((m) => {
                const on = draft.has(m)
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => picker.toggle(m)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
                    data-testid="assignee-option"
                    data-identity={m}
                  >
                    <CheckMark on={on} />
                    <Author identityId={m} link={false} />
                  </button>
                )
              })}
              <div className="flex gap-1 pt-1">
                <Input aria-label="Assign identity id" value={other} onChange={(e) => setOther(e.target.value)} placeholder="identity id" className="h-7 py-0 font-mono text-[12px]" />
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Add this identity"
                  title="Add"
                  disabled={!isIdentityId(other.trim())}
                  onClick={() => {
                    picker.add(other.trim())
                    setOther('')
                  }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
              <DraftFooter change={picker.change} onApply={picker.close} onCancel={picker.cancel} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The applied labels, and for members a picker of the defined labels plus a create form. */
export function LabelPicker({
  applied,
  defs,
  byName,
  canEdit,
  onApply,
  onDefine,
  manageHref,
}: {
  applied: readonly string[]
  defs: readonly LabelDef[]
  byName: ReadonlyMap<string, LabelDef>
  canEdit: boolean
  /** The labels to add and remove, together (one confirm). */
  onApply: (change: SetChange) => void
  onDefine: (name: string, color: string, description: string) => void
  /** The repo's Labels page (QW-019): rename-free edits, colours, descriptions and deletes. */
  manageHref?: string
}): JSX.Element {
  const picker = useDraftPicker(applied, onApply)
  const { open, draft } = picker
  const [filter, setFilter] = useState('')
  const [color, setColor] = useState(LABEL_COLORS[5] ?? '#1d76db')
  const [description, setDescription] = useState('')
  const names = [...new Set([...defs.filter((d) => !d.retired).map((d) => d.name), ...applied])]
  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()))
  const newName = filter.trim()
  const canCreate = newName !== '' && [...newName].length <= LABEL_LIMITS.name && !names.some((n) => n.toLowerCase() === newName.toLowerCase())
  return (
    <div ref={picker.ref}>
      {applied.length === 0 ? <p className="text-anvil-500 dark:text-anvil-400">None yet</p> : null}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Applied labels">
        {applied.map((l) => (
          <LabelChip key={l} name={l} def={byName.get(l)}>
            {canEdit ? (
              <button type="button" aria-label={`Remove label ${l}`} onClick={() => (open ? picker.toggle(l) : onApply({ add: [], remove: [l] }))} className="opacity-70 hover:opacity-100">
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </LabelChip>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={picker.toggleOpen} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400 coarse:min-h-11">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit labels
          </button>
          {open ? (
            <div className="mt-2 space-y-2 rounded-md border border-anvil-200 p-2 dark:border-anvil-750">
              <Input aria-label="Filter or create a label" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter or new label" className="h-7 py-0 text-[12px]" maxLength={LABEL_LIMITS.name} />
              <div className="max-h-56 space-y-0.5 overflow-auto" role="group" aria-label="Choose labels">
                {shown.map((n) => {
                  const on = draft.has(n)
                  const def = byName.get(n)
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      onClick={() => picker.toggle(n)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
                      data-testid="label-option"
                    >
                      <CheckMark on={on} />
                      <LabelChip name={n} def={def} />
                      {def?.description ? <span className="truncate text-[11px] text-anvil-500 dark:text-anvil-400">{def.description}</span> : null}
                    </button>
                  )
                })}
              </div>
              {canCreate ? (
                <div className="space-y-2 border-t border-anvil-200 pt-2 dark:border-anvil-750">
                  <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Create “{newName}” for this repo:</p>
                  <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Label colour">
                    {LABEL_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={color === c}
                        aria-label={`Colour ${c}`}
                        onClick={() => setColor(c)}
                        className={cn('h-5 w-5 rounded-full border', color === c ? 'border-anvil-900 ring-2 ring-forge-500 dark:border-white' : 'border-transparent')}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <Input aria-label="Label description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-7 py-0 text-[12px]" maxLength={LABEL_LIMITS.description} />
                  <div className="flex items-center gap-2">
                    <LabelChip name={newName} def={{ name: newName, color, description, retired: false, createdAt: 0, id: '' }} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Creating a label is its own confirm: the ticks made so far are dropped, not applied behind it.
                        picker.cancel()
                        onDefine(newName, color, description)
                      }}
                    >
                      Create label
                    </Button>
                  </div>
                </div>
              ) : null}
              {manageHref ? (
                <Link href={manageHref} className="hit-area mt-2 inline-flex text-[12px] text-forge-700 hover:underline dark:text-forge-400" data-testid="manage-labels">
                  Edit labels
                </Link>
              ) : null}
              <DraftFooter change={picker.change} onApply={picker.close} onCancel={picker.cancel} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A few names, then "and N more". */
function nameList(xs: readonly string[], show: (x: string) => string): string {
  const shown = xs.slice(0, 3).map(show)
  return xs.length > 3 ? `${shown.join(', ')} and ${xs.length - 3} more` : shown.join(', ')
}

/** The confirm for a label picker's change: every label added and removed, one event each. */
export function labelsConfirm(change: SetChange): { title: string; description: string; label: string } {
  const n = change.add.length + change.remove.length
  const parts = [
    change.add.length > 0 ? `adds ${nameList(change.add, (l) => `"${l}"`)}` : null,
    change.remove.length > 0 ? `removes ${nameList(change.remove, (l) => `"${l}"`)}` : null,
  ].filter((x) => x !== null)
  return {
    title: n === 1 ? `${change.add.length === 1 ? 'Add' : 'Remove'} label "${change.add[0] ?? change.remove[0]}"` : `Change ${n} labels`,
    description: `${n === 1 ? 'One label event' : `${n} label events, signed together,`} ${parts.join(' and ')}. Only maintainers and writers can label.`,
    label: n === 1 ? 'Sign & label' : `Sign ${n} changes`,
  }
}

/** The confirm for an assignee picker's change. */
export function assigneesConfirm(change: SetChange): { title: string; description: string; label: string } {
  const n = change.add.length + change.remove.length
  const short = (id: string): string => `${id.slice(0, 10)}…`
  const parts = [change.add.length > 0 ? `assigns ${nameList(change.add, short)}` : null, change.remove.length > 0 ? `unassigns ${nameList(change.remove, short)}` : null].filter((x) => x !== null)
  const one = n === 1
  return {
    title: one ? (change.add.length === 1 ? 'Assign' : 'Remove assignee') : `Change ${n} assignees`,
    description: `${one ? 'A member event' : `${n} member events, signed together,`} ${parts.join(' and ')}. Each names the assignee as its addressee, so it shows up under "assigned to me".`,
    label: one ? (change.add.length === 1 ? 'Sign & assign' : 'Sign & unassign') : `Sign ${n} changes`,
  }
}
