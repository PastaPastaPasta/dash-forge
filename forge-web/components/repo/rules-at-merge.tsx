'use client'

/**
 * "Branch rules at merge" on a merged PR: which branch rules applied when it was merged and
 * whether the merge met them (`lib/rules/merge-audit.ts`). Closed by default: nothing is read
 * until the reader opens it, so the PR page's request budget holds.
 */

import { useState } from 'react'
import { AlertTriangle, Check, ChevronRight, Info, ShieldAlert, X } from 'lucide-react'

import { Author } from '@/components/author'
import { Time } from '@/components/repo/byline'
import { EnforcedBy } from '@/components/ui/enforced-by'
import { useAsync } from '@/hooks/use-async'
import type { EvoSDK } from '@dashevo/evo-sdk'
import type { MergeAudit } from '@/lib/rules/merge-audit'
import type { ConfigDoc } from '@/lib/rules/types'
import type { RepoRef } from '@/lib/repo'
import type { HeadChecks } from '@/lib/repo/checks'
import type { PullThread } from '@/lib/view'
import { UNMET_CAVEAT, auditHeadline, auditRows, auditedMerge, mergerRoleWords, readMergeAudit, uncountedBypassWhy } from '@/lib/view/merge-audit'
import { cn } from '@/lib/utils'

export function RulesAtMerge({
  sdk,
  repo,
  thread,
  configHistory,
  pageChecks,
}: {
  sdk: EvoSDK | null
  repo: RepoRef
  thread: PullThread
  configHistory: () => Promise<readonly ConfigDoc[]>
  /** The runs the page read on the PR head (reused when it is the merged head), or null. */
  pageChecks: HeadChecks | null
}): JSX.Element {
  const [opened, setOpened] = useState(false)
  const audit = useAsync<MergeAudit | null>(
    () => readMergeAudit(sdk!, repo, thread, configHistory, pageChecks),
    [opened, thread.pull.mergeOid ?? '', thread.members.length, thread.reviews.length],
    { enabled: opened && sdk !== null },
  )
  return (
    <details
      className="group rounded-lg border border-anvil-200 text-dense dark:border-anvil-800"
      data-testid="rules-at-merge"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true)
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 font-medium hover:bg-anvil-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-forge-500 dark:hover:bg-anvil-900 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-anvil-500 transition-transform group-open:rotate-90" aria-hidden />
        Branch rules at merge
      </summary>
      <div className="border-t border-anvil-200 px-4 py-3 dark:border-anvil-800">
        {!audit.settled ? (
          <p className="text-anvil-500 dark:text-anvil-400">Reading the branch rules in force when this was merged…</p>
        ) : audit.error ? (
          <p className="text-danger-700 dark:text-danger-400" role="alert">
            {`Couldn't read the branch rules: ${audit.error}`}
          </p>
        ) : audit.data === null ? (
          <p className="text-anvil-500 dark:text-anvil-400">This merge records no commit, so there is nothing to check.</p>
        ) : (
          <AuditBody audit={audit.data} thread={thread} />
        )}
      </div>
    </details>
  )
}

function AuditBody({ audit, thread }: { audit: MergeAudit; thread: PullThread }): JSX.Element {
  const rows = auditRows(audit, thread.pull.mergeBaseRefName)
  const tone = audit.verdict === 'unmet' ? 'bad' : audit.verdict === 'met' ? 'good' : 'neutral'
  return (
    <div className="space-y-3" data-testid="rules-at-merge-body" data-verdict={audit.verdict}>
      <p className={cn('flex items-start gap-2 font-medium', tone === 'bad' && 'text-danger-700 dark:text-danger-400')}>
        {tone === 'good' ? (
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-verify" aria-hidden />
        ) : tone === 'bad' ? (
          <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : audit.verdict === 'bypassed' ? (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-forge-700 dark:text-forge-400" aria-hidden />
        ) : (
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
        )}
        <span>{auditHeadline(audit)}</span>
      </p>
      {audit.bypass !== null ? (
        <p className="text-anvil-600 dark:text-anvil-300" data-testid="rules-at-merge-bypass">
          <Author identityId={audit.bypass.actor} /> recorded the bypass <Time ms={audit.bypass.createdAt} />
          {audit.bypass.value ? `: ${audit.bypass.value}.` : '.'}
        </p>
      ) : audit.uncountedBypass !== null ? (
        <p className="text-anvil-600 dark:text-anvil-300" data-testid="rules-at-merge-uncounted-bypass">
          <Author identityId={audit.uncountedBypass.event.actor} /> recorded a bypass <Time ms={audit.uncountedBypass.event.createdAt} />
          {audit.uncountedBypass.event.value ? `: ${audit.uncountedBypass.event.value}.` : '.'} {uncountedBypassWhy(audit.uncountedBypass)}
        </p>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <dt className="text-anvil-500 dark:text-anvil-400">Merged by</dt>
        <dd className="min-w-0 break-words">
          <MergerLine thread={thread} audit={audit} />
        </dd>
        {rows.map((r) => (
          <Row key={r.key} label={r.label} text={r.text} met={r.met} />
        ))}
      </dl>
      {audit.rulesChanged ? (
        <p className="flex items-start gap-2 text-forge-800 dark:text-forge-300" data-testid="rules-at-merge-changed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          The branch rules changed less than an hour before this merge.
        </p>
      ) : null}
      {audit.verdict === 'unmet' ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{UNMET_CAVEAT}</p> : null}
      <EnforcedBy by="apps" />
    </div>
  )
}

function MergerLine({ thread, audit }: { thread: PullThread; audit: MergeAudit }): JSX.Element {
  const actor = auditedMerge(thread)?.merger ?? ''
  return (
    <>
      {actor !== '' ? <Author identityId={actor} /> : 'Unknown'}
      {mergerRoleWords(audit)}
      {thread.pull.mergedAt !== undefined ? (
        <>
          {' · '}
          <Time ms={thread.pull.mergedAt} />
        </>
      ) : null}
    </>
  )
}

function Row({ label, text, met }: { label: string; text: string; met: boolean | null }): JSX.Element {
  return (
    <>
      <dt className="text-anvil-500 dark:text-anvil-400">{label}</dt>
      <dd className={cn('flex min-w-0 items-start gap-1.5 break-words', met === false && 'text-danger-700 dark:text-danger-400')}>
        {met === true ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verify" aria-hidden /> : met === false ? <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {met === null ? null : <span className="sr-only">{met ? 'Met: ' : 'Not met: '}</span>}
        <span>{text}</span>
      </dd>
    </>
  )
}
