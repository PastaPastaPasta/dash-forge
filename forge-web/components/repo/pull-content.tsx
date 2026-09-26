'use client'

/**
 * PullContent — PR detail: folded state, base/head, where the PR's objects live, the author's
 * body, the files changed (see {@link PullDiff}), the timeline (comments, state events and
 * review verdicts), a comment composer, and mark-as-merged / close / reopen.
 *
 * **It cannot merge code**, stated here because the name suggests otherwise. "Mark as merged"
 * appends a `merge` event carrying the PR head oid. The fold accepts that event only from a
 * WRITE or MAINTAIN holder, and only once the head has been a tip of the base ref — which a
 * push must do. So the control is shown only to WRITE/MAINTAIN holders ({@link pullActions})
 * and says whether the head is already on the base branch. For a base branch that has moved
 * on, the merge commit is not the head oid at all; that merge is recorded with the CLI
 * (`dg pr merge --merge-oid`).
 */

import { useState } from 'react'
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import type { RepoHome, PullThread } from '@/lib/view'
import { loadPullThread, pullActions, timeAgo } from '@/lib/view'
import { addEvent, createComment, createReview, readViewerPermissions, repoContractIds, repoKey, setTargetState, type VerdictInput } from '@/lib/repo'
import type { Holdings } from '@/lib/rules'
import { previewCreate } from '@/lib/sdk'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useIntent } from '@/hooks/use-intent'
import { writeErrorMessage } from '@/lib/view/write-errors'
import { useAuth } from '@/contexts/auth-context'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Author } from '@/components/author'
import { Timeline } from '@/components/repo/timeline'
import { PullDiff } from '@/components/repo/pull-diff'
import { MarkdownView } from '@/components/markdown-view'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Oid } from '@/components/ui/oid'
import { Textarea } from '@/components/ui/input'
import { CostPreview } from '@/components/ui/cost-preview'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { Approvals } from '@/components/repo/approvals'
import type { RepoAddress } from '@/hooks/use-query-param'

type Pending = 'merge' | 'close' | 'reopen' | { review: VerdictInput } | null

const VERDICT_TEXT: Readonly<Record<VerdictInput, string>> = {
  approve: 'Approve',
  requestChanges: 'Request changes',
  comment: 'Comment only',
}

export function PullContent({ home, addr, number }: { home: RepoHome; addr: RepoAddress; number: number }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home.repo))
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()

  const { data, loading, error, reload } = useAsync<PullThread | null>(
    () => loadPullThread(sdk!, home.repo, number),
    [ready, repoKey(home.repo), number],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  // What the PR controls are gated on: v1, the viewer's current WRITE/MAINTAIN holdings (the
  // token-history cache the fold reads, so usually free); forge-v2, a current maintainer or
  // writer document (the membership cache approvals read).
  const holdings = useAsync<Holdings | null>(
    () => readViewerPermissions(sdk!, home.repo, identity!, network),
    [ready, repoKey(home.repo), identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null },
  )

  const [comment, setComment] = useState('')
  const draft = useIntent()
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  if (!Number.isFinite(number)) return <EmptyState icon={GitPullRequest} title="No PR addressed" body="Add &number= to the URL." />
  if (loading && !data) return <LoadingBlock label="Folding PR" />
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState icon={GitPullRequest} title={`PR #${number} not found`} body="No patch with that number in this repo." />

  const { pull, timeline } = data
  const merged = pull.state.merged
  const open = pull.state.open
  const actions = pullActions({
    pull,
    viewer: identity,
    // Signed in but not yet read: withhold the controls without a "can't" message.
    holdings: identity !== null && !holdings.settled ? 'loading' : holdings.data,
    model: home.repo.kind,
  })
  const base = pull.baseRefName || 'the base branch'

  const status = merged
    ? { label: 'Merged', icon: <GitMerge className="h-4 w-4" aria-hidden />, bg: 'bg-dash-700' }
    : !open
      ? { label: 'Closed', icon: <GitPullRequestClosed className="h-4 w-4" aria-hidden />, bg: 'bg-danger' }
      : { label: pull.state.draft ? 'Draft' : 'Open', icon: <GitPullRequest className="h-4 w-4" aria-hidden />, bg: pull.state.draft ? 'bg-anvil-500' : 'bg-verify-700' }

  const commentCost = previewCreate('comment', { body: comment.trim() })
  const isMember = holdings.data !== null && (holdings.data.write || holdings.data.maintain)
  const target = { id: pull.id, number: pull.number }

  const postComment = async (): Promise<void> => {
    if (posting || comment.trim() === '' || !guard.check(commentCost.credits)) return
    if (!sdk || !signer) return
    setPosting(true)
    setCommentError(null)
    try {
      await createComment(sdk, signer, home.repo, { targetId: pull.id, body: comment.trim(), intent: draft.intent })
      setComment('')
      draft.renew()
      reload()
    } catch (e) {
      setCommentError(writeErrorMessage(e).message)
    } finally {
      setPosting(false)
    }
  }

  const runPending = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    if (pending === 'merge') await addEvent(sdk, signer, home.repo, { target, kind: 'merge', oidHex: pull.headOid, intent })
    else if (pending === 'close' || pending === 'reopen') {
      await setTargetState(sdk, signer, home.repo, { target, kind: pending, author: pull.author, isMember, intent })
    } else {
      await createReview(sdk, signer, home.repo, {
        patchId: pull.id,
        verdict: pending.review,
        commitOid: pull.headOid,
        body: comment.trim(),
        intent,
      })
      setComment('')
      draft.renew()
    }
    reload()
  }
  const pendingCost =
    pending !== null && typeof pending === 'object'
      ? previewCreate('review', { body: comment.trim() })
      : previewCreate(pending === 'merge' || isMember ? 'event' : 'authorEvent')

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
        {/* Where the PR's objects actually live. Without this a reviewer has a commit id
            with no stated home: a PR's head normally sits in the contributor's own repo, and
            the patch document's source pointer (v1 sourceContractId, v2 sourceRepoId) is the
            only pointer to it. */}
        {pull.sourceId ? (
          <div className="mt-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
            <span className="text-anvil-500 dark:text-anvil-400">
              {home.repo.kind === 'v2' && pull.sourceId === home.repo.repoId ? (
                <>Objects live in this repo</>
              ) : (
                <>
                  Objects live in {home.repo.kind === 'v1' ? 'contract' : 'repo'}{' '}
                  <span className="font-mono break-all">{pull.sourceId}</span>
                </>
              )}
              {pull.sourceRefName ? <> on <span className="font-mono">{pull.sourceRefName}</span></> : null}
            </span>
            <div className="mt-1 font-mono text-[12px] text-anvil-400 break-all">
              dg pr checkout {addr.owner}/{addr.name} {pull.number}
            </div>
          </div>
        ) : null}
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

      {data.approvals !== null ? (
        <Approvals approvals={data.approvals} author={pull.author} headOid={pull.headOid} />
      ) : null}

      <PullDiff pull={pull} home={home} />

      {timeline.length > 0 ? <Timeline items={timeline} /> : null}

      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="mb-2 text-dense font-medium">Review</h3>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a review comment…" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={commentCost} />
          <div className="flex flex-wrap items-center gap-2">
            {actions.canCloseReopen ? (
              <Button variant="outline" onClick={() => setPending(open ? 'close' : 'reopen')} disabled={!signer || guard.disabledReason !== null}>
                {open ? 'Close' : 'Reopen'}
              </Button>
            ) : null}
            {actions.canMarkMerged ? (
              <Button variant="primary" onClick={() => setPending('merge')} disabled={!signer || guard.disabledReason !== null}>
                <GitMerge className="h-3.5 w-3.5" aria-hidden /> Mark as merged
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={postComment}
              loading={posting}
              disabled={comment.trim() === '' || guard.disabledReason !== null}
              title={guard.disabledReason ?? undefined}
            >
              {identity ? 'Comment' : 'Sign in'}
            </Button>
          </div>
        </div>
        {open && identity !== null && pull.headOid ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <span className="text-dense text-anvil-500 dark:text-anvil-400">
              Review head <span className="font-mono">{pull.headOid.slice(0, 9)}</span>:
            </span>
            {(Object.keys(VERDICT_TEXT) as VerdictInput[]).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={v === 'approve' ? 'primary' : 'outline'}
                disabled={guard.disabledReason !== null}
                onClick={() => {
                  if (guard.check(previewCreate('review', { body: comment.trim() }).credits)) setPending({ review: v })
                }}
              >
                {VERDICT_TEXT[v]}
              </Button>
            ))}
            {!isMember && holdings.settled ? (
              <span className="text-[12px] text-anvil-400">Only approvals from maintainers and writers count.</span>
            ) : null}
          </div>
        ) : null}
        {actions.canMarkMerged ? (
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            {actions.markCountsNow
              ? `The head commit is already on ${base}, so a merge mark counts as soon as it lands. The web app cannot merge code itself.`
              : `The web app cannot merge code. Push the head commit to ${base} first; a merge mark only counts once it is there.`}
          </p>
        ) : actions.mergeHint !== null ? (
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">{actions.mergeHint}</p>
        ) : null}
        {commentError ? (
          <div className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger break-words">{commentError}</div>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending !== null && typeof pending === 'object'
            ? `${VERDICT_TEXT[pending.review]} PR #${pull.number}`
            : pending === 'merge'
              ? `Mark PR #${pull.number} as merged`
              : pending === 'close'
                ? `Close PR #${pull.number}`
                : `Reopen PR #${pull.number}`
        }
        description={
          pending === 'merge'
            ? `Appends a merge event naming ${pull.headOid.slice(0, 9)}. This does not merge any code. ${
                actions.markCountsNow
                  ? `That commit is already on ${base}, so the PR will show as merged.`
                  : `That commit is not on ${base} yet, so the PR stays open until a push puts it there. If ${base} has moved on, the commit that lands will be a merge commit, not this head; record that merge with the CLI instead (dg pr merge --merge-oid).`
              }`
            : pending !== null && typeof pending === 'object'
              ? `Records a ${VERDICT_TEXT[pending.review].toLowerCase()} review on ${pull.headOid.slice(0, 9)}${comment.trim() ? ', with your comment as its body' : ''}. New commits make it stale.`
              : 'Appends a state event to the append-only log.'
        }
        cost={pendingCost}
        confirmLabel={
          pending !== null && typeof pending === 'object'
            ? 'Sign & submit review'
            : pending === 'merge'
              ? 'Sign & mark merged'
              : pending === 'close'
                ? 'Close PR'
                : 'Reopen PR'
        }
        onConfirm={runPending}
      />
    </div>
  )
}
