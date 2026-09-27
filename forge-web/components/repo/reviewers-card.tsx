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
import { STANDING_LABEL, type ReviewerCardRow, type Standing } from '@/lib/view/review-fold'
import { isIdentityId } from '@/lib/view/issue-query'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Oid } from '@/components/ui/oid'
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
      return <MinusCircle className={muted} aria-hidden />
    default:
      return <MessageSquare className={muted} aria-hidden />
  }
}

export function ReviewersCard({
  rows,
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
  const [dismissing, setDismissing] = useState<{ id: string; reason: string } | null>(null)
  const [other, setOther] = useState('')
  const listed = new Set(rows.filter((r) => r.requested).map((r) => r.identity))
  // Members first (their approvals count), never the author.
  const candidates = [...members].sort((a, b) => (a.role === b.role ? 0 : a.role === 'maintainer' ? -1 : 1)).filter((m) => m.identity !== author)
  return (
    <div data-testid="reviewers-card">
      {!membersKnown ? <p className="text-anvil-500 dark:text-anvil-400">Couldn&apos;t read the members, so standings are unknown.</p> : null}
      {rows.length === 0 && membersKnown ? <p className="text-anvil-500 dark:text-anvil-400">No reviews yet</p> : null}
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
            {canDismiss && r.reviewId !== null && (r.state === 'approved' || r.state === 'changesRequested') ? (
              dismissing?.id === r.identity ? (
                <div className="ml-5 mt-1 space-y-1">
                  <Input
                    aria-label="Reason for dismissing"
                    value={dismissing.reason}
                    maxLength={120}
                    onChange={(e) => setDismissing({ id: r.identity, reason: e.target.value })}
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
                  onClick={() => setDismissing({ id: r.identity, reason: '' })}
                  className="ml-5 text-[12px] text-anvil-500 underline-offset-2 hover:text-danger-700 hover:underline dark:text-anvil-400 dark:hover:text-danger-400"
                >
                  Dismiss review
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
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
                    onClick={() => onRequest(m.identity, on)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-anvil-100 dark:hover:bg-anvil-850"
                    data-testid="reviewer-option"
                    data-identity={m.identity}
                  >
                    <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden className="accent-forge-600" />
                    <Author identityId={m.identity} link={false} />
                    <span className="text-[11px] text-anvil-500 dark:text-anvil-400">{m.role}</span>
                  </button>
                )
              })}
              <div className="flex gap-1 pt-1">
                <Input aria-label="Request identity id" value={other} onChange={(e) => setOther(e.target.value)} placeholder="identity id" className="h-7 py-0 font-mono text-[12px]" />
                <Button variant="outline" size="sm" disabled={!isIdentityId(other.trim()) || other.trim() === author} onClick={() => onRequest(other.trim(), false)}>
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
