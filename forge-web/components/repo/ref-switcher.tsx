'use client'

/**
 * RefSwitcher — the branch/tag dropdown on browse views (home, tree, blob, commits). Switching
 * navigates the current route with a `?ref=` param (dropped for the default branch, keeping
 * canonical URLs clean) and preserves the `path` param so a switch stays on the same file/dir.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Check, ChevronDown, GitBranch, Search, Tag } from 'lucide-react'
import type { RepoHome, SelectedRef } from '@/lib/view'
import { findBranch, isLive, matchesRefQuery, refParamFor, splitRefPath } from '@/lib/view'
import { compareRefNames, compareTagNames } from '@/lib/repo'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadingBlock } from '@/components/ui/states'
import { SEALED_PARAMS } from '@/lib/view/private-nav'
import { cn } from '@/lib/utils'

/** One entry of the switcher's open list, flattened across both groups for keyboard navigation. */
interface RefEntry {
  readonly name: string
  readonly isTag: boolean
  /** Position in the flattened (branches-then-tags) list; ties an option's id to `active`. */
  readonly index: number
}

export function RefSwitcher({
  home,
  addr,
  current,
  path,
  keep,
}: {
  home: RepoHome
  addr: RepoAddress
  current: SelectedRef
  /** The `path` param to preserve across a switch (tree/blob views). */
  path?: string
  /** Other params to preserve across a switch (code search's `query`). */
  keep?: Readonly<Record<string, string>>
}): JSX.Element {
  const pathname = usePathname()
  const router = useRouter()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const listboxId = `${uid}-listbox`
  const branchHeadingId = `${uid}-branches-heading`
  const tagHeadingId = `${uid}-tags-heading`
  const optionId = (index: number): string => `${uid}-option-${index}`

  const hrefFor = (shortName: string, isTag: boolean): string => {
    const ref = refParamFor(shortName, isTag, home.defaultBranch)
    return repoHref(pathname, addr, {
      ...keep,
      ...(path ? { path } : {}),
      ...(ref ? { ref } : {}),
    })
  }

  const CurrentIcon = current.isTag ? Tag : GitBranch

  // Deleted (unborn) refs are not offered — there is nothing to browse on them. The default
  // branch is injected only when it has no enumerated entry at all (a fresh repo, before the
  // first push); an entry that exists but is not live means the default branch was DELETED,
  // and listing it as pickable would repaint the deletion as a fresh repo.
  // Sorted once per ref set, not per keystroke (L-13/L-14: 575 tags): branches in plain
  // name/natural order (branch names are rarely version-like), tags version-aware
  // (compareTagNames: v23.1.10 above v23.1.8), with the default branch always first among the
  // branches.
  const { branchNames, tagNames } = useMemo(() => {
    const branchNames = home.branches.filter(isLive).map((b) => b.refName.replace(/^refs\/heads\//, ''))
    if (!findBranch(home.branches, home.defaultBranch) && !branchNames.includes(home.defaultBranch)) {
      branchNames.push(home.defaultBranch)
    }
    branchNames.sort((a, b) => {
      if (a === home.defaultBranch) return -1
      if (b === home.defaultBranch) return 1
      return compareRefNames(a, b)
    })
    const tagNames = home.tags.filter(isLive).map((t) => t.refName.replace(/^refs\/tags\//, '')).sort(compareTagNames)
    return { branchNames, tagNames }
  }, [home.branches, home.tags, home.defaultBranch])

  // Branches ahead of tags; the filter box narrows both, filtering keeps the sorted order above.
  // Each surviving entry keeps a global index into the flattened list, shared by keyboard
  // navigation (`active`), option ids, and aria-activedescendant.
  const branches: RefEntry[] = useMemo(
    () => branchNames.filter((n) => matchesRefQuery(n, query)).map((name, i) => ({ name, isTag: false, index: i })),
    [branchNames, query],
  )
  const tags: RefEntry[] = useMemo(() => {
    const offset = branches.length
    return tagNames.filter((n) => matchesRefQuery(n, query)).map((name, i) => ({ name, isTag: true, index: offset + i }))
  }, [tagNames, query, branches.length])
  const flat = useMemo(() => [...branches, ...tags], [branches, tags])
  const activeId = flat.length > 0 ? optionId(active) : undefined

  const toggle = (): void => {
    if (!open) {
      setQuery('')
      setActive(0)
    }
    setOpen(!open)
  }
  const close = (): void => setOpen(false)

  // Scroll the keyboard-highlighted row into view as it moves past the popover's visible edge.
  // Inlines the id (rather than calling optionId, which is recreated every render) so the
  // exhaustive-deps list is accurate with no eslint-disable needed.
  useEffect(() => {
    if (!open) return
    document.getElementById(`${uid}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, uid])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        close()
        triggerRef.current?.focus()
        break
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length))
        break
      case 'Enter': {
        // Ignore an Enter that's confirming an IME composition (e.g. picking a candidate while
        // typing Japanese/Chinese/Korean), not choosing a ref. A mouse click on the <Link>
        // navigates on its own (only the popover needs closing); Enter here has no href to
        // follow, so it navigates itself. Safari can report isComposing === false on the very
        // Enter that confirms a candidate, still tagging it with the legacy keyCode 229 — check
        // both.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        e.preventDefault()
        const entry = flat[active]
        if (entry) {
          close()
          router.push(hrefFor(entry.name, entry.isTag))
        }
        break
      }
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Switch branches or tags, currently ${current.name}`}
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
              {/* Focused on open, so typing narrows the list immediately. */}
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Find a branch or tag"
                placeholder="Find a branch or tag…"
                className="w-full rounded-md border border-anvil-200 bg-white py-1 pl-7 pr-2 text-dense font-mono text-anvil-900 outline-none focus:border-forge-500 dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-50"
              />
            </div>
            {/* A listbox's only valid children are options and labelled groups of options — the
                empty-search message lives outside it, not as a stray child. */}
            <div id={listboxId} role="listbox" aria-label="Switch branch or tag" className="max-h-72 overflow-y-auto py-1">
              {branches.length > 0 ? (
                <RefGroup
                  headingId={branchHeadingId}
                  label="Branches"
                  entries={branches}
                  active={active}
                  current={current}
                  optionId={optionId}
                  hrefFor={hrefFor}
                  onPick={close}
                  onHover={setActive}
                />
              ) : null}
              {tags.length > 0 ? (
                <RefGroup
                  headingId={tagHeadingId}
                  label="Tags"
                  entries={tags}
                  active={active}
                  current={current}
                  optionId={optionId}
                  hrefFor={hrefFor}
                  onPick={close}
                  onHover={setActive}
                />
              ) : null}
            </div>
            {flat.length === 0 ? (
              <p className="px-3 py-2 text-dense text-anvil-500 dark:text-anvil-400">No branch or tag matches &ldquo;{query}&rdquo;.</p>
            ) : null}
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
      body={`${name} no longer points at a commit — it was deleted, though its push history remains on Platform.`}
      action={
        <Link href={repoHref(isDefault ? '/repo/branches' : '/repo', addr)}>
          <Button variant="primary">{isDefault ? 'View branches' : `Back to ${defaultBranch}`}</Button>
        </Link>
      }
    />
  )
}

/**
 * A GitHub-style URL whose branch has a `/` in it (QW2-024), split where the repo's refs say
 * ({@link splitRefPath}): the same page again with the ref and path corrected, keeping the rest of
 * the query and the `#L` anchor. Replaces the history entry, so Back skips the wrong address.
 */
export function RefPathRedirect({ addr, split }: { addr: RepoAddress; split: { readonly ref: string; readonly path: string } }): JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  useEffect(() => {
    const extra: Record<string, string> = {}
    // The other params as they are (a sealed one is a token already, never sealed twice).
    params.forEach((v, k) => {
      if (!['owner', 'name', 'repo'].includes(k) && !SEALED_PARAMS.has(k)) extra[k] = v
    })
    extra['ref'] = split.ref
    if (split.path !== '') extra['path'] = split.path
    router.replace(`${repoHref(pathname, addr, extra)}${window.location.hash}`)
  }, [router, pathname, params, addr, split.ref, split.path])
  return <LoadingBlock label={`Opening ${split.ref}`} />
}

/**
 * What a browse view shows instead of its content when `?ref=` names no branch or tag: the same
 * page with a slashed branch split out of the path ({@link RefPathRedirect}, QW2-024), else "Ref
 * not found" unless the ref is a commit id. Null when the ref is fine.
 */
export function unknownRefState(home: RepoHome, addr: RepoAddress, selected: SelectedRef, refParam: string, path: string): JSX.Element | null {
  if (selected.ref) return null
  const split = splitRefPath(home.branches, home.tags, refParam, path)
  if (split !== null) return <RefPathRedirect addr={addr} split={split} />
  if (refParam && !selected.pinned) return <RefNotFoundState addr={addr} refParam={refParam} defaultBranch={home.defaultBranch} />
  return null
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
  headingId,
  label,
  entries,
  active,
  current,
  optionId,
  hrefFor,
  onPick,
  onHover,
}: {
  headingId: string
  label: string
  entries: readonly RefEntry[]
  /** The global index (see {@link RefEntry.index}) of the keyboard-highlighted option. */
  active: number
  current: SelectedRef
  optionId: (index: number) => string
  hrefFor: (shortName: string, isTag: boolean) => string
  onPick: () => void
  onHover: (index: number) => void
}): JSX.Element {
  return (
    <div role="group" aria-labelledby={headingId}>
      <div
        id={headingId}
        role="presentation"
        className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-anvil-500 dark:text-anvil-400"
      >
        {label}
      </div>
      {entries.map((entry) => {
        // The current ref (checkmark + aria-current) and the keyboard-highlighted row
        // (aria-selected, the row combobox users are about to Enter on) are different things —
        // opening the switcher on v1.2.0 highlights the top of the list, not v1.2.0 itself.
        const selected = current.isTag === entry.isTag && current.name === entry.name
        const highlighted = entry.index === active
        const Icon = entry.isTag ? Tag : GitBranch
        return (
          <Link
            key={entry.name}
            id={optionId(entry.index)}
            role="option"
            tabIndex={-1}
            aria-selected={highlighted}
            aria-current={selected ? 'true' : undefined}
            href={hrefFor(entry.name, entry.isTag)}
            onClick={onPick}
            onMouseEnter={() => onHover(entry.index)}
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
