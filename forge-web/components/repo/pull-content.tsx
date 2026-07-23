'use client'

/**
 * PullContent — PR detail: folded state, base/head, the author's body, the review timeline, a
 * comment composer, and merge / close / reopen. Merge appends a `merge` event with the head oid;
 * the fold makes it authoritative only for a MAINTAIN holder once the base ref reaches that oid.
 * The head-tree diff vs base is shown when both are browsable (best-effort).
 */

import { useState } from 'react'
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import type { RepoHome, PullThread } from '@/lib/view'
import { loadPullThread, timeAgo } from '@/lib/view'
import { addEvent, closeTarget, createComment, reopenTarget } from '@/lib/repo'
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
import { Oid } from '@/components/ui/oid'
import { Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import type { RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'

type Pending = 'merge' | 'close' | 'reopen' | null

export function PullContent({ home, number }: { home: RepoHome; addr: RepoAddress; number: number }): JSX.Element {
  const { sdk, ready } = useSdk([home.repo.contractId])
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const { data, loading, error, reload } = useAsync<PullThread | null>(
    () => loadPullThread(sdk!, home.repo, number),
    [ready, home.repo.contractId, number],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  if (!Number.isFinite(number)) return <EmptyState icon={GitPullRequest} title="No PR addressed" body="Add &number= to the URL." />
  if (loading) return <LoadingBlock label="Folding PR" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState icon={GitPullRequest} title={`PR #${number} not found`} body="No patch with that number in this repo." />

  const { pull, timeline } = data
  const merged = pull.state.merged
  const open = pull.state.open

  const status = merged
    ? { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, bg: 'bg-dash' }
    : !open
      ? { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, bg: 'bg-danger' }
      : { label: pull.state.draft ? 'Draft' : 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, bg: pull.state.draft ? 'bg-anvil-500' : 'bg-verify' }

  const postComment = async (): Promise<void> => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    if (!sdk || comment.trim() === '') return
    setPosting(true)
    setCommentError(null)
    try {
      await createComment(sdk, signer, home.repo, { targetId: pull.id, body: comment.trim() })
      setComment('')
      reload()
    } catch (e) {
      setCommentError(errorMessage(e))
    } finally {
      setPosting(false)
    }
  }

  const runPending = async (): Promise<void> => {
    if (!sdk || !signer) return
    if (pending === 'merge') await addEvent(sdk, signer, home.repo, { targetId: pull.id, kind: 'merge', oidHex: pull.headOid })
    else if (pending === 'close') await closeTarget(sdk, signer, home.repo, pull.id)
    else if (pending === 'reopen') await reopenTarget(sdk, signer, home.repo, pull.id)
    reload()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl">
          {pull.title || '(untitled)'} <span className="font-mono font-normal text-anvil-400">#{pull.number}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${status.bg}`}>
            {status.icon}
            {status.label}
          </span>
          <span className="text-anvil-500 dark:text-anvil-400">
            <Author identityId={pull.author} link={false} /> wants to merge into <span className="font-mono">{pull.baseRefName || '?'}</span> · {timeAgo(pull.createdAt)}
          </span>
          {pull.headOid ? <span className="flex items-center gap-1 text-anvil-400">head <Oid value={pull.headOid} chars={9} /></span> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex items-center gap-2 border-b border-anvil-200 bg-anvil-50 px-4 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
          <Author identityId={pull.author} />
          <span className="text-anvil-400">proposed {timeAgo(pull.createdAt)}</span>
        </div>
        <div className="px-4 py-3">
          {pull.body ? <MarkdownView source={pull.body} /> : <p className="italic text-anvil-400">No description.</p>}
        </div>
      </div>

      {timeline.length > 0 ? <Timeline items={timeline} /> : null}

      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="mb-2 text-dense font-medium">Review</h3>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a review comment…" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={previewDocumentCreate('comment')} />
          <div className="flex items-center gap-2">
            {open && !merged ? (
              <>
                <Button variant="outline" onClick={() => setPending('close')} disabled={!signer}>Close</Button>
                <Button variant="primary" onClick={() => setPending('merge')} disabled={!signer}>
                  <GitMerge className="h-3.5 w-3.5" aria-hidden /> Merge
                </Button>
              </>
            ) : !open && !merged ? (
              <Button variant="outline" onClick={() => setPending('reopen')} disabled={!signer}>Reopen</Button>
            ) : null}
            <Button variant="primary" onClick={postComment} loading={posting} disabled={comment.trim() === ''}>
              {identity ? 'Comment' : 'Sign in'}
            </Button>
          </div>
        </div>
        {commentError ? (
          <div className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">{commentError}</div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending === 'merge' ? `Merge PR #${pull.number}` : pending === 'close' ? `Close PR #${pull.number}` : `Reopen PR #${pull.number}`}
        description={
          pending === 'merge'
            ? 'Appends a merge event with the head oid. Authoritative once you hold MAINTAIN and the base ref reaches this commit (fast-forward / clean merge pushed via the helper).'
            : 'Appends a state event to the append-only log.'
        }
        cost={previewDocumentCreate('event')}
        confirmLabel={pending === 'merge' ? 'Sign & merge' : pending === 'close' ? 'Close PR' : 'Reopen PR'}
        onConfirm={runPending}
      />
    </div>
  )
}
