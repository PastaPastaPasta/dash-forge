'use client'

/**
 * Approvals — the forge-v2 approval fold, shown exactly (`countApprovals`, `forge-v2.md` §6,
 * ux-dx-spec §5.7). The headline says what counts on the current head ("Approved by 2
 * maintainers on 8f3e2a1", "Changes requested by bob"); every reviewer is listed with their
 * standing, including the ones that do not count and why: a verdict on an older head is
 * "stale — new commits since", a reviewer who is not a maintainer or writer "doesn't count",
 * and a member approving their own PR is an "author approval (counted)".
 */

import { Check, Clock, MinusCircle, X } from 'lucide-react'
import type { PullApprovals } from '@/lib/view'
import { approverPhrase, type ReviewerRow } from '@/lib/view/review-fold'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { cn } from '@/lib/utils'

export function Approvals({ approvals, headOid }: { approvals: PullApprovals; headOid: string }): JSX.Element {
  const { summary } = approvals
  const approved = approverPhrase(summary.approvedBy)
  return (
    <section aria-label="Approvals" data-testid="review-fold" className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800">
      <div className="space-y-1">
        {approved !== '' ? (
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-anvil-900 dark:text-anvil-50" data-testid="fold-approved">
            <Check className="h-4 w-4 text-verify" aria-hidden />
            Approved by {approved} on {headOid ? <Oid value={headOid} chars={7} copyable={false} /> : 'this head'}
          </p>
        ) : null}
        {summary.changesRequestedBy.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-anvil-900 dark:text-anvil-50" data-testid="fold-changes">
            <X className="h-4 w-4 text-danger" aria-hidden />
            Changes requested by{' '}
            {summary.changesRequestedBy.map((id, i) => (
              <span key={id} className="inline-flex items-center gap-1">
                {i > 0 ? ', ' : ''}
                <Author identityId={id} link={false} />
              </span>
            ))}
          </p>
        ) : null}
        {approved === '' && summary.changesRequestedBy.length === 0 ? (
          <p className="text-anvil-600 dark:text-anvil-300">
            No maintainer or writer has approved or requested changes on{' '}
            {headOid ? <Oid value={headOid} chars={7} copyable={false} /> : 'this head'} yet.
          </p>
        ) : null}
      </div>
      {summary.rows.length > 0 ? (
        <ul className="mt-2 space-y-1.5 border-t border-anvil-100 pt-2 dark:border-anvil-850">
          {summary.rows.map((row) => (
            <Row key={row.reviewer} row={row} />
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-[12px] text-anvil-600 dark:text-anvil-400">
        Counted by the client rule every Forge client applies: reviews on this head by current maintainers and writers, newest
        verdict per reviewer. Nothing at consensus requires them.
      </p>
    </section>
  )
}

function Row({ row }: { row: ReviewerRow }): JSX.Element {
  const s = row.standing
  const counted = s.kind === 'approved' || s.kind === 'changes'
  const verdict = s.kind === 'approved' || (s.kind !== 'changes' && s.verdict === 'approve') ? 'approved' : 'requested changes'
  return (
    <li className={cn('flex flex-wrap items-center gap-2', !counted && 'text-anvil-600 dark:text-anvil-400')}>
      {s.kind === 'approved' ? (
        <Check className="h-3.5 w-3.5 text-verify" aria-hidden />
      ) : s.kind === 'changes' ? (
        <X className="h-3.5 w-3.5 text-danger" aria-hidden />
      ) : s.kind === 'stale' ? (
        <Clock className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
      ) : (
        <MinusCircle className="h-3.5 w-3.5 text-anvil-400" aria-hidden />
      )}
      <Author identityId={row.reviewer} link={false} />
      <span>
        {verdict}
        {counted ? ` · ${s.role}` : ''}
      </span>
      {s.kind === 'approved' && s.self ? <Tag>author approval (counted)</Tag> : null}
      {s.kind === 'stale' ? (
        <Tag>
          stale — new commits since <Oid value={s.commitOid} chars={7} copyable={false} />
        </Tag>
      ) : null}
      {s.kind === 'not-member' ? <Tag>doesn&apos;t count (not a maintainer or writer)</Tag> : null}
    </li>
  )
}

function Tag({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-anvil-100 px-2 py-0.5 text-[11px] text-anvil-700 dark:bg-anvil-800 dark:text-anvil-300">
      {children}
    </span>
  )
}
