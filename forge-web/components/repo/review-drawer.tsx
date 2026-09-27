'use client'

/**
 * The pending review (review-parity R1, §4.1): the "Review changes" button (with the pending
 * count) and its panel — summary, Comment / Approve / Request changes, the pending comments,
 * "n documents · ≈ DASH" and Submit. Nothing is on Platform until Submit; the draft lives in this
 * browser (IndexedDB; memory only for a private repo). Submit writes the review, then each
 * comment, with progress; a failure keeps what landed and Retry finishes it, never writing a
 * document twice (`submitReviewDraft`). If the PR head moved since the draft began, the panel
 * says so and offers to re-anchor the comments whose lines still exist.
 */

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, MessageSquareDashed } from 'lucide-react'

import {
  discardReviewDraft,
  loadReviewDraft,
  saveReviewDraft,
  submitReviewDraft,
  type AnchorInput,
  type RepoRef,
  type ReviewDraft,
  type VerdictInput,
} from '@/lib/repo'
import { newIntent } from '@/lib/sdk'
import { anchorLabel } from '@/lib/view/inline-threads'
import {
  addDraftComment,
  draftCost,
  editDraftComment,
  newReviewDraft,
  partialSubmitMessage,
  reanchorDraft,
  removeDraftComment,
  setDraftVerdict,
  submitStarted,
} from '@/lib/view/pending-review'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { MarkdownEditor } from '@/components/repo/issue-bits'
import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { Oid } from '@/components/ui/oid'
import type { PendingReview } from '@/components/repo/inline-comments'
import { cn } from '@/lib/utils'

const VERDICTS: readonly { value: VerdictInput; label: string; help: string }[] = [
  { value: 'comment', label: 'Comment', help: 'General feedback without an explicit verdict.' },
  { value: 'approve', label: 'Approve', help: 'Approve merging these changes (counts when you are a maintainer or writer).' },
  { value: 'requestChanges', label: 'Request changes', help: 'Feedback that must be addressed before merging.' },
]

/** The verdict's words in messages. */
export const VERDICT_WORDS: Readonly<Record<VerdictInput, string>> = { comment: 'Comment', approve: 'Approval', requestChanges: 'Request changes' }

/** The viewer's pending review on a PR: loaded, edited and submitted in this browser. */
export function useReviewDraft(repo: RepoRef, pullId: string, headOid: string): {
  draft: ReviewDraft | null
  loaded: boolean
  pending: PendingReview | undefined
  update: (d: ReviewDraft | null) => void
} {
  const { identity } = useAuth()
  const { network } = useSdk()
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    setLoaded(false)
    setDraft(null)
    if (identity === null) return
    loadReviewDraft(network, identity, pullId)
      .then((d) => {
        if (live) setDraft(d ?? null)
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [network, identity, pullId])

  const update = useCallback(
    (d: ReviewDraft | null) => {
      setDraft(d)
      if (identity === null) return
      if (d === null || (d.comments.length === 0 && d.summary === '' && !submitStarted(d))) void discardReviewDraft(network, identity, pullId)
      else void saveReviewDraft(d, repo)
    },
    [identity, network, pullId, repo],
  )

  const ensure = useCallback(
    (): ReviewDraft | null =>
      identity === null
        ? null
        : draft ??
          newReviewDraft({ draftId: newIntent(), network, identity, repoId: repo.repoId, prId: pullId, headOid, private: repo.visibility === 'private', now: Date.now() }),
    [draft, identity, network, repo, pullId, headOid],
  )

  const pending: PendingReview | undefined =
    identity === null
      ? undefined
      : {
          comments: draft?.comments ?? [],
          frozen: draft !== null && submitStarted(draft),
          onAdd: (anchor: AnchorInput, body: string) => {
            const d = ensure()
            if (d !== null) update(addDraftComment(d, newIntent(), anchor, body))
          },
          onEdit: (localId, body) => {
            if (draft !== null) update(editDraftComment(draft, localId, body))
          },
          onRemove: (localId) => {
            if (draft !== null) update(removeDraftComment(draft, localId))
          },
        }
  return { draft, loaded, pending, update }
}

export function ReviewDrawer({
  repo,
  pullId,
  headOid,
  draft,
  update,
  isMember,
  lineExists,
  onSubmitted,
}: {
  repo: RepoRef
  pullId: string
  headOid: string
  draft: ReviewDraft | null
  update: (d: ReviewDraft | null) => void
  isMember: boolean
  /** Whether the current diff shows a line (for re-anchoring after the head moved). */
  lineExists: (path: string, side: 0 | 1, line: number) => boolean
  onSubmitted: (reviewId: string) => void
}): JSX.Element {
  const { sdk, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState(draft?.summary ?? '')
  const [verdict, setVerdict] = useState<VerdictInput>(draft?.verdict ?? 'comment')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (draft !== null) {
      setSummary(draft.summary)
      setVerdict(draft.verdict)
    }
  }, [draft?.draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  const count = draft?.comments.length ?? 0
  const frozen = draft !== null && submitStarted(draft)
  const headMoved = draft !== null && draft.headOid !== headOid && !frozen
  const working: ReviewDraft | null =
    identity === null
      ? null
      : draft ?? newReviewDraft({ draftId: 'preview', network, identity, repoId: repo.repoId, prId: pullId, headOid, private: repo.visibility === 'private', now: 0 })
  const planned = working === null ? null : frozen ? working : { ...working, summary, verdict }
  const { documents, cost } = planned === null ? { documents: 0, cost: null } : draftCost(planned)

  const submit = async (): Promise<void> => {
    if (!sdk || !signer || identity === null || planned === null) return
    if (cost === null || !guard.check(cost, 'collab')) return
    if (!frozen && verdict === 'comment' && summary.trim() === '' && count === 0) {
      setError('Write a summary or add a comment first.')
      return
    }
    // The draft as it will be written: with a real id and the chosen verdict and summary.
    const toSubmit: ReviewDraft = frozen ? planned : setDraftVerdict(draft ?? { ...planned, draftId: newIntent(), startedAt: Date.now() }, verdict, summary.trim())
    if (!frozen) update(toSubmit)
    setError(null)
    setProgress({ done: 0, total: documents })
    try {
      const r = await submitReviewDraft(sdk, signer, repo, toSubmit, (p) => setProgress(p))
      update(null)
      setOpen(false)
      setProgress(null)
      setSummary('')
      setVerdict('comment')
      onSubmitted(r.reviewId)
    } catch (e) {
      // What landed is saved in the draft (IndexedDB or memory): read it back to say so.
      const saved = (await loadReviewDraft(network, identity, pullId).catch(() => undefined)) ?? toSubmit
      update(saved)
      setProgress(null)
      setError(`${partialSubmitMessage(saved, VERDICT_WORDS[saved.verdict])} (${guard.failed(e)})`)
    }
  }

  const reanchor = (): void => {
    if (draft === null) return
    const { draft: moved, stranded } = reanchorDraft(draft, headOid, lineExists)
    update(moved)
    setNote(stranded === 0 ? 'Every pending comment moved to the new head.' : `${stranded} comment${stranded === 1 ? '' : 's'} stay on the old head and will show as outdated.`)
  }

  return (
    <div className="relative" data-testid="review-drawer">
      <Button variant={count > 0 ? 'primary' : 'outline'} size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={identity === null}>
        <MessageSquareDashed className="h-3.5 w-3.5" aria-hidden />
        Review changes
        {count > 0 ? (
          <span className="rounded-full bg-white/25 px-1.5 text-[11px]" data-testid="pending-count">
            {count}
          </span>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open ? (
        <section
          aria-label="Finish your review"
          className="absolute right-0 z-30 mt-2 w-[min(32rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-anvil-200 bg-white p-4 text-left shadow-xl dark:border-anvil-750 dark:bg-anvil-950"
        >
          <h3 className="text-dense font-semibold">Finish your review</h3>
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Pending comments stay in this browser until you submit.</p>
          {headMoved && draft ? (
            <div className="rounded-md border border-caution/40 bg-caution/5 px-3 py-2 text-dense" data-testid="draft-head-moved">
              The PR moved to <Oid value={headOid} chars={7} copyable={false} /> since you started. Your comments are anchored to{' '}
              <Oid value={draft.headOid} chars={7} copyable={false} /> and will show as outdated.
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={reanchor}>
                  Re-anchor (lines that still exist)
                </Button>
              </div>
            </div>
          ) : null}
          {note ? <p className="text-[12px] text-anvil-600 dark:text-anvil-300">{note}</p> : null}
          {frozen ? (
            <p className="text-dense">
              Submitting your {VERDICT_WORDS[draft!.verdict]}: {draft!.reviewId ? `the review and ${draft!.comments.filter((c) => c.landedId).length} of ${count} comments have landed.` : 'nothing has landed yet.'}
            </p>
          ) : (
            <>
              <MarkdownEditor id="review-summary" label="Review summary" value={summary} onChange={setSummary} placeholder="Leave a summary (optional)" />
              <fieldset className="space-y-1.5">
                <legend className="sr-only">Verdict</legend>
                {VERDICTS.map((v) => (
                  <label key={v.value} className="flex items-start gap-2 text-dense">
                    <input type="radio" name="verdict" value={v.value} checked={verdict === v.value} onChange={() => setVerdict(v.value)} className="mt-1 accent-forge-700" />
                    <span>
                      <span className="font-medium">{v.label}</span>
                      <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{v.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {!isMember && verdict !== 'comment' ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Only maintainers&apos; and writers&apos; verdicts count toward merging.</p> : null}
            </>
          )}
          {count > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-auto border-t border-anvil-100 pt-2 text-[12px] dark:border-anvil-850" aria-label="Pending comments">
              {draft!.comments.map((c) => (
                <li key={c.localId} className={cn('flex items-baseline gap-2', c.landedId && 'text-verify-700 dark:text-verify-400')}>
                  <span className="shrink-0 font-mono">
                    {anchorLabel({ path: c.anchor.path, line: c.anchor.line ?? null, startLine: c.anchor.startLine ?? null, side: c.anchor.side ?? null, commitOid: c.anchor.commitOid ?? '' })}
                  </span>
                  <span className="truncate text-anvil-600 dark:text-anvil-300">{c.body.split('\n')[0]}</span>
                  {c.landedId ? <span>landed</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-anvil-100 pt-3 dark:border-anvil-850">
            <span className="flex items-center gap-2 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="review-documents">
              {documents} document{documents === 1 ? '' : 's'} ·{cost !== null ? <CostPreview cost={cost} /> : null}
            </span>
            <div className="flex gap-2">
              {draft !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={progress !== null}
                  onClick={() => {
                    update(null)
                    setError(null)
                    setOpen(false)
                  }}
                >
                  {frozen ? 'Discard the rest' : 'Discard'}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" onClick={submit} loading={progress !== null} disabled={guard.disabledReason !== null || progress !== null}>
                {frozen || error ? 'Retry' : 'Submit review'}
              </Button>
            </div>
          </div>
          {progress !== null ? (
            <p className="text-[12px] text-anvil-600 dark:text-anvil-300" role="status" data-testid="review-progress">
              Submitting review · {progress.done} of {progress.total} documents
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-dense text-danger-700 dark:text-danger-400" data-testid="review-error">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
