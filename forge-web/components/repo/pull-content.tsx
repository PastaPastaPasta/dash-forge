'use client'

/**
 * PullContent — PR detail: folded state, base/head, where the PR's objects live, the author's
 * body, the timeline (comments, state events and review verdicts), a comment composer, and
 * mark-as-merged / close / reopen.
 *
 * Two things this does NOT do, stated here because the names suggest otherwise:
 *
 * * **It cannot merge code.** "Mark as merged" appends a `merge` event carrying the PR head
 *   oid. The fold accepts that event only from a WRITE or MAINTAIN holder, and only once the
 *   head has been a tip of the base ref — which a push must do. So the control is shown only
 *   to WRITE/MAINTAIN holders ({@link pullActions}) and says whether the head is already on
 *   the base branch. For a base branch that has moved on, the merge commit is not the head
 *   oid at all; that merge is recorded with the CLI (`dg pr merge --merge-oid`).
 * * **No diff is rendered.** A PR's head commit normally lives in a different contract from
 *   the repo being viewed, and the browse boundary is bound to a single contract, so showing
 *   one needs a second browse context against `sourceContractId`. Until then the page links
 *   out rather than pretending.
 */

import { useState } from 'react'
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import type { RepoHome, PullThread } from '@/lib/view'
import { loadPullThread, pullActions, timeAgo } from '@/lib/view'
import { addEvent, closeTarget, createComment, readViewerHoldings, reopenTarget } from '@/lib/repo'
import type { Holdings } from '@/lib/rules'
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

export function PullContent({ home, addr, number }: { home: RepoHome; addr: RepoAddress; number: number }): JSX.Element {
  const { sdk, ready, network } = useSdk([home.repo.contractId])
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const { data, loading, error, reload } = useAsync<PullThread | null>(
    () => loadPullThread(sdk!, home.repo, number),
    [ready, home.repo.contractId, number],
    { enabled: ready && sdk !== null && Number.isFinite(number) },
  )

  // The viewer's current WRITE/MAINTAIN holdings — what the PR controls are gated on. Shares
  // the token-history cache the fold itself reads, so this is usually free.
  const holdings = useAsync<Holdings | null>(
    () => readViewerHoldings(sdk!, home.repo, identity!, network),
    [ready, home.repo.contractId, identity ?? '', network],
    { enabled: ready && sdk !== null && identity !== null },
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
  const actions = pullActions({
    pull,
    viewer: identity,
    // Signed in but not yet read: withhold the controls without a "can't" message.
    holdings: identity !== null && !holdings.settled ? 'loading' : holdings.data,
  })
  const base = pull.baseRefName || 'the base branch'

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
        {/* Where the PR's objects actually live. Without this a reviewer has a commit id
            with no stated home: a PR's head normally sits in the contributor's own contract,
            and the patch document's sourceContractId is the only pointer to it. */}
        {pull.sourceContractId ? (
          <div className="mt-2 rounded-md border border-anvil-200 bg-anvil-50 px-3 py-2 text-dense dark:border-anvil-800 dark:bg-anvil-900">
            <span className="text-anvil-500 dark:text-anvil-400">
              Objects live in contract <span className="font-mono break-all">{pull.sourceContractId}</span>
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

      {timeline.length > 0 ? <Timeline items={timeline} /> : null}

      <div className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <h3 className="mb-2 text-dense font-medium">Review</h3>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a review comment…" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <CostPreview cost={previewDocumentCreate('comment')} />
          <div className="flex items-center gap-2">
            {actions.canCloseReopen ? (
              <Button variant="outline" onClick={() => setPending(open ? 'close' : 'reopen')} disabled={!signer}>
                {open ? 'Close' : 'Reopen'}
              </Button>
            ) : null}
            {actions.canMarkMerged ? (
              <Button variant="primary" onClick={() => setPending('merge')} disabled={!signer}>
                <GitMerge className="h-3.5 w-3.5" aria-hidden /> Mark as merged
              </Button>
            ) : null}
            <Button variant="primary" onClick={postComment} loading={posting} disabled={comment.trim() === ''}>
              {identity ? 'Comment' : 'Sign in'}
            </Button>
          </div>
        </div>
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
        title={pending === 'merge' ? `Mark PR #${pull.number} as merged` : pending === 'close' ? `Close PR #${pull.number}` : `Reopen PR #${pull.number}`}
        description={
          pending === 'merge'
            ? `Appends a merge event naming ${pull.headOid.slice(0, 9)}. This does not merge any code. ${
                actions.markCountsNow
                  ? `That commit is already on ${base}, so the PR will show as merged.`
                  : `That commit is not on ${base} yet, so the PR stays open until a push puts it there. If ${base} has moved on, the commit that lands will be a merge commit, not this head; record that merge with the CLI instead (dg pr merge --merge-oid).`
              }`
            : 'Appends a state event to the append-only log.'
        }
        cost={previewDocumentCreate('event')}
        confirmLabel={pending === 'merge' ? 'Sign & mark merged' : pending === 'close' ? 'Close PR' : 'Reopen PR'}
        onConfirm={runPending}
      />
    </div>
  )
}
