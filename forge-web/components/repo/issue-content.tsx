'use client'

/**
 * IssueContent — the issue detail: folded state header, the author's body, the merged
 * comment/event timeline, a comment composer, and close/reopen — each write shown with its
 * pre-sign cost + confirm. Close/reopen is authoritative only if the fold deems the actor
 * authorized (author or MAINTAIN); a non-holder's event lands but stays inert.
 */

import { useState } from 'react'
import { CheckCircle2, CircleDot } from 'lucide-react'
import type { RepoHome, IssueThread } from '@/lib/view'
import { loadIssueThread, timeAgo } from '@/lib/view'
import { closeTarget, createComment, reopenTarget } from '@/lib/repo'
import { previewDocumentCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { Author } from '@/components/author'
import { Timeline } from '@/components/repo/timeline'
import { MarkdownView } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { errorMessage } from '@/lib/utils'

export function IssueContent({
  home,
  number,
}: {
  home: RepoHome
  number: number
}): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.contractId])
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const { data, loading, error, reload } = useAsync<IssueThread | null>(
    () => loadIssueThread(sdk!, home.repo, number),
    [ready, home.repo.contractId, number],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [confirmToggle, setConfirmToggle] = useState(false)

  if (!Number.isFinite(number)) return <EmptyState icon={CircleDot} title="No issue addressed" body="Add &number= to the URL." />
  if (loading) return <LoadingBlock label="Folding issue" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState icon={CircleDot} title={`Issue #${number} not found`} body="No issue with that number in this repo." />

  const { issue, timeline } = data
  const open = issue.state.open

  const postComment = async (): Promise<void> => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    if (!sdk || comment.trim() === '') return
    setPosting(true)
    setCommentError(null)
    try {
      await createComment(sdk, signer, home.repo, { targetId: issue.id, body: comment.trim() })
      setComment('')
      reload()
    } catch (e) {
      setCommentError(errorMessage(e))
    } finally {
      setPosting(false)
    }
  }

  const toggleState = async (): Promise<void> => {
    if (!sdk || !signer) return
    if (open) await closeTarget(sdk, signer, home.repo, issue.id)
    else await reopenTarget(sdk, signer, home.repo, issue.id)
    reload()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl">
          {issue.title || '(untitled)'} <span className="font-mono font-normal text-anvil-400">#{issue.number}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${open ? 'bg-verify' : 'bg-forge-700'}`}>
            {open ? <CircleDot className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            {open ? 'Open' : 'Closed'}
          </span>
          <span className="text-anvil-500 dark:text-anvil-400">
            <Author identityId={issue.author} link={false} /> opened this {timeAgo(issue.createdAt)}
          </span>
          {issue.state.labels.map((l) => (
            <span key={l} className="rounded-full bg-forge-500/10 px-2 py-0.5 text-[11px] text-forge-600 dark:text-forge-400">{l}</span>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
          <Author identityId={issue.author} />
          <span className="text-anvil-400">authored {timeAgo(issue.createdAt)}</span>
        </div>
        <div className="px-4 py-3">
          {issue.body ? <MarkdownView source={issue.body} /> : <p className="italic text-anvil-400">No description.</p>}
        </div>
      </div>

      {/* Timeline */}
      {timeline.length > 0 ? <Timeline items={timeline} /> : null}

      {/* Composer */}
      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a comment (markdown supported)…" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={previewDocumentCreate('comment')} />
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setConfirmToggle(true)} disabled={!signer}>
              {open ? 'Close issue' : 'Reopen issue'}
            </Button>
            <Button variant="primary" onClick={postComment} loading={posting} disabled={comment.trim() === ''}>
              {identity ? 'Comment' : 'Sign in to comment'}
            </Button>
          </div>
        </div>
        {commentError ? (
          <div className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">{commentError}</div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmToggle}
        onClose={() => setConfirmToggle(false)}
        title={open ? `Close issue #${issue.number}` : `Reopen issue #${issue.number}`}
        description="Appends a state event to the append-only log. Authoritative only if you're the author or a maintainer."
        cost={previewDocumentCreate('event')}
        confirmLabel={open ? 'Close issue' : 'Reopen issue'}
        onConfirm={toggleState}
      />
    </div>
  )
}
