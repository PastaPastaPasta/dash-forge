'use client'

/**
 * The PR's Reviewers card (review-parity R9, R11, R12; spec §4.4): one row per requested
 * reviewer and per reviewer, with their standing (approved, changes requested, commented,
 * awaiting, stale, dismissed, doesn't count), exactly as `dg pr view` lists them
 * (`reviewerRows`). The author and members request and re-request reviews; members dismiss a
 * review with a short public reason. The page confirms and signs.
 */

import { useState } from 'react'
import { Check, Clock, Eye, MessageSquare, MinusCircle, RotateCcw, X, XCircle } from 'lucide-react'

import type { Membership } from '@/lib/rules/v2'
import { STANDING_LABEL, type ImportedReviewer, type ReviewerCardRow, type Standing } from '@/lib/view/review-fold'
import type { ImportedVerdict } from '@/lib/repo/provenance'
import { isIdentityId } from '@/lib/utils'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Oid } from '@/components/ui/oid'
import { CheckMark } from '@/components/repo/issue-bits'
import { cn } from '@/lib/utils'

function StandingIcon({ state }: { state: Standing }): JSX.Element {
  const muted = 'h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400'
  switch (state) {
    case 'approved':
      return <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
    case 'changesRequested':
      return <X className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
    case 'awaiting':
    case 'stale':
      return <Clock className={muted} aria-hidden />
    case 'dismissed':
      return <XCircle className={muted} aria-hidden />
    case 'notMember':
    case 'author':
      return <MinusCircle className={muted} aria-hidden />
    default:
      return <MessageSquare className={muted} aria-hidden />
  }
}

/** How the Reviewers card words a source forge's verdict. */
const IMPORTED_LABEL: Readonly<Record<ImportedVerdict, string>> = {
  approved: 'Approved',
  'requested changes': 'Changes requested',
  commented: 'Commented',
}

/** A mirrored PR's reviewers on the source forge (QW-017): shown as they reviewed there, never counted here. */
function ImportedReviewers({ reviewers }: { reviewers: readonly ImportedReviewer[] }): JSX.Element | null {
  if (reviewers.length === 0) return null
  const hosts = [...new Set(reviewers.map((r) => r.host).filter((h) => h !== ''))]
  return (
    <div className="mt-2" data-testid="imported-reviewers">
      <p className="text-[11px] text-anvil-500 dark:text-anvil-400">
        On {hosts.length === 1 ? hosts[0] : 'the source forge'} · not counted here
      </p>
      <ul className="mt-1 space-y-1.5" aria-label="Reviewers on the source forge">
        {reviewers.map((r) => (
          <li key={r.login} className="flex flex-wrap items-center gap-1.5 text-dense" data-testid="imported-reviewer" data-login={r.login} data-verdict={r.verdict}>
            <StandingIcon state={r.verdict === 'approved' ? 'approved' : r.verdict === 'requested changes' ? 'changesRequested' : 'commented'} />
            <span className="font-medium text-anvil-800 dark:text-anvil-100">@{r.login}</span>
            <span className={cn('text-[12px]', r.verdict === 'approved' ? 'text-verify-700 dark:text-verify-400' : r.verdict === 'requested changes' ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>
              {IMPORTED_LABEL[r.verdict]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ReviewersCard({
  rows: allRows,
  imported = [],
  mirrorOnly,
  members,
  author,
  headOid,
  membersKnown,
  canRequest,
  canDismiss,
  onRequest,
  onDismiss,
}: {
  rows: readonly ReviewerCardRow[]
  /** A mirrored PR's reviewers on the source forge (`importedReviewers`). */
  imported?: readonly ImportedReviewer[]
  /** Signers all of whose reviews were imported (the mirror identity): their row is left out unless requested. */
  mirrorOnly?: ReadonlySet<string>
  members: readonly Membership[]
  author: string
  headOid: string
  /** The membership was read (else standings are not shown). */
  membersKnown: boolean
  /** The viewer may request reviews (the author or a member). */
  canRequest: boolean
  /** The viewer may dismiss reviews (a member). */
  canDismiss: boolean
  onRequest: (who: string, remove: boolean) => void
  /** Dismiss `row`'s review with a short public reason (≤ 120 characters). */
  onDismiss: (row: ReviewerCardRow, reason: string) => void
}): JSX.Element {
  const [picking, setPicking] = useState(false)
  // Keyed by the review being dismissed, not the reviewer (QW2-047): once it is dismissed, the
  // reviewer's older verdict that resurfaces is another review, and the form does not follow it.
  const [dismissing, setDismissing] = useState<{ id: string; reason: string } | null>(null)
  const [other, setOther] = useState('')
  const rows = mirrorOnly === undefined ? allRows : allRows.filter((r) => r.requested || !mirrorOnly.has(r.identity))
  const listed = new Set(rows.filter((r) => r.requested).map((r) => r.identity))
  // Members first (their approvals count), never the author.
  const candidates = [...members].sort((a, b) => (a.role === b.role ? 0 : a.role === 'maintainer' ? -1 : 1)).filter((m) => m.identity !== author)
  return (
    <div data-testid="reviewers-card">
      {!membersKnown ? <p className="text-anvil-500 dark:text-anvil-400">Couldn&apos;t read the members, so standings are unknown.</p> : null}
      {rows.length === 0 && imported.length === 0 && membersKnown ? <p className="text-anvil-500 dark:text-anvil-400">No reviews yet</p> : null}
      <ul className="space-y-2" aria-label="Reviewers">
        {rows.map((r) => (
          <li key={r.identity} className="text-dense" data-testid="reviewer-row" data-identity={r.identity} data-state={r.state}>
            <div className="flex flex-wrap items-center gap-1.5">
              <StandingIcon state={r.state} />
              <Author identityId={r.identity} link={false} />
              {canRequest && r.state !== 'awaiting' && r.identity !== author ? (
                <button
                  type="button"
                  onClick={() => onRequest(r.identity, false)}
                  aria-label={`Re-request review from ${r.identity.slice(0, 8)}`}
                  title="Re-request review"
                  className="ml-auto rounded p-0.5 text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
              {canRequest && r.requested && r.state === 'awaiting' ? (
                <button
                  type="button"
                  onClick={() => onRequest(r.identity, true)}
                  aria-label={`Remove review request for ${r.identity.slice(0, 8)}`}
                  title="Remove the request"
                  className="ml-auto rounded p-0.5 text-anvil-500 hover:text-danger-700 dark:text-anvil-400 dark:hover:text-danger-400"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <p className={cn('ml-5 text-[12px]', r.state === 'approved' ? 'text-verify-700 dark:text-verify-400' : r.state === 'changesRequested' ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>
              {STANDING_LABEL[r.state]}
              {r.reRequested ? ' (re-requested)' : ''}
              {r.state === 'stale' && r.reviewedOid ? (
                <>
                  {' '}
                  (reviewed <Oid value={r.reviewedOid} chars={7} copyable={false} />)
                </>
              ) : null}
              {r.state === 'dismissed' && r.dismissReason ? `: ${r.dismissReason}` : ''}
            </p>
            {canDismiss && r.dismissId !== null && (r.state === 'approved' || r.state === 'changesRequested') ? (
              dismissing?.id === r.dismissId ? (
                <div className="ml-5 mt-1 space-y-1">
                  <Input
                    aria-label="Reason for dismissing"
                    value={dismissing.reason}
                    maxLength={120}
                    onChange={(e) => setDismissing({ id: dismissing.id, reason: e.target.value })}
                    placeholder="Reason (public, optional)"
                    className="h-7 py-0 text-[12px]"
                    autoFocus
                  />
                  <div className="flex gap-1">
                    <Button size="sm" variant="danger" onClick={() => onDismiss(r, dismissing.reason.trim())}>
                      Dismiss
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDismissing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => r.dismissId !== null && setDismissing({ id: r.dismissId, reason: '' })}
                  className="ml-5 text-[12px] text-anvil-500 underline-offset-2 hover:text-danger-700 hover:underline dark:text-anvil-400 dark:hover:text-danger-400"
                >
                  Dismiss review
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <ImportedReviewers reviewers={imported} />
      {canRequest ? (
        <div className="mt-2">
          <button type="button" onClick={() => setPicking((p) => !p)} aria-expanded={picking} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400">
            <Eye className="h-3.5 w-3.5" aria-hidden /> Request a review
          </button>
          {picking ? (
            <div className="mt-2 space-y-1 rounded-md border border-anvil-200 p-2 dark:border-anvil-750" role="group" aria-label="Request a reviewer">
              {candidates.map((m) => {
                const on = listed.has(m.identity)
                return (
                  <button
                    key={m.identity}
                    type="button"
                    aria-pressed={on}
                    // The picker closes on a choice (QW3-049): the request then shows in the list above.
                    onClick={() => {
                      setPicking(false)
                      onRequest(m.identity, on)
                    }}
                    title={on ? 'Remove the review request' : 'Request a review'}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850 coarse:min-h-11"
                    data-testid="reviewer-option"
                    data-identity={m.identity}
                  >
                    <CheckMark on={on} />
                    <Author identityId={m.identity} link={false} />
                    <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{m.role}</span>
                    {on ? <span className="ml-auto text-[11px] text-anvil-500 dark:text-anvil-400">Requested</span> : null}
                  </button>
                )
              })}
              <div className="flex gap-1 pt-1">
                <Input aria-label="Request identity id" value={other} onChange={(e) => setOther(e.target.value)} placeholder="identity id" className="h-7 py-0 font-mono text-[12px]" />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!isIdentityId(other.trim()) || other.trim() === author || listed.has(other.trim())}
                  onClick={() => {
                    const who = other.trim()
                    setPicking(false)
                    onRequest(who, false)
                  }}
                >
                  Request
                </Button>
              </div>
              <p className="text-[11px] text-anvil-500 dark:text-anvil-400">Only maintainers&apos; and writers&apos; approvals count.</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {headOid ? (
        <p className="mt-2 text-[11px] text-anvil-500 dark:text-anvil-400">
          Verdicts count on the head <Oid value={headOid} chars={7} copyable={false} />, by current members, newest per reviewer.
        </p>
      ) : null}
    </div>
  )
}
