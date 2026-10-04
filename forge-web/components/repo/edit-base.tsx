'use client'

/**
 * Change an open PR's base branch (GitHub's "Edit" → base picker): one member event, kind 8
 * (`dg pr edit --base`). The base must be a branch of this repo now, and not the PR's own source
 * branch, the same checks `dg` makes before it signs.
 */

import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { disabledField } from '@/components/ui/input'
import { branchName } from '@/lib/view/format'
import { sortBranches } from '@/lib/view/refs'
import { cn } from '@/lib/utils'

/**
 * The branches an open PR can be retargeted to, in the branch pickers' order (the default branch
 * first): every branch but its current base and its own source.
 */
export function baseChoices(branches: readonly string[], current: string, source: string | null, defaultBranch: string): string[] {
  const kept = branches.filter((b) => b.startsWith('refs/heads/') && b !== current && b !== source)
  return sortBranches(
    kept.map((refName) => ({ refName })),
    defaultBranch,
  ).map((b) => b.refName)
}

export function EditBase({
  branches,
  current,
  source,
  defaultBranch,
  disabledReason,
  onPick,
}: {
  /** The repo's branches now (full ref names). */
  branches: readonly string[]
  /** The base the PR merges into now. */
  current: string
  /** The PR's source branch when it is in this repo (it can't be its own base). */
  source: string | null
  /** The repo's default branch (short), listed first. */
  defaultBranch: string
  /** Why the viewer can't sign now, if they can't. */
  disabledReason: string | null
  /** Ask to retarget to `base` (the caller confirms and signs). */
  onPick: (base: string) => void
}) {
  const choices = baseChoices(branches, current, source, defaultBranch)
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')
  const pencil = useRef<HTMLButtonElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  // Focus follows the control: into the picker when it opens, back to the pencil when it closes.
  const opened = useRef(false)
  useEffect(() => {
    if (open) select.current?.focus()
    else if (opened.current) pencil.current?.focus()
    opened.current = open
  }, [open])
  if (choices.length === 0) return null
  // The pick, or the first choice when a refresh took the pick away (the select shows the same).
  const chosen = choices.includes(pick) ? pick : (choices[0] ?? '')
  if (!open) {
    return (
      <Button
        ref={pencil}
        variant="ghost"
        size="sm"
        className="ml-1 h-6 px-1.5"
        aria-label="Change the base branch"
        title={disabledReason ?? 'Change the base branch'}
        disabled={disabledReason !== null}
        data-testid="pr-edit-base"
        onClick={() => {
          setPick(choices[0] ?? '')
          setOpen(true)
        }}
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </Button>
    )
  }
  return (
    <span className="ml-1.5 inline-flex flex-wrap items-center gap-1.5">
      <label htmlFor="pr-base-select" className="sr-only">
        New base branch
      </label>
      <select
        ref={select}
        id="pr-base-select"
        value={chosen}
        onChange={(e) => setPick(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        className={cn('rounded-md border border-anvil-300 bg-white px-2 py-0.5 font-mono text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11', disabledField)}
      >
        {choices.map((b) => (
          <option key={b} value={b}>
            {branchName(b)}
          </option>
        ))}
      </select>
      <Button
        variant="primary"
        size="sm"
        disabled={disabledReason !== null}
        onClick={() => {
          setOpen(false)
          onPick(chosen)
        }}
      >
        Change base
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  )
}
