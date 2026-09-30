'use client'

/**
 * Approvals — the forge-v2 approval fold, shown exactly (`countApprovals`, `forge-v2.md` §6,
 * ux-dx-spec §5.7). The headline says what counts on the current head ("Approved by 2
 * maintainers on 8f3e2a1", "Changes requested by bob"); every reviewer is listed with their
 * standing, including the ones that do not count and why: a verdict on an older head is
 * "stale — new commits since", a reviewer who is not a maintainer or writer "doesn't count",
 * and the PR author's own verdict is "author, not counted" (GitHub: authors can't approve their
 * own PR).
 *
 * Its first line is the GitHub-style count ({@link VerdictLine}: "2 of 3 required approvals",
 * "Changes requested"), the fold's, with the proved on-chain count (RC1 R-16) beside it where
 * the two differ. The fold is what gates a merge; the proved count never does.
 */

import { Check, CircleDot, Clock, MinusCircle, ShieldCheck, X, type LucideIcon } from 'lucide-react'
import { verdictSummary, type PullApprovals, type VerdictSummary } from '@/lib/view'
import type { ProvedVerdicts } from '@/lib/repo/verdicts'
import { approverPhrase, type ReviewerRow } from '@/lib/view/review-fold'
import { Author } from '@/components/author'
import { Oid } from '@/components/ui/oid'
import { cn } from '@/lib/utils'

export function Approvals({ approvals, headOid, proved }: { approvals: PullApprovals; headOid: string; proved: ProvedVerdicts | null }): JSX.Element {
  const { summary } = approvals
  const approved = approverPhrase(summary.approvedBy)
  return (
    <section aria-label="Approvals" data-testid="review-fold" className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800">
      <VerdictLine approvals={approvals} proved={proved} headOid={headOid} />
      <div className="mt-2 space-y-1 border-t border-anvil-100 pt-2 dark:border-anvil-850">
        {approved !== '' ? (
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-anvil-900 dark:text-anvil-50" data-testid="fold-approved">
            <Check className="h-4 w-4 text-verify-700 dark:text-verify-400" aria-hidden />
            Approved by {approved} on {headOid ? <Oid value={headOid} chars={7} copyable={false} /> : 'this head'}
          </p>
        ) : null}
        {summary.changesRequestedBy.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-anvil-900 dark:text-anvil-50" data-testid="fold-changes">
            <X className="h-4 w-4 text-danger-700 dark:text-danger-400" aria-hidden />
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

/**
 * The merge box's review count ("2 approvals", "1 of 2 required approvals", "Changes requested"),
 * from the fold, with the proved count where it differs or stands in for an unread fold
 * (`verdictSummary`). Renders nothing when neither is known.
 */
const TONE: Record<VerdictSummary['tone'], { readonly icon: LucideIcon; readonly className: string }> = {
  approved: { icon: Check, className: 'text-verify-700 dark:text-verify-400' },
  changes: { icon: X, className: 'text-danger-700 dark:text-danger-400' },
  required: { icon: CircleDot, className: 'text-caution-700 dark:text-caution-400' },
  none: { icon: CircleDot, className: 'text-anvil-500 dark:text-anvil-400' },
}

export function VerdictLine({ approvals, proved, headOid }: { approvals: PullApprovals | null; proved: ProvedVerdicts | null; headOid: string }): JSX.Element | null {
  const line = verdictSummary(approvals, proved, headOid)
  if (line === null) return null
  const { icon: Icon, className } = TONE[line.tone]
  return (
    <div data-testid="merge-verdicts" data-tone={line.tone} data-proved-approvals={proved?.approvals} data-proved-changes={proved?.changesRequested}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden />
        <span className="font-semibold text-anvil-900 dark:text-anvil-50" data-testid="merge-verdicts-headline">
          {line.headline}
        </span>
        {line.detail !== null ? <span className="text-anvil-600 dark:text-anvil-300">{line.detail}</span> : null}
        {line.proved ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400" title="Consensus proves these reviewers were members when they reviewed" data-testid="merge-verdicts-proved">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> proved on chain
          </span>
        ) : null}
      </p>
      {line.onChain !== null ? (
        <p className="mt-0.5 pl-6 text-[12px] text-anvil-600 dark:text-anvil-400" data-testid="merge-verdicts-on-chain">
          {line.onChain}
        </p>
      ) : null}
    </div>
  )
}

function Row({ row }: { row: ReviewerRow }): JSX.Element {
  const s = row.standing
  const counted = s.kind === 'approved' || s.kind === 'changes'
  const verdict = s.kind === 'approved' || (s.kind !== 'changes' && s.verdict === 'approve') ? 'approved' : 'requested changes'
  return (
    <li className={cn('flex flex-wrap items-center gap-2', !counted && 'text-anvil-600 dark:text-anvil-400')}>
      {s.kind === 'approved' ? (
        <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden />
      ) : s.kind === 'changes' ? (
        <X className="h-3.5 w-3.5 text-danger-700 dark:text-danger-400" aria-hidden />
      ) : s.kind === 'stale' ? (
        <Clock className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
      ) : (
        <MinusCircle className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden />
      )}
      <Author identityId={row.reviewer} link={false} />
      <span>
        {verdict}
        {counted ? ` · ${s.role}` : ''}
      </span>
      {s.kind === 'author' ? <Tag>author, not counted</Tag> : null}
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
