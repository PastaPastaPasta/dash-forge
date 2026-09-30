'use client'

/**
 * The right rail an issue and a PR share (platform-parity-spec §1.2, review-parity P4): a
 * section heading, the assignee picker and the label picker. Members assign and label with a
 * member `event`; the pages confirm and sign.
 */

import { useState } from 'react'
import { Plus, Settings2, X, type LucideIcon } from 'lucide-react'
import { LABEL_COLORS, LABEL_LIMITS, type LabelDef } from '@/lib/repo'
import { isIdentityId } from '@/lib/utils'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LabelChip } from '@/components/repo/issue-bits'
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

/** The milestone, and for members a picker of the repo's open milestones (set / clear). */
export function MilestonePicker({
  current,
  choices,
  loading,
  canDefine,
  canEdit,
  onChoose,
}: {
  current: string | null
  choices: readonly Pick<Milestone, 'title' | 'closed'>[]
  /** The milestones are still being read. */
  loading: boolean
  /** Whether `dg milestone create` can define one here (not yet in a private repo). */
  canDefine: boolean
  canEdit: boolean
  onChoose: (title: string | null) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="milestone">
      {current === null ? (
        <p className="text-anvil-500 dark:text-anvil-400">No milestone</p>
      ) : (
        <p className="font-medium text-anvil-800 dark:text-anvil-100">{current}</p>
      )}
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400">
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
              ) : choices.every((c) => c.closed) ? (
                <li className="text-[12px] text-anvil-500 dark:text-anvil-400">{canDefine ? 'No open milestones (`dg milestone create`)' : 'No open milestones'}</li>
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
  onToggle,
}: {
  assignees: readonly string[]
  members: readonly string[]
  canEdit: boolean
  onToggle: (who: string, remove: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [other, setOther] = useState('')
  const candidates = [...new Set([...assignees, ...members])]
  return (
    <div>
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
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit assignees
          </button>
          {open ? (
            <div className="mt-2 space-y-1 rounded-md border border-anvil-200 p-2 dark:border-anvil-750" role="group" aria-label="Choose assignees">
              {candidates.map((m) => {
                const on = assignees.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggle(m, on)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850"
                    data-testid="assignee-option"
                    data-identity={m}
                  >
                    <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                    <Author identityId={m} link={false} />
                  </button>
                )
              })}
              <div className="flex gap-1 pt-1">
                <Input aria-label="Assign identity id" value={other} onChange={(e) => setOther(e.target.value)} placeholder="identity id" className="h-7 py-0 font-mono text-[12px]" />
                <Button variant="outline" size="sm" disabled={!isIdentityId(other.trim())} onClick={() => onToggle(other.trim(), false)}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
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
  onToggle,
  onDefine,
}: {
  applied: readonly string[]
  defs: readonly LabelDef[]
  byName: ReadonlyMap<string, LabelDef>
  canEdit: boolean
  onToggle: (label: string, remove: boolean) => void
  onDefine: (name: string, color: string, description: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [color, setColor] = useState(LABEL_COLORS[5] ?? '#1d76db')
  const [description, setDescription] = useState('')
  const names = [...new Set([...defs.filter((d) => !d.retired).map((d) => d.name), ...applied])]
  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()))
  const newName = filter.trim()
  const canCreate = newName !== '' && [...newName].length <= LABEL_LIMITS.name && !names.some((n) => n.toLowerCase() === newName.toLowerCase())
  return (
    <div>
      {applied.length === 0 ? <p className="text-anvil-500 dark:text-anvil-400">None yet</p> : null}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Applied labels">
        {applied.map((l) => (
          <LabelChip key={l} name={l} def={byName.get(l)}>
            {canEdit ? (
              <button type="button" aria-label={`Remove label ${l}`} onClick={() => onToggle(l, true)} className="opacity-70 hover:opacity-100">
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </LabelChip>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400 hover:text-forge-700 dark:hover:text-forge-400">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Edit labels
          </button>
          {open ? (
            <div className="mt-2 space-y-2 rounded-md border border-anvil-200 p-2 dark:border-anvil-750">
              <Input aria-label="Filter or create a label" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter or new label" className="h-7 py-0 text-[12px]" maxLength={LABEL_LIMITS.name} />
              <div className="max-h-56 space-y-0.5 overflow-auto" role="group" aria-label="Choose labels">
                {shown.map((n) => {
                  const on = applied.includes(n)
                  const def = byName.get(n)
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onToggle(n, on)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850"
                      data-testid="label-option"
                    >
                      <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
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
                    <Button variant="outline" size="sm" onClick={() => onDefine(newName, color, description)}>
                      Create label
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

