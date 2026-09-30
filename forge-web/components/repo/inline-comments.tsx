'use client'

/**
 * Inline review comments on a PR diff (`ux-dx-spec.md` §5.7, review-parity R1–R4, R7, R15).
 *
 * - Clicking a line number opens a composer under it; shift-clicking another line of the same
 *   file and side makes it a range (`startLine..line`, the range tinted). The composer offers
 *   GitHub's two buttons: "Add single comment" (posts now) and "Start a review" / "Add review
 *   comment" (goes into the pending review, kept in this browser until it is submitted).
 * - Threads on the current head show under their last line with their replies; a resolved thread
 *   collapses to "resolved · Show". Members and the PR author resolve and unresolve (a
 *   `threadResolve` / `threadUnresolve` event naming the root).
 * - Authors edit and delete their own comments ("edited" marker).
 * - Pending comments of the viewer's review render in place, tagged "Pending".
 * - File-level threads are listed as "File comments"; threads on an older head, or on a line the
 *   diff no longer shows, collapse under "n comments on an older version".
 */

import { Byline } from '@/components/repo/byline'
import { useMirrorTrust } from '@/hooks/use-mirror-trust'
import { trustedOrigin } from '@/lib/repo/provenance'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, FileDiff, MessageSquare, Pencil, Trash2 } from 'lucide-react'

import { commentFirsts, postComment, type AnchorInput, type PostContext, type RepoRef } from '@/lib/repo'
import type { DraftComment } from '@/lib/repo'
import { plural, type CommentView } from '@/lib/view'
import { anchorLabel, extendSelection, lineKey, placeThreads, rangeKeys, type InlineThread, type LineSelection } from '@/lib/view/inline-threads'
import { insertSuggestion, type SuggestionAnchor } from '@/lib/view/suggest-block'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useIntent } from '@/hooks/use-intent'
import { useFirstWrite } from '@/hooks/use-first-write'
import { InlineCommentsContext, type InlineComments } from '@/components/repo/diff-view'
import { MarkdownView } from '@/components/markdown-view'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { MarkdownEditor } from '@/components/repo/issue-bits'
import { BranchRunSlot, CommitIdentityPrompt } from '@/components/repo/branch-commit-panel'
import { CostPreview } from '@/components/ui/cost-preview'
import { BodyCounter, PrivateComposeNote, SealedLimit, composeCost, composeTooLong } from '@/components/repo/private-compose'
import { EditedMarker } from '@/components/repo/issue-bits'
import { Oid } from '@/components/ui/oid'

/** What the page lets the threads do: resolve, edit and delete (it confirms and signs). */
export interface ThreadActions {
  /** The viewer may resolve and unresolve threads (a member or the PR author). */
  readonly canResolve: boolean
  readonly resolved: ReadonlySet<string>
  readonly onResolve: (rootId: string, resolve: boolean) => void
  /** The viewer's identity: their own comments get Edit and Delete. */
  readonly viewer: string | null
  readonly onEdit: (comment: CommentView, body: string) => void
  readonly onDelete: (comment: CommentView) => void
}

/**
 * Suggestions on the diff (review-parity R5, §4.5): which comments' suggestions this viewer can
 * apply, the batch they collected, and what was already applied (by commit trailers).
 */
export interface SuggestionActions {
  /** The viewer can move the PR branch (a writer of the source repo); else why not. */
  readonly canApply: boolean
  readonly why: string | null
  /** The browser commit's name and email are not set yet (asked for beside Apply). */
  readonly needsIdentity: boolean
  /** Apply can run now: the identity is set, the head is read, no other commit is running. */
  readonly ready: boolean
  /** The file lines a suggestion on `a` would replace (the head's text), or null when unknown. */
  readonly original: (a: SuggestionAnchor) => readonly string[] | null
  /** Read `path`'s head text (a composer on it: "Insert a suggestion", Preview). */
  readonly want: (path: string) => void
  /** Why the comment's suggestion cannot be applied on the head, or null when it can. */
  readonly unapplicable: (c: CommentView) => string | null
  /** Comment id → the commit that applied it. */
  readonly applied: ReadonlyMap<string, string>
  readonly batch: ReadonlySet<string>
  readonly onToggleBatch: (c: CommentView) => void
  readonly onApply: (c: CommentView) => void
}

/** The viewer's pending review, as the diff needs it. */
export interface PendingReview {
  /** The pending comments anchored to the current head: shown on their lines. */
  readonly comments: readonly DraftComment[]
  /** Pending comments anchored to another head: their line numbers name other lines now. */
  readonly elsewhere: readonly DraftComment[]
  /** Every pending comment. */
  readonly count: number
  /** Frozen: a submit began (only retry or discard). */
  readonly frozen: boolean
  readonly onAdd: (anchor: AnchorInput, body: string) => void
  readonly onEdit: (localId: string, body: string) => void
  readonly onRemove: (localId: string) => void
}

/** Whether the viewer is a member and the PR locked: a member's comment on a locked PR proves membership (RC1). */
const PostContextOf = createContext<PostContext | undefined>(undefined)

export function InlineCommentsProvider({
  repo,
  post,
  pullId,
  headOid,
  comments,
  changedPaths,
  onPosted,
  writeBlock = null,
  actions,
  pending,
  suggestions,
  onLinesKnown,
  children,
}: {
  repo: RepoRef
  /** The viewer's membership and the PR's lock, for the comments posted here. */
  post?: PostContext
  /** Why this browser cannot write here (a private repo it cannot write to), or null. */
  writeBlock?: string | null
  pullId: string
  headOid: string
  comments: readonly CommentView[]
  /** The paths the comparison changed: a thread on any other path is outdated. */
  changedPaths: ReadonlySet<string>
  /** A comment landed (its id): the page re-reads until it shows. */
  onPosted: (id?: string) => void
  actions?: ThreadActions
  /** The viewer's pending review; absent: no "Start a review". */
  pending?: PendingReview
  /** Apply and batch suggestions; absent: suggestions render as diffs only. */
  suggestions?: SuggestionActions
  /** Told which lines each loaded file's patch shows (`lineKey`s): re-anchoring a pending review uses it. */
  onLinesKnown?: (lines: ReadonlyMap<string, ReadonlySet<string>>) => void
  children: ReactNode
}): JSX.Element {
  // The page passes a fresh set each render: keep one per distinct list of paths.
  const pathsKey = [...changedPaths].sort().join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paths = useMemo(() => changedPaths, [pathsKey])
  const [shownLines, setShownLines] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [selection, setSelection] = useState<LineSelection | null>(null)

  // A path whose lines have ever been reported: its patch loaded, so a line missing from it
  // is really gone (outdated). An unreported path (collapsed, a placeholder, not paged in yet)
  // proves nothing either way.
  const [loadedPaths, setLoadedPaths] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())

  const placed = useMemo(
    () =>
      placeThreads(
        comments,
        headOid,
        (path, side, line) => {
          if (!paths.has(path)) return false
          const keys = loadedPaths.get(path)
          return keys === undefined || keys.has(lineKey(path, side, line))
        },
        (path) => paths.has(path),
      ),
    [comments, headOid, paths, loadedPaths],
  )
  const ranges = useMemo(() => rangeKeys(placed.current), [placed])
  useEffect(() => {
    onLinesKnown?.(loadedPaths)
  }, [onLinesKnown, loadedPaths])
  // Pending comments by the key of their last line.
  const pendingAt = useMemo(() => {
    const m = new Map<string, DraftComment[]>()
    for (const c of pending?.comments ?? []) {
      const a = c.anchor
      if (a.line === undefined || a.side === undefined) continue
      const key = lineKey(a.path, a.side, a.line)
      m.set(key, [...(m.get(key) ?? []), c])
    }
    return m
  }, [pending?.comments])
  // Current threads whose line is not on screen right now: listed above the diff, never lost.
  const unshown = [...placed.current.entries()]
    .filter(([key]) => {
      const path = key.slice(key.indexOf(':', key.indexOf(':') + 1) + 1)
      return !(shownLines.get(path)?.has(key) ?? false)
    })
    .flatMap(([, threads]) => threads)

  const report = useCallback((path: string, keys: ReadonlySet<string> | null) => {
    const same = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean => a !== undefined && a.size === b.size && [...b].every((k) => a.has(k))
    setShownLines((prev) => {
      if (keys === null) {
        if (!prev.has(path)) return prev
        const next = new Map(prev)
        next.delete(path)
        return next
      }
      return same(prev.get(path), keys) ? prev : new Map(prev).set(path, keys)
    })
    if (keys !== null && keys.size > 0) {
      setLoadedPaths((prev) => {
        const merged = new Set([...(prev.get(path) ?? []), ...keys])
        return same(prev.get(path), merged) ? prev : new Map(prev).set(path, merged)
      })
    }
  }, [])

  const threadProps = { repo, pullId, onPosted, writeBlock, ...(actions ? { actions } : {}), ...(suggestions ? { suggestions } : {}) }
  const value = useMemo<InlineComments>(
    () => ({
      canComment: writeBlock === null,
      start: (path, side, line, extend = false) => {
        if (writeBlock === null) setSelection((prev) => extendSelection(prev, path, side, line, extend))
      },
      mark: (path, side, line) => {
        if (selection !== null && selection.path === path && selection.side === side && line >= selection.startLine && line <= selection.line) return 'selected'
        return ranges.has(lineKey(path, side, line)) ? 'range' : null
      },
      report,
      render: (path, side, line) => {
        const key = lineKey(path, side, line)
        const threads = placed.current.get(key) ?? []
        const drafts = pendingAt.get(key) ?? []
        const open = selection !== null && lineKey(selection.path, selection.side, selection.line) === key
        if (threads.length === 0 && drafts.length === 0 && !open) return null
        const range = selection !== null && selection.startLine !== selection.line ? `lines ${selection.startLine}–${selection.line}` : `line ${line}`
        return (
          <div key={key} className="space-y-2" data-testid="inline-thread">
            {threads.map((t) => (
              <Thread key={t.root.id} thread={t} {...threadProps} />
            ))}
            {drafts.map((d) => (
              <PendingComment key={d.localId} draft={d} pending={pending} suggestions={suggestions} />
            ))}
            {open && selection !== null ? (
              <Composer
                repo={repo}
                pullId={pullId}
                anchor={{ path, line: selection.line, ...(selection.startLine !== selection.line ? { startLine: selection.startLine } : {}), side, commitOid: headOid }}
                label={`Your comment on ${path} ${range} (${side === 1 ? 'new' : 'old'})`}
                pending={pending}
                suggestions={suggestions}
                onDone={(id) => {
                  setSelection(null)
                  onPosted(id)
                }}
                onCancel={() => setSelection(null)}
              />
            ) : null}
          </div>
        )
      },
    }),
    // threadProps is rebuilt from the listed values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placed, selection, ranges, pendingAt, pending, repo, pullId, headOid, onPosted, report, writeBlock, actions, suggestions],
  )

  return (
    <PostContextOf.Provider value={post}>
    <InlineCommentsContext.Provider value={value}>
      {placed.fileLevel.length > 0 ? (
        <details open className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="file-comments">
          <summary className="flex cursor-pointer items-center px-3 py-2 text-dense text-anvil-700 coarse:min-h-11 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            File comments ({placed.fileLevel.length})
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {placed.fileLevel.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} {...threadProps} />
            ))}
          </div>
        </details>
      ) : null}
      {unshown.length > 0 ? (
        <details className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="unshown-comments">
          <summary className="flex cursor-pointer items-center px-3 py-2 text-dense text-anvil-700 coarse:min-h-11 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {plural(unshown.length, 'comment thread')} on lines not shown below
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {unshown.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} {...threadProps} />
            ))}
          </div>
        </details>
      ) : null}
      {pending !== undefined && pending.elsewhere.length > 0 ? (
        <details open className="mb-3 rounded-lg border border-caution/40 dark:border-caution/40" data-testid="pending-elsewhere">
          <summary className="flex cursor-pointer items-center px-3 py-2 text-dense text-anvil-700 coarse:min-h-11 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {plural(pending.elsewhere.length, 'pending comment')} on an older version
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {pending.elsewhere.map((d) => (
              <div key={d.localId}>
                <p className="mb-1 font-mono text-[12px] text-anvil-600 dark:text-anvil-400">
                  {anchorLabel({ path: d.anchor.path, line: d.anchor.line ?? null, startLine: d.anchor.startLine ?? null, side: d.anchor.side ?? null, commitOid: d.anchor.commitOid ?? '' })}
                  {d.anchor.commitOid ? (
                    <>
                      {' '}
                      on <Oid value={d.anchor.commitOid} chars={7} copyable={false} />
                    </>
                  ) : null}
                </p>
                <PendingComment draft={d} pending={pending} suggestions={suggestions} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {placed.outdatedCount > 0 ? (
        <details className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="outdated-comments">
          <summary className="flex cursor-pointer items-center px-3 py-2 text-dense text-anvil-700 coarse:min-h-11 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {plural(placed.outdatedCount, 'comment')} on an older version
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {placed.outdated.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} {...threadProps} />
            ))}
          </div>
        </details>
      ) : null}
      {children}
    </InlineCommentsContext.Provider>
    </PostContextOf.Provider>
  )
}

interface ThreadProps {
  repo: RepoRef
  pullId: string
  onPosted: (id?: string) => void
  writeBlock: string | null
  actions?: ThreadActions
  suggestions?: SuggestionActions
}

/** A thread shown away from its line, headed by where it points. */
function AnchoredThread({ thread, ...rest }: ThreadProps & { thread: InlineThread }): JSX.Element {
  const a = thread.root.anchor
  return (
    <div>
      <p className="mb-1 font-mono text-[12px] text-anvil-600 dark:text-anvil-400">
        {anchorLabel(a)}
        {a.commitOid ? (
          <>
            {' '}
            on <Oid value={a.commitOid} chars={7} copyable={false} />
          </>
        ) : null}
      </p>
      <Thread thread={thread} {...rest} />
    </div>
  )
}

function Thread({ thread, repo, pullId, onPosted, writeBlock, actions, suggestions }: ThreadProps & { thread: InlineThread }): JSX.Element {
  const [replying, setReplying] = useState(false)
  const resolved = actions?.resolved.has(thread.root.id) ?? false
  const [expanded, setExpanded] = useState(false)
  if (resolved && !expanded) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-anvil-200 bg-white px-3 py-1.5 text-[12px] text-anvil-600 dark:border-anvil-750 dark:bg-anvil-950 dark:text-anvil-400" data-testid="thread-collapsed" data-root={thread.root.id}>
        <CheckCircle2 className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
        <span>Resolved conversation ({plural(1 + thread.replies.length, 'comment')})</span>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
          Show
        </Button>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-950" data-testid="thread" data-root={thread.root.id} data-resolved={resolved ? 'true' : 'false'}>
      {[thread.root, ...thread.replies].map((c) => (
        <CommentBlock key={c.id} repo={repo} comment={c} actions={actions} writeBlock={writeBlock} {...(suggestions ? { suggestions } : {})} />
      ))}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        {replying ? (
          <div className="w-full">
            <Composer
              repo={repo}
              pullId={pullId}
              replyTo={thread.root.id}
              label="Reply"
              onDone={(id) => {
                setReplying(false)
                onPosted(id)
              }}
              onCancel={() => setReplying(false)}
            />
          </div>
        ) : writeBlock !== null ? (
          <PrivateComposeNote reason={writeBlock} />
        ) : thread.root.replyTo !== null ? (
          // The thread's root comment was deleted: a reply must name a live root (RC1 R-14).
          <span className="text-[12px] text-anvil-500 dark:text-anvil-400">The first comment of this thread was deleted; replies are closed.</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
        {actions?.canResolve && !replying ? (
          <Button size="sm" variant="outline" onClick={() => actions.onResolve(thread.root.id, !resolved)} title="≈ 0.0005 DASH (one event)">
            {resolved ? 'Unresolve conversation' : 'Resolve conversation'}
          </Button>
        ) : null}
        {resolved ? (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
            Hide
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** One comment of a thread, with its author's Edit and Delete. */
function CommentBlock({
  repo,
  comment: c,
  actions,
  writeBlock,
  suggestions,
}: {
  repo: RepoRef
  comment: CommentView
  actions?: ThreadActions
  writeBlock: string | null
  suggestions?: SuggestionActions
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  // An imported line comment from a trusted mirror shows its original author and date (FG-6).
  const origin = trustedOrigin(c.origin, c.author, useMirrorTrust(repo))
  const own = actions !== undefined && actions.viewer !== null && actions.viewer === c.author && writeBlock === null
  return (
    <div className="border-b border-anvil-100 px-3 py-2 last:border-b-0 dark:border-anvil-850" data-testid="thread-comment" data-id={c.id}>
      <div className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
        <Byline author={c.author} createdAt={c.createdAt} origin={origin} link={false} />
        <EditedMarker createdAt={c.createdAt} updatedAt={c.updatedAt} />
        {own && editing === null ? (
          <span className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setEditing(c.body)} className="inline-flex items-center gap-1 hover:text-forge-700 dark:hover:text-forge-400" aria-label="Edit comment">
              <Pencil className="h-3 w-3" aria-hidden /> Edit
            </button>
            <button type="button" onClick={() => actions.onDelete(c)} className="inline-flex items-center gap-1 hover:text-danger-700 dark:hover:text-danger-400" aria-label="Delete comment">
              <Trash2 className="h-3 w-3" aria-hidden /> Delete
            </button>
          </span>
        ) : null}
      </div>
      {editing !== null && actions ? (
        <div className="mt-1 space-y-2">
          <Textarea aria-label="Edit comment" value={editing} onChange={(e) => setEditing(e.target.value)} className="min-h-[72px]" autoFocus />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={editing.trim() === '' || editing === c.body}
              onClick={() => {
                actions.onEdit(c, editing)
                setEditing(null)
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1">
          <SuggestedBody comment={c} suggestions={suggestions} />
        </div>
      )}
    </div>
  )
}

/** A comment body: its ```suggestion blocks as diffs, with Apply / Add to batch / "Applied in". */
function SuggestedBody({ comment: c, suggestions }: { comment: CommentView; suggestions?: SuggestionActions | undefined }): JSX.Element {
  const has = c.body.includes('```suggestion') || c.body.includes('~~~suggestion')
  const original = has && suggestions && c.anchor !== null ? suggestions.original(c.anchor) : null
  const ctx = useMemo(() => (has ? { original } : null), [has, original])
  if (!has || !suggestions) return <MarkdownView source={c.body} suggestion={ctx} />
  const applied = suggestions.applied.get(c.id)
  const refused = suggestions.unapplicable(c)
  const inBatch = suggestions.batch.has(c.id)
  return (
    <>
      <MarkdownView source={c.body} suggestion={ctx} />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]" data-testid="suggestion-actions" data-comment={c.id}>
        {applied ? (
          <span className="inline-flex items-center gap-1 text-verify-700 dark:text-verify-400" data-testid="suggestion-applied">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Applied in <Oid value={applied} chars={7} copyable={false} />
          </span>
        ) : refused !== null ? (
          <span className="text-anvil-500 dark:text-anvil-400">{refused}</span>
        ) : suggestions.canApply ? (
          <>
            <Button size="sm" variant="primary" onClick={() => suggestions.onApply(c)} disabled={!suggestions.ready}>
              Apply suggestion
            </Button>
            <Button size="sm" variant="outline" aria-pressed={inBatch} onClick={() => suggestions.onToggleBatch(c)}>
              {inBatch ? 'Remove from batch' : 'Add to batch'}
            </Button>
            {suggestions.needsIdentity ? <CommitIdentityPrompt what="apply suggestions" /> : null}
          </>
        ) : (
          <span className="text-anvil-500 dark:text-anvil-400" title={suggestions.why ?? undefined}>
            {suggestions.why}
          </span>
        )}
        <BranchRunSlot at={`comment:${c.id}`} />
      </div>
    </>
  )
}

/** A comment of the viewer's pending review, shown in place (a suggestion as the diff it will be). */
function PendingComment({ draft, pending, suggestions }: { draft: DraftComment; pending: PendingReview | undefined; suggestions?: SuggestionActions | undefined }): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const has = draft.body.includes('```suggestion') || draft.body.includes('~~~suggestion')
  const original = has && suggestions ? suggestions.original(draft.anchor) : null
  const ctx = useMemo(() => (has ? { original } : null), [has, original])
  return (
    <div className="rounded-md border border-dashed border-caution/60 bg-caution/5 px-3 py-2" data-testid="pending-comment" data-local={draft.localId}>
      <div className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
        <span className="rounded-full bg-caution/20 px-2 py-0.5 text-[11px] font-medium text-caution-800 dark:text-caution-300">Pending</span>
        {draft.anchor.startLine !== undefined ? <span className="font-mono">lines {draft.anchor.startLine}–{draft.anchor.line}</span> : null}
        {pending && !pending.frozen && editing === null ? (
          <span className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setEditing(draft.body)} className="inline-flex items-center gap-1 hover:text-forge-700 dark:hover:text-forge-400" aria-label="Edit pending comment">
              <Pencil className="h-3 w-3" aria-hidden /> Edit
            </button>
            <button type="button" onClick={() => pending.onRemove(draft.localId)} className="inline-flex items-center gap-1 hover:text-danger-700 dark:hover:text-danger-400" aria-label="Delete pending comment">
              <Trash2 className="h-3 w-3" aria-hidden /> Delete
            </button>
          </span>
        ) : null}
      </div>
      {editing !== null && pending ? (
        <div className="mt-1 space-y-2">
          <Textarea aria-label="Edit pending comment" value={editing} onChange={(e) => setEditing(e.target.value)} className="min-h-[72px]" autoFocus />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={editing.trim() === ''}
              onClick={() => {
                pending.onEdit(draft.localId, editing)
                setEditing(null)
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1">
          <MarkdownView source={draft.body} suggestion={ctx} />
        </div>
      )}
    </div>
  )
}

function Composer({
  repo,
  pullId,
  anchor,
  replyTo,
  label,
  pending,
  suggestions,
  onDone,
  onCancel,
}: {
  repo: RepoRef
  pullId: string
  anchor?: AnchorInput
  replyTo?: string
  label: string
  /** The pending review (a line comment only): offers "Start a review" / "Add review comment". */
  pending?: PendingReview | undefined
  /** A line comment on the new side: "Insert a suggestion" and a Preview showing it as a diff. */
  suggestions?: SuggestionActions | undefined
  onDone: (id?: string) => void
  onCancel: () => void
}): JSX.Element {
  const { sdk, ready } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const draft = useIntent()
  const post = useContext(PostContextOf)
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which subtrees this comment would create, read once the viewer starts typing, so the price
  // shown before "Add comment" is as tight as the conversation composer's (L-38, D-011). A reply
  // may be its root's first, which opens the `reply` subtree no surcharge measures: keep the
  // thread surcharge in for it, so the preview stays an upper bound.
  const read = useFirstWrite(
    () => commentFirsts(sdk!, repo, pullId, identity!),
    [pullId, identity ?? ''],
    body !== '' && ready && sdk !== null && identity !== null,
  )
  const first = replyTo ? { ...read, target: true } : read
  const cost = composeCost(
    repo,
    'comment',
    {
      body: body.trim(),
      ...(anchor ? { path: anchor.path } : {}),
    },
    first,
  )
  const tooLong = composeTooLong(repo, 'comment', { body: body.trim(), ...(anchor ? { path: anchor.path } : {}) })
  const submit = async (): Promise<void> => {
    if (posting || body.trim() === '' || tooLong || !guard.check(cost, 'collab') || !sdk || !signer) return
    setPosting(true)
    setError(null)
    try {
      const r = await postComment(sdk, signer, repo, {
        targetId: pullId,
        body: body.trim(),
        ...(anchor ? { anchor } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(post ? { post } : {}),
        intent: draft.intent,
      })
      draft.renew()
      setBody('')
      onDone(r.documentId)
    } catch (e) {
      setError(guard.failed(e))
    } finally {
      setPosting(false)
    }
  }
  // GitHub's "Insert a suggestion" (review-parity R5): on the new side only, pre-filled with the
  // lines the comment is on (the head's text; the button waits for it).
  const id = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const suggestAt = anchor !== undefined && anchor.side === 1 && suggestions !== undefined ? anchor : null
  const want = suggestions?.want
  const path = suggestAt?.path ?? null
  useEffect(() => {
    if (path !== null) want?.(path)
  }, [path, want])
  const lines = suggestAt !== null ? suggestions?.original(suggestAt) ?? null : null
  // The preview's context, stable while the lines are (the preview re-renders only then).
  const suggesting = suggestAt !== null
  const linesKey = lines === null ? null : lines.join('\n')
  const preview = useMemo(() => (suggesting ? { original: linesKey === null ? null : linesKey.split('\n') } : null), [suggesting, linesKey])
  const insert = (): void => {
    if (lines === null) return
    const el = field.current
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? body.length
    const out = insertSuggestion(body, start, end, lines)
    setBody(out.body)
    requestAnimationFrame(() => {
      const t = field.current
      if (t === null) return
      t.focus()
      t.setSelectionRange(out.caret, out.caret)
    })
  }
  const reviewing = pending !== undefined && anchor !== undefined && !pending.frozen
  const addToReview = (): void => {
    if (!reviewing || body.trim() === '' || anchor === undefined) return
    pending.onAdd(anchor, body)
    setBody('')
    onDone()
  }
  return (
    <div className="space-y-2 font-sans">
      <MarkdownEditor
        id={`${id}-body`}
        label={label}
        value={body}
        onChange={setBody}
        placeholder="Leave a comment"
        autoFocus
        textareaRef={field}
        suggestion={preview}
        hint={null}
        tools={
          suggestAt !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={insert}
              disabled={lines === null}
              title={lines === null ? 'Reading the lines…' : 'The selected lines, to edit into the change you suggest'}
            >
              <FileDiff className="h-3.5 w-3.5" aria-hidden /> Insert a suggestion
            </Button>
          ) : null
        }
      />
      <SealedLimit repo={repo} kind="comment" text={body.trim() + (anchor?.path ?? '')} />
      <BodyCounter repo={repo} text={body.trim()} field="comment" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CostPreview cost={cost} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={posting}>
            Cancel
          </Button>
          <Button size="sm" variant={reviewing ? 'outline' : 'primary'} onClick={submit} loading={posting} disabled={body.trim() === '' || tooLong || guard.disabledReason !== null}>
            {replyTo ? 'Reply' : reviewing ? 'Add single comment' : 'Add comment'}
          </Button>
          {reviewing ? (
            <Button size="sm" variant="primary" onClick={addToReview} disabled={body.trim() === '' || tooLong || posting}>
              {pending.count === 0 ? 'Start a review' : 'Add review comment'}
            </Button>
          ) : null}
        </div>
      </div>
      {reviewing ? <p className="text-[11px] text-anvil-500 dark:text-anvil-400">A review comment is saved in this browser only (not on your account), unpublished and free, until you submit the review.</p> : null}
      {error ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
