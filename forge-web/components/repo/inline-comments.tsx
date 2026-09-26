'use client'

/**
 * Inline review comments on a PR diff (`ux-dx-spec.md` §5.7). Clicking a line number opens a
 * composer under that line; the comment is written with its anchor in the contract fields
 * (`path`, `line`, `side`, `commitOid` = the PR head). Threads on the current head show under
 * their line with their replies (`replyTo`); threads on an older head, or on a line the diff
 * no longer shows, collapse under "n comments on an older version".
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'

import { createComment, type CommentAnchor, type RepoRef } from '@/lib/repo'
import { previewCreate } from '@/lib/sdk'
import { timeAgo, type CommentView } from '@/lib/view'
import { lineKey, placeThreads, type InlineThread } from '@/lib/view/inline-threads'
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
import { Oid } from '@/components/ui/oid'

export function InlineCommentsProvider({
  repo,
  pullId,
  headOid,
  comments,
  onPosted,
  children,
}: {
  repo: RepoRef
  pullId: string
  headOid: string
  comments: readonly CommentView[]
  onPosted: () => void
  children: ReactNode
}): JSX.Element {
  const [shownLines, setShownLines] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [composing, setComposing] = useState<string | null>(null)

  const placed = useMemo(
    () =>
      placeThreads(comments, headOid, (path, side, line) => {
        const keys = shownLines.get(path)
        // Until a file's patch has loaded, a thread on it is not called outdated.
        return keys === undefined || keys.has(lineKey(path, side, line))
      }),
    [comments, headOid, shownLines],
  )

  const report = useCallback((path: string, keys: ReadonlySet<string>) => {
    setShownLines((prev) => {
      const old = prev.get(path)
      if (old !== undefined && old.size === keys.size && [...keys].every((k) => old.has(k))) return prev
      return new Map(prev).set(path, keys)
    })
  }, [])

  const value = useMemo<InlineComments>(
    () => ({
      start: (path, side, line) => setComposing(lineKey(path, side, line)),
      report,
      render: (path, side, line) => {
        const key = lineKey(path, side, line)
        const threads = placed.current.get(key) ?? []
        const open = composing === key
        if (threads.length === 0 && !open) return null
        return (
          <div key={key} className="space-y-2" data-testid="inline-thread">
            {threads.map((t) => (
              <Thread key={t.root.id} thread={t} repo={repo} pullId={pullId} onPosted={onPosted} />
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
    [placed, composing, repo, pullId, headOid, onPosted, report],
  )

  return (
    <InlineCommentsContext.Provider value={value}>
      {placed.outdatedCount > 0 ? (
        <details className="mb-3 rounded-lg border border-anvil-200 dark:border-anvil-800" data-testid="outdated-comments">
          <summary className="cursor-pointer px-3 py-2 text-dense text-anvil-700 dark:text-anvil-300">
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5 text-anvil-400" aria-hidden />
            {placed.outdatedCount} comment{placed.outdatedCount === 1 ? '' : 's'} on an older version
          </summary>
          <div className="space-y-2 border-t border-anvil-200 px-3 py-2 dark:border-anvil-800">
            {placed.outdated.map((t) => (
              <div key={t.root.id}>
                <p className="mb-1 font-mono text-[12px] text-anvil-600 dark:text-anvil-400">
                  {t.root.anchor.path}:{t.root.anchor.line} ({t.root.anchor.side === 1 ? 'new' : 'old'})
                  {t.root.anchor.commitOid ? (
                    <>
                      {' '}
                      on <Oid value={t.root.anchor.commitOid} chars={7} copyable={false} />
                    </>
                  ) : null}
                </p>
                <Thread thread={t} repo={repo} pullId={pullId} onPosted={onPosted} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {children}
    </InlineCommentsContext.Provider>
  )
}

function Thread({ thread, repo, pullId, onPosted }: { thread: InlineThread; repo: RepoRef; pullId: string; onPosted: () => void }): JSX.Element {
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
  anchor?: CommentAnchor
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
  const cost = previewCreate('comment', {
    body: body.trim(),
    ...(anchor ? { path: anchor.path } : {}),
  })
  const submit = async (): Promise<void> => {
    if (posting || body.trim() === '' || !guard.check(cost.credits) || !sdk || !signer) return
    setPosting(true)
    setError(null)
    try {
      await createComment(sdk, signer, repo, {
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
        <p role="alert" className="text-dense text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
