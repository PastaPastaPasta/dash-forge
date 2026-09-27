'use client'

/**
 * Inline review comments on a PR diff (`ux-dx-spec.md` §5.7). Clicking a line number opens a
 * composer under that line; the comment is written with its anchor in the contract fields
 * (`path`, `line`, `side`, `commitOid` = the PR head; read back by `anchorOf`). Threads on the
 * current head show under their line with their replies (`replyTo`); file-level threads are
 * listed as "File comments"; threads on an older head, or on a line the diff no longer shows,
 * collapse under "n comments on an older version".
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'

import { postComment, type AnchorInput, type RepoRef } from '@/lib/repo'
import { timeAgo, type CommentView } from '@/lib/view'
import { anchorLabel, lineKey, placeThreads, type InlineThread } from '@/lib/view/inline-threads'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { useIntent } from '@/hooks/use-intent'
import { InlineCommentsContext, type InlineComments } from '@/components/repo/diff-view'
import { Author } from '@/components/author'
import { MarkdownView } from '@/components/markdown-view'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { PrivateComposeNote, SealedLimit, composeCost } from '@/components/repo/private-compose'
import { Oid } from '@/components/ui/oid'

export function InlineCommentsProvider({
  repo,
  pullId,
  headOid,
  comments,
  changedPaths,
  onPosted,
  writeBlock = null,
  children,
}: {
  repo: RepoRef
  /** Why this browser cannot write here (a private repo it cannot write to), or null. */
  writeBlock?: string | null
  pullId: string
  headOid: string
  comments: readonly CommentView[]
  /** The paths the comparison changed: a thread on any other path is outdated. */
  changedPaths: ReadonlySet<string>
  onPosted: () => void
  children: ReactNode
}): JSX.Element {
  const [shownLines, setShownLines] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [composing, setComposing] = useState<string | null>(null)

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
          if (!changedPaths.has(path)) return false
          const keys = loadedPaths.get(path)
          return keys === undefined || keys.has(lineKey(path, side, line))
        },
        (path) => changedPaths.has(path),
      ),
    [comments, headOid, changedPaths, loadedPaths],
  )
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

  const value = useMemo<InlineComments>(
    () => ({
      start: (path, side, line) => {
        if (writeBlock === null) setComposing(lineKey(path, side, line))
      },
      report,
      render: (path, side, line) => {
        const key = lineKey(path, side, line)
        const threads = placed.current.get(key) ?? []
        const open = composing === key
        if (threads.length === 0 && !open) return null
        return (
          <div key={key} className="space-y-2" data-testid="inline-thread">
            {threads.map((t) => (
              <Thread key={t.root.id} thread={t} repo={repo} pullId={pullId} onPosted={onPosted} writeBlock={writeBlock} />
            ))}
            {open ? (
              <Composer
                repo={repo}
                pullId={pullId}
                anchor={{ path, line, side, commitOid: headOid }}
                label={`Your comment on ${path} line ${line} (${side === 1 ? 'new' : 'old'})`}
                onDone={() => {
                  setComposing(null)
                  onPosted()
                }}
                onCancel={() => setComposing(null)}
              />
            ) : null}
          </div>
        )
      },
    }),
    [placed, composing, repo, pullId, headOid, onPosted, report, writeBlock],
  )

  return (
    <InlineCommentsContext.Provider value={value}>
      {placed.fileLevel.length > 0 ? (
        <details open className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="file-comments">
          <summary className="cursor-pointer px-3 py-2 text-dense text-anvil-700 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            File comments ({placed.fileLevel.length})
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {placed.fileLevel.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} repo={repo} pullId={pullId} onPosted={onPosted} writeBlock={writeBlock} />
            ))}
          </div>
        </details>
      ) : null}
      {unshown.length > 0 ? (
        <details className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="unshown-comments">
          <summary className="cursor-pointer px-3 py-2 text-dense text-anvil-700 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {unshown.length} comment thread{unshown.length === 1 ? '' : 's'} on lines not shown below
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {unshown.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} repo={repo} pullId={pullId} onPosted={onPosted} writeBlock={writeBlock} />
            ))}
          </div>
        </details>
      ) : null}
      {placed.outdatedCount > 0 ? (
        <details className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="outdated-comments">
          <summary className="cursor-pointer px-3 py-2 text-dense text-anvil-700 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
            {placed.outdatedCount} comment{placed.outdatedCount === 1 ? '' : 's'} on an older version
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {placed.outdated.map((t) => (
              <AnchoredThread key={t.root.id} thread={t} repo={repo} pullId={pullId} onPosted={onPosted} writeBlock={writeBlock} />
            ))}
          </div>
        </details>
      ) : null}
      {children}
    </InlineCommentsContext.Provider>
  )
}

/** A thread shown away from its line, headed by where it points. */
function AnchoredThread({
  thread,
  repo,
  pullId,
  onPosted,
  writeBlock,
}: {
  thread: InlineThread
  repo: RepoRef
  pullId: string
  onPosted: () => void
  writeBlock: string | null
}): JSX.Element {
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
      <Thread thread={thread} repo={repo} pullId={pullId} onPosted={onPosted} writeBlock={writeBlock} />
    </div>
  )
}

function Thread({
  thread,
  repo,
  pullId,
  onPosted,
  writeBlock,
}: {
  thread: InlineThread
  repo: RepoRef
  pullId: string
  onPosted: () => void
  writeBlock: string | null
}): JSX.Element {
  const [replying, setReplying] = useState(false)
  return (
    <div className="rounded-md border border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-950">
      {[thread.root, ...thread.replies].map((c) => (
        <div key={c.id} className="border-b border-anvil-100 px-3 py-2 last:border-b-0 dark:border-anvil-850">
          <div className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400">
            <Author identityId={c.author} link={false} />
            <span>{timeAgo(c.createdAt)}</span>
          </div>
          <div className="mt-1">
            <MarkdownView source={c.body} />
          </div>
        </div>
      ))}
      <div className="px-3 py-1.5">
        {replying ? (
          <Composer
            repo={repo}
            pullId={pullId}
            replyTo={thread.root.id}
            label="Reply"
            onDone={() => {
              setReplying(false)
              onPosted()
            }}
            onCancel={() => setReplying(false)}
          />
        ) : writeBlock !== null ? (
          <PrivateComposeNote reason={writeBlock} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
      </div>
    </div>
  )
}

function Composer({
  repo,
  pullId,
  anchor,
  replyTo,
  label,
  onDone,
  onCancel,
}: {
  repo: RepoRef
  pullId: string
  anchor?: AnchorInput
  replyTo?: string
  label: string
  onDone: () => void
  onCancel: () => void
}): JSX.Element {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const draft = useIntent()
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cost = composeCost(repo, 'comment', {
    body: body.trim(),
    ...(anchor ? { path: anchor.path } : {}),
  })
  const submit = async (): Promise<void> => {
    if (posting || body.trim() === '' || !guard.check(cost.credits) || !sdk || !signer) return
    setPosting(true)
    setError(null)
    try {
      await postComment(sdk, signer, repo, {
        targetId: pullId,
        body: body.trim(),
        ...(anchor ? { anchor } : {}),
        ...(replyTo ? { replyTo } : {}),
        intent: draft.intent,
      })
      draft.renew()
      setBody('')
      onDone()
    } catch (e) {
      setError(writeErrorMessage(e).message)
    } finally {
      setPosting(false)
    }
  }
  return (
    <div className="space-y-2 font-sans">
      <Textarea aria-label={label} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a comment" className="min-h-[72px]" autoFocus />
      <SealedLimit repo={repo} kind="comment" text={body.trim() + (anchor?.path ?? '')} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CostPreview cost={cost} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={posting}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={posting} disabled={body.trim() === '' || guard.disabledReason !== null}>
            {replyTo ? 'Reply' : 'Add comment'}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-dense text-danger-700 dark:text-danger-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
