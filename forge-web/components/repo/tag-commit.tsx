'use client'

/**
 * The commit a tag names, for the tags list (L-02). A lightweight tag's tip is its commit; an
 * annotated tag's tip is a tag object, peeled here to the commit it names: one object read per
 * tag, only once its row scrolls into view, through one read-ahead walker per list (tag objects
 * sit together in a pack, so a screenful costs a block or two), and cached for the session. Until
 * the answer lands the chip shows a placeholder rather than the tag object's id; its link is the
 * tip either way (the commit page peels a tag too). The list reads only the published browse
 * index: it never starts the in-browser clone, and where no index will be ready it shows the tips
 * as they are.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { formatDate, shortOid, timeAgo } from '@/lib/view'
import { historyWalker } from '@/lib/view/commit-log'
import { peelCached, peekDeclared, tipDateCached } from '@/lib/view/tip'
import type { ObjectReader } from '@/lib/view/tree-nav'
import { useBrowse } from '@/hooks/use-browse'
import { useTrustView } from '@/hooks/use-trust-view'
import type { RepoRef } from '@/lib/repo'
import { Oid } from '@/components/ui/oid'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

/**
 * The reader a list peels its tags through: `reader` once the repo's published index is ready,
 * `settled` once it is known none will be (no index, no packs, or it failed), so a chip stops
 * waiting. A null `repo` (a page with nothing to peel) reads nothing.
 */
export interface TagPeeler {
  readonly reader: ObjectReader | null
  readonly settled: boolean
}

export function useTagPeeler(repo: RepoRef | null): TagPeeler {
  const browse = useBrowse(repo)
  const view = useTrustView()
  const state = browse.data
  const shared = state?.kind === 'ready' ? state.context.reader : null
  // One read-ahead walker for the list, reading for this page's view (the Verification card).
  const walker = useMemo(() => (shared === null ? null : historyWalker(shared.forView(view))), [shared, view])
  useEffect(() => () => walker?.flush?.(), [walker])
  const settled = walker === null && (browse.error !== null || (state !== null && state.kind !== 'ready'))
  return { reader: walker, settled }
}

/** Whether `el` has been in (or near) the viewport; stays true once it has. */
export function useSeen(el: RefObject<Element>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const node = el.current
    if (seen || node === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    }, { rootMargin: '200px' })
    io.observe(node)
    return () => io.disconnect()
  }, [el, seen])
  return seen
}

/** A tag tip's commit chip, linking to the commit page. Key it by `tip`: it keeps its answer. */
export function TagCommit({ peeler, tip, addr }: { peeler: TagPeeler; tip: string; addr: RepoAddress }): JSX.Element {
  const ref = useRef<HTMLAnchorElement>(null)
  const seen = useSeen(ref)
  const [commit, setCommit] = useState<string | null>(() => {
    const known = peekDeclared(tip)
    return known?.type === 'commit' ? known.oid : null
  })
  const { reader } = peeler
  useEffect(() => {
    if (!seen || reader === null || commit !== null) return
    let live = true
    peelCached(reader, tip, { verify: false }).then(
      (p) => live && setCommit(p.type === 'commit' ? p.oid : tip),
      // Unreadable: show the tip itself; its commit page says what it is.
      () => live && setCommit(tip),
    )
    return () => {
      live = false
    }
  }, [seen, reader, tip, commit])
  // No index will be ready to peel through: the tip as it is.
  const shown = commit ?? (peeler.settled ? tip : null)
  return (
    <Link
      ref={ref}
      href={repoHref('/repo/commit', addr, { oid: shown ?? tip })}
      className="hit-area inline-flex min-w-[7ch] justify-end hover:text-forge-800 dark:hover:text-forge-400"
      data-testid="tag-commit"
      aria-label={shown === null ? 'Commit' : `Commit ${shortOid(shown)}`}
    >
      {shown === null ? <span className="font-mono text-dense text-anvil-500 dark:text-anvil-400">…</span> : <Oid value={shown} copyable={false} />}
    </Link>
  )
}

/**
 * A branches or tags row's date (QW2-023): "updated <age>" of its tip commit, or its tag's date,
 * as GitHub's lists show them, read once the row scrolls into view. Until then, and where no index
 * will be ready or the tip cannot be read, the time the ref last moved here (`pushedAt`, its newest
 * update document: a mirror's sync time), labelled "pushed", never as the commit's date.
 */
export function RefDate({ peeler, tip, pushedAt }: { peeler: TagPeeler; tip: string; pushedAt: number }): JSX.Element | null {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useSeen(ref)
  // undefined: not read yet; null: could not be read (or no date).
  const [date, setDate] = useState<number | null | undefined>(undefined)
  const { reader } = peeler
  useEffect(() => {
    if (!seen || reader === null || date !== undefined) return
    let live = true
    tipDateCached(reader, tip).then(
      (ms) => live && setDate(ms > 0 ? ms : null),
      () => live && setDate(null),
    )
    return () => {
      live = false
    }
  }, [seen, reader, tip, date])
  const cls = 'hidden shrink-0 whitespace-nowrap text-[12px] text-anvil-500 dark:text-anvil-400 sm:inline'
  if (typeof date === 'number') {
    return (
      <span ref={ref} className={cls} data-testid="ref-updated" data-source="commit" title={new Date(date).toLocaleString()}>
        updated {date < Date.now() - 365 * 86_400_000 ? `on ${formatDate(date)}` : timeAgo(date)}
      </span>
    )
  }
  const fallback = date === null || peeler.settled
  return (
    <span ref={ref} className={cls} data-testid="ref-updated" data-source={fallback ? 'push' : 'pending'} title={pushedAt > 0 ? new Date(pushedAt).toLocaleString() : undefined}>
      {fallback && pushedAt > 0 ? `pushed ${timeAgo(pushedAt)}` : '\u00a0'}
    </span>
  )
}
