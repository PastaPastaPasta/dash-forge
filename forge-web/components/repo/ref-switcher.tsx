'use client'

/**
 * RefSwitcher — the branch/tag dropdown on browse views (home, tree, blob, commits). Switching
 * navigates the current route with a `?ref=` param (dropped for the default branch, keeping
 * canonical URLs clean) and preserves the `path` param so a switch stays on the same file/dir.
 */

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, ChevronDown, GitBranch, Tag } from 'lucide-react'
import type { RepoHome, SelectedRef } from '@/lib/view'
import { refParamFor } from '@/lib/view'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { cn } from '@/lib/utils'

export function RefSwitcher({
  home,
  addr,
  current,
  path,
}: {
  home: RepoHome
  addr: RepoAddress
  current: SelectedRef
  /** The `path` param to preserve across a switch (tree/blob views). */
  path?: string
}): JSX.Element {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const hrefFor = (shortName: string, isTag: boolean): string => {
    const ref = refParamFor(shortName, isTag, home.defaultBranch)
    return repoHref(pathname, addr, {
      ...(path ? { path } : {}),
      ...(ref ? { ref } : {}),
    })
  }

  const CurrentIcon = current.isTag ? Tag : GitBranch

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-anvil-200 bg-white px-2.5 py-1 text-dense text-anvil-700 transition-colors hover:border-anvil-300 dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200 dark:hover:border-anvil-600"
      >
        <CurrentIcon className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
        <span className="max-w-[180px] truncate font-mono">{current.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Switch branch or tag"
            className="absolute left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-anvil-200 bg-white py-1 shadow-lg dark:border-anvil-750 dark:bg-anvil-900"
          >
            <RefGroup
              label="Branches"
              names={home.branches.map((b) => b.refName.replace(/^refs\/heads\//, ''))}
              icon={GitBranch}
              current={current}
              isTagGroup={false}
              hrefFor={hrefFor}
              onPick={() => setOpen(false)}
            />
            {home.tags.length > 0 ? (
              <RefGroup
                label="Tags"
                names={home.tags.map((t) => t.refName.replace(/^refs\/tags\//, ''))}
                icon={Tag}
                current={current}
                isTagGroup
                hrefFor={hrefFor}
                onPick={() => setOpen(false)}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** The bad-`?ref=` empty state shared by the browse views, with a way back to the default. */
export function RefNotFoundState({
  addr,
  refParam,
  defaultBranch,
}: {
  addr: RepoAddress
  refParam: string
  defaultBranch: string
}): JSX.Element {
  return (
    <EmptyState
      icon={GitBranch}
      title="Ref not found"
      body={`No branch or tag named ${refParam} in this repo.`}
      action={
        <Link href={repoHref('/repo', addr)}>
          <Button variant="primary">Back to {defaultBranch}</Button>
        </Link>
      }
    />
  )
}

function RefGroup({
  label,
  names,
  icon: Icon,
  current,
  isTagGroup,
  hrefFor,
  onPick,
}: {
  label: string
  names: readonly string[]
  icon: typeof GitBranch
  current: SelectedRef
  isTagGroup: boolean
  hrefFor: (shortName: string, isTag: boolean) => string
  onPick: () => void
}): JSX.Element {
  return (
    <div>
      <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-anvil-400">{label}</div>
      {[...names].sort((a, b) => a.localeCompare(b)).map((name) => {
        const active = current.isTag === isTagGroup && current.name === name
        return (
          <Link
            key={name}
            role="option"
            aria-selected={active}
            href={hrefFor(name, isTagGroup)}
            onClick={onPick}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-dense hover:bg-anvil-50 dark:hover:bg-anvil-850',
              active ? 'text-anvil-900 dark:text-anvil-50' : 'text-anvil-600 dark:text-anvil-300',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-400" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
            {active ? <Check className="h-3.5 w-3.5 shrink-0 text-forge-500" aria-hidden /> : null}
          </Link>
        )
      })}
    </div>
  )
}
