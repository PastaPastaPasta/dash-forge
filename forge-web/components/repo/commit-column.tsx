'use client'

/**
 * The file list's last-commit column and the ref bar's commit count, over the push-time history
 * index when the repository published one (`docs/design/history-index.md`), else a history walk
 * in the browser.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  columnHistory,
  countCommits,
  LAST_COMMIT_WALK,
  walkCommitColumn,
  type ColumnHistory,
  type CommitCount,
  type LastCommit,
  type LastCommitColumn,
  type WalkOptions,
} from '@/lib/view/commit-log'
import { historyOf } from '@/lib/view/history-source'
import type { ObjectReader } from '@/lib/view/tree-nav'
import { formatDate, plural, timeAgo } from '@/lib/view/format'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

/** Where the history index's numbers come from, for the tooltips (they are the pusher's claim). */
export const HISTORY_INDEX_NOTE = "from the history index the repository's pusher published"

const WALKING: LastCommitColumn = { found: new Map(), done: false, failed: false }

/** The history index of the context `reader` belongs to, as the column and the count read it. */
export function useColumnHistory(reader: ObjectReader): ColumnHistory | null {
  return useMemo(() => {
    const source = historyOf(reader)
    return source === null ? null : columnHistory(source)
  }, [reader])
}

/**
 * The commit column of the listing of `dirPath` at `tipOid`, looked up again for a new tip or
 * listing. `names` null: the listing is not read yet (nothing starts).
 */
export function useLastCommits(
  reader: ObjectReader,
  tipOid: string,
  dirPath: string,
  names: readonly string[] | null,
  walker?: WalkOptions['walker'],
): LastCommitColumn {
  const history = useColumnHistory(reader)
  const [state, setState] = useState<LastCommitColumn & { readonly key: string }>({ key: '', ...WALKING })
  const key = names === null ? '' : `${tipOid}\0${dirPath}\0${names.join('\0')}`
  useEffect(() => {
    if (names === null) return
    const stop = new AbortController()
    void walkCommitColumn(reader, tipOid, names, (column) => setState({ key, ...column }), {
      ...(walker !== undefined ? { walker } : {}),
      signal: stop.signal,
      dirPath,
      history,
    })
    return () => stop.abort()
    // `key` covers `tipOid`, `dirPath` and `names`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, walker, history, key])
  return state.key === key ? state : WALKING
}

/** The ref bar's count: exact from the history index, else walked (at most `cap`). */
export function countWithHistory(
  reader: ObjectReader,
  tipOid: string,
  cap: number,
  opts: WalkOptions,
): Promise<CommitCount> {
  const source = historyOf(reader)
  const counts =
    source === null
      ? null
      : { covers: (tip: string) => source.byTip.has(tip), count: async (tip: string) => (await source.load(tip)).commitCount }
  return countCommits(reader, tipOid, cap, { ...opts, counts })
}

/** `12,345 commits`, `100+ commits`, or `Commits` while unknown. */
export function commitCountLabel(c: CommitCount | null | undefined): string {
  if (c === null || c === undefined) return 'Commits'
  return plural(c.capped ? `${c.count.toLocaleString('en-US')}+` : c.count, 'commit')
}

/** The count link's tooltip: where the number comes from. */
export function commitCountTitle(c: CommitCount | null | undefined): string | undefined {
  if (c === null || c === undefined) return undefined
  if (c.fromIndex === true) {
    return c.capped
      ? `At least ${c.count.toLocaleString('en-US')} commits: the count ${HISTORY_INDEX_NOTE}, plus the commits since`
      : `Every commit reachable from this tip, ${HISTORY_INDEX_NOTE}`
  }
  return c.capped ? `At least ${c.count} commits on the first-parent history; no history index covers this tip` : undefined
}

/** What a cell with no commit says, and its tooltip. */
function missingLabel(column: LastCommitColumn): [text: string, title: string] {
  if (!column.done) return ['…', 'Finding the last commit that changed this']
  if (column.failed) return ['not loaded', 'The commit history could not be read']
  if (column.olderThan !== undefined && column.olderThan > 0) {
    const date = formatDate(column.olderThan)
    return [
      `not changed since ${date}`,
      `No commit since ${date} changed this; ${column.more ? 'search older history to find the one that did' : 'older history is not searched'}`,
    ]
  }
  return ['—', 'No commit found for this entry']
}

/** One row's commit cell: the commit's subject (linked) and age, or why there is none. */
export function CommitCell({
  commit,
  column,
  addr,
}: {
  commit: LastCommit | undefined
  column: LastCommitColumn
  addr: RepoAddress
}): JSX.Element {
  if (commit === undefined) {
    const [text, title] = missingLabel(column)
    return (
      <span className="truncate text-anvil-500 dark:text-anvil-400" title={title} data-testid="commit-cell-pending">
        {text}
      </span>
    )
  }
  return (
    <>
      <Link
        href={repoHref('/repo/commit', addr, { oid: commit.oid })}
        className="min-w-0 flex-1 truncate text-anvil-600 hover:text-forge-800 coarse:-my-3 coarse:py-3 dark:text-anvil-300 dark:hover:text-forge-400"
        title={column.source === 'index' ? `${commit.subject} (${HISTORY_INDEX_NOTE})` : commit.subject}
        data-testid="commit-cell"
      >
        {commit.subject || '(no message)'}
      </Link>
      <span className="shrink-0 tabular-nums text-anvil-500 dark:text-anvil-400" title={formatDate(commit.when)}>
        {timeAgo(commit.when)}
      </span>
    </>
  )
}

/**
 * Under the list, when the walk stopped with entries still open: continue it
 * {@link LAST_COMMIT_WALK} commits further back.
 */
export function SearchOlderHistory({ column }: { column: LastCommitColumn }): JSX.Element | null {
  const [searching, setSearching] = useState(false)
  useEffect(() => setSearching(false), [column.more])
  if (!column.done || column.more === undefined) return null
  const more = column.more
  return (
    <div className="flex justify-end">
      <button
        type="button"
        className="rounded-md px-2 py-1 text-dense text-forge-700 hover:bg-anvil-100 disabled:opacity-60 coarse:min-h-11 dark:text-forge-400 dark:hover:bg-anvil-800"
        disabled={searching}
        onClick={() => {
          setSearching(true)
          more()
        }}
        data-testid="search-older-history"
      >
        {searching ? 'Searching older history…' : `Search older history (${LAST_COMMIT_WALK} more commits)`}
      </button>
    </div>
  )
}
