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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { plural } from '@/lib/view/format'
import {
  addDraftComment,
  draftCost,
  draftIsEmpty,
  draftWhereabouts,
  editDraftComment,
  newReviewDraft,
  partialSubmitMessage,
  reanchorDraft,
  removeDraftComment,
  setDraftVerdict,
  splitDraftComments,
  startSubmit,
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

/**
 * The viewer's pending review on a PR: loaded, edited and submitted in this browser. Nothing is
 * offered until the stored draft has loaded (adding a comment earlier would start a second
 * draft over it), and every change reads the latest draft, never a render's stale copy.
 */
export function useReviewDraft(repo: RepoRef, pullId: string, headOid: string): {
  draft: ReviewDraft | null
  loaded: boolean
  pending: PendingReview | undefined
  update: (d: ReviewDraft | null) => void
  /** The draft to edit: the stored one, or a new one on the current head. */
  ensure: () => ReviewDraft | null
} {
  const { identity } = useAuth()
  const { network } = useSdk()
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const latest = useRef<ReviewDraft | null>(null)
  useEffect(() => {
    let live = true
    setLoaded(false)
    setDraft(null)
    latest.current = null
    if (identity === null) return
    loadReviewDraft(network, identity, pullId)
      .then((d) => {
        if (!live) return
        latest.current = d ?? null
        setDraft(d ?? null)
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
      latest.current = d
      setDraft(d)
      if (identity === null) return
      if (d === null || draftIsEmpty(d)) void discardReviewDraft(network, identity, pullId)
      else void saveReviewDraft(d, repo)
    },
    [identity, network, pullId, repo],
  )

  const ensure = useCallback(
    (): ReviewDraft | null =>
      identity === null
        ? null
        : latest.current ??
          newReviewDraft({ draftId: newIntent(), network, identity, repoId: repo.repoId, prId: pullId, headOid, private: repo.visibility === 'private', now: Date.now() }),
    [identity, network, repo, pullId, headOid],
  )

  const pending = useMemo<PendingReview | undefined>(
    () =>
      identity === null || !loaded
        ? undefined
        : {
            ...(({ onLines, elsewhere }) => ({ comments: onLines, elsewhere }))(splitDraftComments(draft, headOid)),
            count: draft?.comments.length ?? 0,
            frozen: draft !== null && submitStarted(draft),
            onAdd: (anchor: AnchorInput, body: string) => {
              const d = ensure()
              if (d !== null) update(addDraftComment(d, newIntent(), anchor, body))
            },
            onEdit: (localId, body) => {
              if (latest.current !== null) update(editDraftComment(latest.current, localId, body))
            },
            onRemove: (localId) => {
              if (latest.current !== null) update(removeDraftComment(latest.current, localId))
            },
          },
    [identity, loaded, draft, headOid, ensure, update],
  )
  return { draft, loaded, pending, update, ensure }
}

export function ReviewDrawer({
  repo,
  pullId,
  headOid,
  draft,
  loaded,
  update,
  ensure,
  isMember,
  isAuthor = false,
  locked,
  lineExists,
  onSubmitted,
}: {
  repo: RepoRef
  pullId: string
  headOid: string
  draft: ReviewDraft | null
  /** The stored draft has loaded: until then nothing is saved over it. */
  loaded: boolean
  update: (d: ReviewDraft | null) => void
  ensure: () => ReviewDraft | null
  isMember: boolean
  /**
   * The viewer opened this PR: their own approve / request changes never counts
   * (`countApprovals`, as on GitHub), so only a comment-only review is offered (`dg pr review`
   * refuses the others the same way).
   */
  isAuthor?: boolean
  /** The PR's conversation is locked: a member's review and its comments carry the membership proof. */
  locked: boolean
  /** Whether the current diff shows a line (for re-anchoring after the head moved). */
  lineExists: (path: string, side: 0 | 1, line: number) => boolean
  /** The submitted review and every comment it wrote (the page re-reads until all show). */
  onSubmitted: (submitted: { reviewId: string; commentIds: readonly string[] }) => void
}): JSX.Element {
  const { sdk, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState(draft?.summary ?? '')
  const [chosen, setVerdict] = useState<VerdictInput>(draft?.verdict ?? 'comment')
  // A draft saved with a verdict before the viewer's authorship was known still submits as a comment.
  const verdict: VerdictInput = isAuthor ? 'comment' : chosen
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Follow the draft being shown: another draft (loaded, or another identity's), or none at all
  // (discarded, submitted, or signed out) resets the fields, so one draft's words never land in
  // another.
  useEffect(() => {
    setSummary(draft?.summary ?? '')
    setVerdict(draft?.verdict ?? 'comment')
  }, [draft?.draftId, identity]) // eslint-disable-line react-hooks/exhaustive-deps

  // The summary and verdict are part of the draft: kept in this browser as they change (shortly
  // after typing stops), so closing the panel or reloading the page loses neither.
  const frozen = draft !== null && submitStarted(draft)
  useEffect(() => {
    if (!loaded || frozen || progress !== null) return
    const same = draft === null ? summary === '' && verdict === 'comment' : draft.summary === summary && draft.verdict === verdict
    if (same) return
    const t = setTimeout(() => {
      const d = ensure()
      if (d !== null && !submitStarted(d)) update(setDraftVerdict(d, verdict, summary))
    }, 250)
    return () => clearTimeout(t)
  }, [summary, verdict, draft, loaded, frozen, progress, ensure, update])

  const count = draft?.comments.length ?? 0
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
    // The draft as it will be written, frozen before anything is: its attempt on record, the
    // chosen verdict and the trimmed summary. The page then offers no edits (pending.frozen) and
    // the auto-save stands down, so nothing re-saves an editable draft over the submit's.
    let toSubmit: ReviewDraft = planned
    if (!frozen) {
      const base = ensure()
      if (base === null) return
      toSubmit = startSubmit(base, verdict, summary, Date.now())
      setSummary(toSubmit.summary)
      update(toSubmit)
    }
    setError(null)
    setProgress({ done: 0, total: documents })
    try {
      const r = await submitReviewDraft(sdk, signer, repo, toSubmit, { isMember, locked }, (p) => setProgress(p))
      update(null)
      setOpen(false)
      setProgress(null)
      onSubmitted(r)
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
    setNote(stranded === 0 ? 'Every pending comment moved to the new head.' : `${plural(stranded, 'comment')} ${stranded === 1 ? 'stays' : 'stay'} on the old head and will show as outdated.`)
  }

  return (
    <div className="relative" data-testid="review-drawer">
      <Button variant={count > 0 ? 'primary' : 'outline'} size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={identity === null || !loaded}>
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
          <p className="text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="draft-whereabouts">
            {draftWhereabouts(repo.visibility === 'private')} Nothing is on Platform until you submit.
          </p>
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
              Submitting your {VERDICT_WORDS[draft!.verdict]}: {draft!.reviewId ? `the review and ${draft!.comments.filter((c) => c.landedId).length} of ${plural(count, 'comment')} have landed.` : 'nothing has landed yet.'}
            </p>
          ) : (
            <>
              <MarkdownEditor id="review-summary" label="Review summary" value={summary} onChange={setSummary} placeholder="Leave a summary (optional)" />
              <fieldset className="space-y-1.5">
                <legend className="sr-only">Verdict</legend>
                {VERDICTS.filter((v) => !isAuthor || v.value === 'comment').map((v) => (
                  <label key={v.value} className="flex items-start gap-2 text-dense">
                    <input type="radio" name="verdict" value={v.value} checked={verdict === v.value} onChange={() => setVerdict(v.value)} className="mt-1 accent-forge-700" />
                    <span>
                      <span className="font-medium">{v.label}</span>
                      <span className="block text-[12px] text-anvil-500 dark:text-anvil-400">{v.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {isAuthor ? (
                <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="review-author-note">
                  You opened this PR: your own approval would never count, so your review is a comment.
                </p>
              ) : !isMember && verdict !== 'comment' ? (
                <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Only maintainers&apos; and writers&apos; verdicts count toward merging.</p>
              ) : null}
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
              {plural(documents, 'document')} ·{cost !== null ? <CostPreview cost={cost} /> : null}
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
              Submitting review · {progress.done} of {plural(progress.total, 'document')}
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
