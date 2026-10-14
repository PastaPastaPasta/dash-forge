'use client'

/**
 * The publication date of a coordinated fix (mixed-visibility DESIGN §4.7 "Embargo", D18), in the
 * sidebar of the members-only issue or pull request that tracks it: when it is published, what
 * is published, and the release bot's checklist (make the issue public, publish the branch
 * squashed, tag, release). Members with Write access or more set, move or withdraw the date
 * (`setEmbargo`, one members-only event of kind 28); the release bot (`dg embargo run`) publishes
 * it at that time. Only members read the date: everyone else sees nothing here.
 */

import { useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Author } from '@/components/author'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SidebarSection } from '@/components/repo/target-rail'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { withAddressee } from '@/lib/sdk'
import { composeCost } from '@/components/repo/private-compose'
import { setEmbargo } from '@/lib/repo/review-writes'
import type { RepoRef } from '@/lib/repo/contract'
import { embargoChecklist, embargoDue, encodeEmbargo, type ChecklistItem, type Embargo, type EmbargoFacts, type EmbargoPlan, type EmbargoValue } from '@/lib/rules/embargo'

/** `at` (Unix seconds) as `Tue, 20 Oct 2026, 14:00 UTC`. */
export function whenText(at: number): string {
  return `${new Date(at * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`
}

/** How far `at` is from `now` (both Unix seconds): "in 3 days", "2 hours ago". */
export function untilText(at: number, now: number): string {
  const d = Math.abs(at - now)
  const span = d < 3600 ? Math.max(1, Math.floor(d / 60)) : d < 86_400 ? Math.floor(d / 3600) : Math.floor(d / 86_400)
  const unit = d < 3600 ? 'minute' : d < 86_400 ? 'hour' : 'day'
  const words = `${span} ${unit}${span === 1 ? '' : 's'}`
  return at >= now ? `in ${words}` : `${words} ago`
}

/** One checklist line, as people read it. */
export function stepText(item: ChecklistItem, plan: EmbargoPlan): string {
  switch (item.step) {
    case 'makePublic':
      return `Make #${item.issue} public`
    case 'publish':
      return plan.pr !== undefined
        ? `Publish pull request #${plan.pr}, squashed into one commit`
        : `Publish ${plan.branch ?? 'the branch'} onto ${plan.onto ?? 'its base'}, squashed into one commit`
    case 'tag':
      return `Tag ${item.tag}`
    case 'release':
      return `Release ${item.tag}`
  }
}

/** A `datetime-local` value (read as UTC) in Unix seconds, or null. */
export function utcInputSeconds(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}:00Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** Unix seconds as a `datetime-local` value in UTC. */
function utcInputValue(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 16)
}

/** The form's fields. */
interface Draft {
  at: string
  branch: string
  onto: string
  tag: string
  message: string
}

/** The value the form `d` writes for the thread (`pr`: the pull request it is on), or why not. */
export function draftValue(d: Draft, pr: number | null, now: number): { value: EmbargoValue } | { problem: string } {
  const at = utcInputSeconds(d.at)
  if (at === null) return { problem: 'Choose the date and time (UTC).' }
  if (at <= now) return { problem: 'Choose a time in the future.' }
  const opt = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim())
  const value: EmbargoValue = {
    type: 'schedule',
    at,
    ...(pr !== null ? { pr } : { branch: d.branch.trim(), onto: d.onto.trim() }),
    ...(opt(d.tag) !== undefined ? { tag: opt(d.tag) } : {}),
    ...(opt(d.message) !== undefined ? { message: opt(d.message) } : {}),
  }
  try {
    encodeEmbargo(value)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { problem: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` }
  }
  return { value }
}

export function EmbargoPanel({
  repo,
  target,
  embargo,
  isIssue,
  membersOnly,
  facts,
  canSet,
  open,
  defaultBranch,
  onDone,
}: {
  repo: RepoRef
  /** The issue or pull request the panel is on. */
  target: { readonly id: string; readonly number: number }
  /** Its embargo, as read (null: none; undefined: unknown, the members could not be read). */
  embargo: Embargo | null | undefined
  isIssue: boolean
  /** The thread is members-only: a date can be set on it. */
  membersOnly: boolean
  /** What the page knows of the steps (the issue public, the pull request merged). */
  facts: EmbargoFacts
  /** The viewer has Write access or more and may write here now. */
  canSet: boolean
  /** The thread is open: a new date is offered only then. */
  open: boolean
  /** The repo's default branch: where a branch is published by default. */
  defaultBranch: string
  /** A write landed: read the thread again. */
  onDone: () => void
}): JSX.Element | null {
  const { sdk } = useSdk()
  const { signer } = useAuth()
  const [editing, setEditing] = useState<Draft | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const now = Math.floor(Date.now() / 1000)
  const waiting = embargo !== null && embargo !== undefined && embargo.state.state === 'scheduled'
  // Nothing to show: the members could not be read (whose date counts is unknown), or no date
  // this reader can read and none they may set.
  if (embargo === undefined || (embargo === null && !(membersOnly && canSet && open))) return null
  const pr = isIssue ? null : target.number
  const startEdit = (): void => {
    const p = waiting ? embargo.plan : null
    setEditing({
      at: p !== null ? utcInputValue(p.at) : '',
      branch: p?.branch ?? '',
      onto: p?.onto ?? defaultBranch,
      tag: p?.tag ?? '',
      message: p?.message ?? '',
    })
  }
  const write = async (value: EmbargoValue, intent: string): Promise<void> => {
    if (sdk === null || signer === null) throw new Error('sign in to continue')
    await setEmbargo(sdk, signer, repo, { target, value, intent })
    onDone()
  }
  const draft = editing === null ? null : draftValue(editing, pr, now)
  const cost = (value: EmbargoValue): ReturnType<typeof composeCost> =>
    withAddressee(composeCost(repo, 'event', { value: encodeEmbargo(value) }, {}, 'members'))
  const items = embargo === null ? [] : embargoChecklist(embargo, isIssue, facts)
  return (
    <SidebarSection title="Publication" icon={CalendarClock}>
      <div className="space-y-2" data-testid="embargo-panel">
        {embargo === null ? (
          <p className="text-anvil-600 dark:text-anvil-300" data-testid="embargo-state">
            No publication date.
          </p>
        ) : embargo.state.state === 'cancelled' ? (
          <p className="text-anvil-600 dark:text-anvil-300" data-testid="embargo-state">
            No publication date. <Author identityId={embargo.state.by} /> withdrew the one for {whenText(embargo.plan.at)}.
          </p>
        ) : embargo.state.state === 'done' ? (
          <p className="text-anvil-700 dark:text-anvil-200" data-testid="embargo-state">
            Published as <code className="font-mono text-[12px]">{embargo.state.commit.slice(0, 7)}</code> (planned for {whenText(embargo.plan.at)}).
          </p>
        ) : (
          <p className="text-anvil-700 dark:text-anvil-200" data-testid="embargo-state">
            {embargoDue(embargo, now) ? 'Due since' : 'Publishes on'} <strong>{whenText(embargo.plan.at)}</strong> ({untilText(embargo.plan.at, now)}).
          </p>
        )}
        {embargo !== null && embargo.state.state !== 'cancelled' ? (
          <>
            <ol className="space-y-0.5" data-testid="embargo-checklist">
              {items.map((it, i) => (
                <li key={i} className="flex gap-1.5 text-[12px] text-anvil-600 dark:text-anvil-300">
                  <span aria-hidden className={it.done ? 'text-forge-700 dark:text-forge-400' : 'text-anvil-500 dark:text-anvil-400'}>{it.done ? '✓' : '○'}</span>
                  <span>
                    <span className="sr-only">{it.done ? 'Done: ' : 'To do: '}</span>
                    {stepText(it, embargo.plan)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
              Set by <Author identityId={embargo.setBy} />. Only members can see this date.
              {waiting ? (
                <>
                  {' '}A release bot publishes it then: <code className="font-mono">dg embargo run --wait</code>.
                </>
              ) : null}
            </p>
          </>
        ) : null}
        {canSet && embargo?.state.state !== 'done' && ((membersOnly && open) || waiting) ? (
          <div className="flex flex-wrap gap-2">
            {membersOnly && open ? (
              <Button size="sm" variant="outline" onClick={startEdit} data-testid="embargo-set">
                {waiting ? 'Change date' : 'Set a date…'}
              </Button>
            ) : null}
            {/* a date stays withdrawable once the thread is public (the release bot stopped part way) */}
            {waiting ? (
              <Button size="sm" variant="outline" onClick={() => setWithdrawing(true)} data-testid="embargo-withdraw">
                Withdraw
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={waiting ? 'Change the publication date?' : 'Set a publication date?'}
        description="Only members can see the date and what is published. At that time a release bot makes the issue public, publishes the code squashed into one commit, then tags and releases it. Nothing is published before then."
        cost={draft !== null && 'value' in draft ? cost(draft.value) : 'pending'}
        confirmLabel={waiting ? 'Change date' : 'Set date'}
        {...(signer === null ? { blocked: 'Sign in to set a publication date.' } : draft !== null && 'problem' in draft && editing?.at !== '' ? { blocked: draft.problem } : {})}
        onConfirm={async (intent) => {
          if (draft === null || !('value' in draft)) throw new Error('the form is incomplete')
          await write(draft.value, intent)
          setEditing(null)
        }}
        successNote="Date set"
      >
        {editing !== null ? (
          <div className="space-y-2 text-dense">
            <label className="block">
              <span className="text-[12px] font-medium">Publish on (UTC)</span>
              <Input type="datetime-local" value={editing.at} onChange={(e) => setEditing({ ...editing, at: e.target.value })} data-testid="embargo-at" />
            </label>
            {pr === null ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[12px] font-medium">Members-only branch</span>
                  <Input value={editing.branch} onChange={(e) => setEditing({ ...editing, branch: e.target.value })} placeholder="sec/fix" data-testid="embargo-branch" />
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium">Onto</span>
                  <Input value={editing.onto} onChange={(e) => setEditing({ ...editing, onto: e.target.value })} data-testid="embargo-onto" />
                </label>
              </div>
            ) : (
              <p className="text-[12px] text-anvil-600 dark:text-anvil-300">Publishes this pull request&apos;s branch onto its base and records it merged.</p>
            )}
            <label className="block">
              <span className="text-[12px] font-medium">Tag and release (optional)</span>
              <Input value={editing.tag} onChange={(e) => setEditing({ ...editing, tag: e.target.value })} placeholder="v1.2.3" data-testid="embargo-tag" />
            </label>
            <label className="block">
              <span className="text-[12px] font-medium">Commit message (optional)</span>
              <Input value={editing.message} onChange={(e) => setEditing({ ...editing, message: e.target.value })} placeholder="The branch's commit subjects" data-testid="embargo-message" />
            </label>
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        title="Withdraw the publication date?"
        description={waiting ? `Nothing is published on ${whenText(embargo.plan.at)}. Members see that you withdrew it.` : ''}
        cost={cost({ type: 'cancel' })}
        confirmLabel="Withdraw"
        {...(signer === null ? { blocked: 'Sign in to withdraw the date.' } : {})}
        onConfirm={async (intent) => {
          await write({ type: 'cancel' }, intent)
          setWithdrawing(false)
        }}
        successNote="Withdrawn"
      />
    </SidebarSection>
  )
}
