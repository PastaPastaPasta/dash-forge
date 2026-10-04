'use client'

/**
 * Change an open PR's base branch (GitHub's "Edit" → base picker): one member event, kind 8
 * (`dg pr edit --base`). The base must be a branch of this repo now, and not the PR's own source
 * branch, the same checks `dg` makes before it signs.
 */

import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { disabledField } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** `main` for `refs/heads/main`. */
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/** The branches an open PR can be retargeted to: every branch but its current base and its own source. */
export function baseChoices(branches: readonly string[], current: string, source: string | null): string[] {
  return branches.filter((b) => b.startsWith('refs/heads/') && b !== current && b !== source).sort((a, b) => short(a).localeCompare(short(b)))
}

export function EditBase({
  branches,
  current,
  source,
  disabledReason,
  onPick,
}: {
  /** The repo's branches now (full ref names). */
  branches: readonly string[]
  /** The base the PR merges into now. */
  current: string
  /** The PR's source branch when it is in this repo (it can't be its own base). */
  source: string | null
  /** Why the viewer can't sign now, if they can't. */
  disabledReason: string | null
  /** Ask to retarget to `base` (the caller confirms and signs). */
  onPick: (base: string) => void
}) {
  const choices = baseChoices(branches, current, source)
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')
  if (choices.length === 0) return null
  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5"
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
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <label htmlFor="pr-base-select" className="sr-only">
        New base branch
      </label>
      <select
        id="pr-base-select"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className={cn('rounded-md border border-anvil-300 bg-white px-2 py-0.5 font-mono text-dense dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11', disabledField)}
      >
        {choices.map((b) => (
          <option key={b} value={b}>
            {short(b)}
          </option>
        ))}
      </select>
      <Button
        variant="primary"
        size="sm"
        disabled={pick === '' || disabledReason !== null}
        onClick={() => {
          setOpen(false)
          onPick(pick)
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
