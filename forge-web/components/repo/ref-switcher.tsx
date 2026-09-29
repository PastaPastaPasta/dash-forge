'use client'

/**
 * RefSwitcher — the branch/tag dropdown on browse views (home, tree, blob, commits). Switching
 * navigates the current route with a `?ref=` param (dropped for the default branch, keeping
 * canonical URLs clean) and preserves the `path` param so a switch stays on the same file/dir.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Check, ChevronDown, GitBranch, Search, Tag } from 'lucide-react'
import type { RepoHome, SelectedRef } from '@/lib/view'
import { findBranch, isLive, matchesRefQuery, refParamFor } from '@/lib/view'
import { compareTagNames } from '@/lib/repo'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/states'
import { cn } from '@/lib/utils'

/** One flattened, filterable, keyboard-navigable entry of the switcher's open list. */
interface RefEntry {
  readonly name: string
  readonly isTag: boolean
  readonly href: string
}

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
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const hrefFor = (shortName: string, isTag: boolean): string => {
    const ref = refParamFor(shortName, isTag, home.defaultBranch)
    return repoHref(pathname, addr, {
      ...(path ? { path } : {}),
      ...(ref ? { ref } : {}),
    })
  }

  const CurrentIcon = current.isTag ? Tag : GitBranch

  // Deleted (unborn) refs are not offered — there is nothing to browse on them. The default
  // branch is injected only when it has no enumerated entry at all (a fresh repo, before the
  // first push); an entry that exists but is not live means the default branch was DELETED,
  // and listing it as pickable would repaint the deletion as a fresh repo.
  const branchNames = home.branches
    .filter(isLive)
    .map((b) => b.refName.replace(/^refs\/heads\//, ''))
  if (!findBranch(home.branches, home.defaultBranch) && !branchNames.includes(home.defaultBranch)) {
    branchNames.unshift(home.defaultBranch)
  }
  const tagNames = home.tags.filter(isLive).map((t) => t.refName.replace(/^refs\/tags\//, ''))

  // Filtered (L-13/L-14: a filter box, so 575 tags stay findable) and version-aware sorted
  // (compareTagNames: v23.1.10 above v23.1.8, natural sort for names with no version), with
  // branches ahead of tags and the default branch always first within its group.
  const branches: RefEntry[] = useMemo(
    () =>
      branchNames
        .filter((n) => matchesRefQuery(n, query))
        .sort((a, b) => (a === home.defaultBranch ? -1 : b === home.defaultBranch ? 1 : compareTagNames(a, b)))
        .map((name) => ({ name, isTag: false, href: hrefFor(name, false) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branchNames.join('\0'), query, home.defaultBranch, pathname, addr, path],
  )
  const tags: RefEntry[] = useMemo(
    () =>
      tagNames
        .filter((n) => matchesRefQuery(n, query))
        .sort(compareTagNames)
        .map((name) => ({ name, isTag: true, href: hrefFor(name, true) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tagNames.join('\0'), query, pathname, addr, path],
  )
  const flat = useMemo(() => [...branches, ...tags], [branches, tags])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    // Autofocus the filter box when the popover opens, so typing narrows the list immediately.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  const close = (): void => setOpen(false)
  // A mouse click on the <Link> navigates on its own (only the popover needs closing); Enter on
  // the filter box has no href to follow, so it navigates itself.
  const pick = (entry: RefEntry): void => {
    close()
    router.push(entry.href)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const entry = flat[active]
      if (entry) pick(entry)
    }
  }

  const activeId = flat[active] ? `ref-switcher-option-${flat[active].isTag ? 'tag' : 'branch'}-${flat[active].name}` : undefined

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-anvil-200 bg-white px-2.5 py-1 text-dense coarse:min-h-11 text-anvil-700 transition-colors hover:border-anvil-300 dark:border-anvil-750 dark:bg-anvil-900 dark:text-anvil-200 dark:hover:border-anvil-600"
      >
        <CurrentIcon className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
        <span className="max-w-[180px] truncate font-mono">{current.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={close} />
          <div className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-anvil-200 bg-white shadow-lg dark:border-anvil-750 dark:bg-anvil-900">
            <div className="relative border-b border-anvil-100 p-1.5 dark:border-anvil-850">
              <Search className="pointer-events-none absolute left-4 top-4 h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-controls="ref-switcher-listbox"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Find a branch or tag"
                placeholder="Find a branch or tag…"
                className="w-full rounded-md border border-anvil-200 bg-white py-1 pl-7 pr-2 text-dense font-mono text-anvil-900 outline-none focus:border-forge-500 dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-50"
              />
            </div>
            <div
              id="ref-switcher-listbox"
              role="listbox"
              aria-label="Switch branch or tag"
              className="max-h-72 overflow-y-auto py-1"
            >
              {flat.length === 0 ? (
                <p className="px-3 py-2 text-dense text-anvil-500 dark:text-anvil-400">No branch or tag matches &ldquo;{query}&rdquo;.</p>
              ) : (
                <>
                  {branches.length > 0 ? (
                    <RefGroup label="Branches" entries={branches} offset={0} active={active} current={current} onPick={close} />
                  ) : null}
                  {tags.length > 0 ? (
                    <RefGroup label="Tags" entries={tags} offset={branches.length} active={active} current={current} onPick={close} />
                  ) : null}
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** The deleted-ref empty state: the selected ref's newest update is a delete. */
export function RefDeletedState({
  addr,
  name,
  defaultBranch,
}: {
  addr: RepoAddress
  name: string
  defaultBranch: string
}): JSX.Element {
  // "Back to <default>" would loop when the deleted ref IS the default branch.
  const isDefault = name === defaultBranch
  return (
    <EmptyState
      icon={GitBranch}
      title={isDefault ? 'The default branch was deleted' : 'This ref was deleted'}
      body={`${name} no longer points at a commit — it was deleted, though its push history remains on-chain.`}
      action={
        <Link href={repoHref(isDefault ? '/repo/branches' : '/repo', addr)}>
          <Button variant="primary">{isDefault ? 'View branches' : `Back to ${defaultBranch}`}</Button>
        </Link>
      }
    />
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
      body={`No branch, tag or commit named ${refParam} in this repo.`}
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
  entries,
  offset,
  active,
  current,
  onPick,
}: {
  label: string
  entries: readonly RefEntry[]
  /** This group's index of `entries[0]` within the switcher's flattened, keyboard-navigated list. */
  offset: number
  active: number
  current: SelectedRef
  onPick: () => void
}): JSX.Element {
  const Icon = label === 'Tags' ? Tag : GitBranch
  return (
    <div>
      <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-anvil-500 dark:text-anvil-400">{label}</div>
      {entries.map((entry, i) => {
        const selected = current.isTag === entry.isTag && current.name === entry.name
        const highlighted = offset + i === active
        return (
          <Link
            key={entry.name}
            id={`ref-switcher-option-${entry.isTag ? 'tag' : 'branch'}-${entry.name}`}
            role="option"
            aria-selected={selected}
            href={entry.href}
            onClick={onPick}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-dense',
              highlighted ? 'bg-anvil-50 dark:bg-anvil-850' : 'hover:bg-anvil-50 dark:hover:bg-anvil-850',
              selected ? 'text-anvil-900 dark:text-anvil-50' : 'text-anvil-600 dark:text-anvil-300',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-anvil-500 dark:text-anvil-400" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
            {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-forge-500" aria-hidden /> : null}
          </Link>
        )
      })}
    </div>
  )
}
