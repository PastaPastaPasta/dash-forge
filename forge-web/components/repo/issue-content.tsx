'use client'

/**
 * IssueContent — the issue detail: folded state header, the author's body, the merged
 * comment/event timeline, a comment composer, close/reopen and labels — each write shown with
 * its pre-sign cost + confirm.
 *
 * Who may do what (`forge-v2.md` §3): the author closes and reopens their own issue with an
 * `authorEvent`; maintainers and writers close, reopen and label with an `event`. Consensus
 * refuses anyone else on forge-v2, so the controls are offered only to them. On v1 the author's
 * or a WRITE/MAINTAIN holder's plain `event` is what the fold honours.
 */

import { useState } from 'react'
import { CheckCircle2, CircleDot, Tag, X } from 'lucide-react'
import type { RepoHome, IssueThread } from '@/lib/view'
import { aclName, loadIssueThread, timeAgo } from '@/lib/view'
import { addEvent, createComment, readViewerPermissions, repoContractIds, repoKey, setTargetState } from '@/lib/repo'
import type { Holdings } from '@/lib/rules'
import { previewDocumentCreate, type CostPreview as Cost } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Timeline } from '@/components/repo/timeline'
import { MarkdownView } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { errorMessage } from '@/lib/utils'

type Pending =
  | { kind: 'state' }
  | { kind: 'label'; label: string; remove: boolean }
  | null

export function IssueContent({ home, number }: { home: RepoHome; number: number }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()

  const { data, loading, error, reload } = useAsync<IssueThread | null>(
    () => loadIssueThread(sdk!, home.repo, number),
    [ready, repoKey(home.repo), number],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  // v1: WRITE/MAINTAIN token holdings; forge-v2: a current maintainer/writer document.
  const holdings = useAsync<Holdings | null>(
    () => readViewerPermissions(sdk!, home.repo, identity!, network),
    [ready, repoKey(home.repo), identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null },
  )

  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [newLabel, setNewLabel] = useState('')

  if (!Number.isFinite(number)) return <EmptyState icon={CircleDot} title="No issue addressed" body="Add &number= to the URL." />
  if (loading) return <LoadingBlock label="Folding issue" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState icon={CircleDot} title={`Issue #${number} not found`} body="No issue with that number in this repo." />

  const { issue, timeline } = data
  const open = issue.state.open
  const isMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const isAuthor = identity !== null && identity === issue.author
  const canToggle = identity !== null && (isAuthor || isMember)
  const toggleHint =
    !canToggle && identity !== null && holdings.settled && holdings.data === null
      ? `Couldn't read this repo's ${aclName(home.repo.kind)}, so close/reopen permission is unknown.`
      : null
  const target = { id: issue.id, number: issue.number }
  const commentCost = previewDocumentCreate('comment', { body: comment.trim() })
  // A member's close is an `event`; the author who is not a member uses `authorEvent`.
  const stateCost = previewDocumentCreate(isMember ? 'event' : 'authorEvent')

  const postComment = async (): Promise<void> => {
    if (comment.trim() === '' || !guard.check(commentCost.credits)) return
    if (!sdk || !signer) return
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

  const runPending = async (): Promise<void> => {
    if (!sdk || !signer || pending === null) return
    if (pending.kind === 'state') {
      await setTargetState(sdk, signer, home.repo, {
        target,
        kind: open ? 'close' : 'reopen',
        author: issue.author,
        isMember,
      })
    } else {
      await addEvent(sdk, signer, home.repo, {
        target,
        kind: pending.remove ? 'labelRemove' : 'labelAdd',
        value: pending.label,
      })
      setNewLabel('')
    }
    reload()
  }

  const pendingCost: Cost =
    pending?.kind === 'label' ? previewDocumentCreate('event', { value: pending.label }) : stateCost

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl">
          {issue.title || '(untitled)'} <span className="font-mono font-normal text-anvil-400">#{issue.number}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-dense">
          <span
            data-testid="issue-state"
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium text-white ${open ? 'bg-verify-700' : 'bg-forge-700'}`}
          >
            {open ? <CircleDot className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            {open ? 'Open' : 'Closed'}
          </span>
          <span className="text-anvil-500 dark:text-anvil-400">
            <Author identityId={issue.author} link={false} /> opened this {timeAgo(issue.createdAt)}
          </span>
          {issue.state.labels.map((l) => (
            <span key={l} className="inline-flex items-center gap-1 rounded-full bg-forge-500/10 px-2 py-0.5 text-[11px] text-forge-600 dark:text-forge-400">
              {l}
              {isMember ? (
                <button
                  type="button"
                  aria-label={`Remove label ${l}`}
                  onClick={() => setPending({ kind: 'label', label: l, remove: true })}
                  className="hover:text-danger"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              ) : null}
            </span>
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

      {/* Labels (members) */}
      {isMember ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-anvil-200 p-3 dark:border-anvil-800">
          <Tag className="mb-2 h-4 w-4 text-anvil-400" aria-hidden />
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="label-name" className="sr-only">Label</label>
            <Input id="label-name" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Add a label (e.g. bug)" maxLength={120} />
          </div>
          <Button
            variant="outline"
            disabled={newLabel.trim() === '' || guard.disabledReason !== null}
            onClick={() => setPending({ kind: 'label', label: newLabel.trim(), remove: false })}
          >
            Add label
          </Button>
        </div>
      ) : null}

      {/* Composer */}
      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="mb-2 text-dense font-medium">Add a comment</h3>
        <label htmlFor="comment-body" className="sr-only">Comment</label>
        <Textarea id="comment-body" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a comment (markdown supported)…" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={commentCost} />
          <div className="flex items-center gap-2">
            {canToggle ? (
              <Button
                variant="outline"
                onClick={() => setPending({ kind: 'state' })}
                disabled={!signer || guard.disabledReason !== null}
                title={guard.disabledReason ?? undefined}
              >
                {open ? 'Close issue' : 'Reopen issue'}
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={postComment}
              loading={posting}
              disabled={comment.trim() === '' || guard.disabledReason !== null}
              title={guard.disabledReason ?? undefined}
            >
              {identity ? 'Comment' : 'Sign in to comment'}
            </Button>
          </div>
        </div>
        {toggleHint !== null ? <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">{toggleHint}</p> : null}
        {commentError ? (
          <div role="alert" className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">{commentError}</div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending?.kind === 'label'
            ? `${pending.remove ? 'Remove' : 'Add'} label "${pending.label}"`
            : open
              ? `Close issue #${issue.number}`
              : `Reopen issue #${issue.number}`
        }
        description={
          pending?.kind === 'label'
            ? 'Appends a label event. Only maintainers and writers can label.'
            : isMember
              ? 'Appends a state event, as a maintainer or writer of this repo.'
              : 'Appends an author event: you opened this issue, so you can close and reopen it.'
        }
        cost={pendingCost}
        confirmLabel={pending?.kind === 'label' ? 'Sign & label' : open ? 'Close issue' : 'Reopen issue'}
        onConfirm={runPending}
      />
    </div>
  )
}
