'use client'

/**
 * MilestonesContent — `/repo/milestones` (QW-019): the repo's milestones as GitHub lists them,
 * Open / Closed, each with its due date, description and progress (its issues' and PRs' open
 * and closed counts), and for maintainers and writers New milestone, Edit, Close / Reopen and
 * Delete.
 *
 * Milestones are forge-community `milestone` definitions: member-gated, immutable, newest
 * definition per title wins (`foldMilestonesV2`), and an issue joins one with a member event
 * naming its title. So an edit or a close writes a new definition of the same title, and the
 * title is fixed once defined (a rename would strand every issue in it under the old title). A
 * delete removes the signer's definitions; when another member also defined the title it is
 * refused (their older definition would come back), and closing it is offered instead. A
 * private repository's milestones are sealed, which this build does not do yet (as `dg`).
 */

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CalendarDays, CheckCircle2, Milestone as MilestoneIcon, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { invalidateRepoFeed, issueMilestoneItems, pullMilestoneItems, repoContractIds, repoKey } from '@/lib/repo'
import { MILESTONE_LIMITS, checkMilestoneInput, dayOf, defineMilestone, deleteMilestone, dueOnOf, readMilestoneDefs, type MilestoneDocRef } from '@/lib/repo/milestones'
import { foldMilestonesV2, type Milestone } from '@/lib/rules/parity'
import { previewCreate, previewDelete, type CostPreview as Cost } from '@/lib/sdk'
import { readUntil } from '@/lib/view/retry'
import { invalidateSessionCache } from '@/lib/view/session-cache'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { repoHref, useParam, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { StateTab } from '@/components/repo/list-controls'
import { TriageNav } from '@/components/repo/triage-nav'
import { inputProblem } from '@/lib/utils'

/** What the page shows: the milestones, whether their progress is known, and who defined each title. */
interface MilestonePage {
  readonly milestones: readonly Milestone[]
  /**
   * `known`: the counts are shown. `too-large`: an index's feed was too large to read. `failed`:
   * the issues or PRs could not be read (a retry may do).
   */
  readonly progress: 'known' | 'too-large' | 'failed'
  readonly owners: ReadonlyMap<string, readonly MilestoneDocRef[]>
}

type Pending =
  | { kind: 'define'; title: string; description: string; dueOn: number | null; closed: boolean; verb: 'create' | 'edit' | 'close' | 'reopen' }
  | { kind: 'delete'; title: string }
  | null

const DAY_MS = 86_400_000

/** "Due by October 1, 2026", "Past due by 3 days", or "No due date". */
function dueText(m: Milestone, now: number): { text: string; late: boolean } {
  if (m.dueOn === null) return { text: 'No due date', late: false }
  const day = new Date(m.dueOn).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  // Late once the due day has ended (UTC).
  const late = !m.closed && now >= m.dueOn + DAY_MS
  if (!late) return { text: `Due by ${day}`, late: false }
  const days = Math.max(1, Math.floor((now - m.dueOn) / DAY_MS))
  return { text: `Past due by ${days} ${days === 1 ? 'day' : 'days'} (${day})`, late: true }
}

/** The milestone form: title (fixed when editing), due date, description. */
function MilestoneForm({
  initial,
  editing,
  taken,
  disabledReason,
  onCancel,
  onSubmit,
}: {
  initial: { title: string; description: string; dueOn: number | null }
  editing: boolean
  taken: ReadonlySet<string>
  disabledReason: string | null
  onCancel: () => void
  onSubmit: (v: { title: string; description: string; dueOn: number | null }) => void
}): JSX.Element {
  const [title, setTitle] = useState(initial.title)
  const [due, setDue] = useState(initial.dueOn === null ? '' : dayOf(initial.dueOn))
  const [description, setDescription] = useState(initial.description)
  const trimmed = title.trim()
  const dueOn = due === '' ? null : dueOnOf(due)
  // The schema's own bounds (characters and bytes) first, as `defineMilestone` checks them.
  const problem =
    inputProblem(() => checkMilestoneInput({ title: trimmed, description, dueOn })) ??
    (!editing && taken.has(trimmed) ? 'A milestone with this title exists.' : due !== '' && dueOn === null ? 'The due date is not a day.' : null)
  const unchanged = editing && description === initial.description && dueOn === initial.dueOn
  const id = editing ? 'edit-milestone' : 'new-milestone'
  return (
    <form
      className="space-y-3 rounded-lg border border-anvil-200 bg-anvil-50 p-4 dark:border-anvil-800 dark:bg-anvil-900"
      onSubmit={(e) => {
        e.preventDefault()
        if (problem === null && !unchanged) onSubmit({ title: trimmed, description, dueOn })
      }}
      data-testid={editing ? 'milestone-edit-form' : 'milestone-new-form'}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Title" htmlFor={`${id}-title`}>
          <Input
            id={`${id}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MILESTONE_LIMITS.title}
            disabled={editing}
            title={editing ? 'Issues join a milestone by its title, so a defined milestone keeps its title' : undefined}
            autoFocus={!editing}
            placeholder="v1.0"
          />
        </Field>
        <Field label="Due date (optional)" htmlFor={`${id}-due`}>
          <Input id={`${id}-due`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <Field label="Description (optional)" htmlFor={`${id}-description`}>
        <Textarea id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={MILESTONE_LIMITS.description} className="min-h-[72px]" autoFocus={editing} />
      </Field>
      {problem !== null && (trimmed !== '' || due !== '') ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={problem !== null || unchanged || disabledReason !== null} title={disabledReason ?? undefined}>
          {editing ? 'Save changes' : 'Create milestone'}
        </Button>
      </div>
    </form>
  )
}

export function MilestonesContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer, identity } = useAuth()
  const { role } = useViewerRole(repo)
  const privateRepo = repo.visibility === 'private'
  const canEdit = role !== null && home.config?.archived !== true && !privateRepo
  const [state, setState] = useState<'open' | 'closed'>(useParam('state') === 'closed' ? 'closed' : 'open')
  const [creating, setCreating] = useState(useParam('new') === '1')
  const [editing, setEditing] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const expect = useRef<((p: MilestonePage) => boolean) | null>(null)
  const { data, loading, error, reload } = useAsync<MilestonePage>(
    async () => {
      const read = async (): Promise<MilestonePage> => {
        // One read of the definitions (folded and by signer), beside the issues' and PRs' items.
        const failed = (): 'failed' => 'failed'
        const [issues, pulls, defs] = await Promise.all([
          issueMilestoneItems(sdk!, repo, network).catch(failed),
          pullMilestoneItems(sdk!, repo, network).catch(failed),
          readMilestoneDefs(sdk!, repo),
        ])
        const lists = [issues, pulls]
        const progress = lists.includes('failed') ? 'failed' : lists.includes(null) ? 'too-large' : 'known'
        const items = lists.flatMap((l) => (Array.isArray(l) ? l : []))
        return { milestones: foldMilestonesV2(defs.docs, items), progress, owners: defs.owners }
      }
      const first = await read()
      const want = expect.current
      if (want === null) return first
      expect.current = null
      return (await readUntil(read, [want], { first })) ?? first
    },
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
  const all = useMemo(() => data?.milestones ?? [], [data])
  const open = all.filter((m) => !m.closed)
  const closed = all.filter((m) => m.closed)
  const shown = state === 'open' ? open : closed
  const taken = useMemo(() => new Set(all.map((m) => m.title)), [all])
  const disabledReason = signer === null ? 'Sign in to change milestones' : null
  const now = Date.now()

  const cost: Cost | null =
    pending === null
      ? null
      : pending.kind === 'define'
        ? previewCreate('milestone', { title: pending.title, ...(pending.description ? { description: pending.description } : {}), ...(pending.dueOn !== null ? { dueOn: pending.dueOn } : {}), closed: pending.closed })
        : previewDelete('milestone')

  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const p = pending
    if (p.kind === 'define') {
      await defineMilestone(sdk, signer, repo, { title: p.title, description: p.description, dueOn: p.dueOn, closed: p.closed, intent })
      expect.current = (page) => page.milestones.some((m) => m.title === p.title && m.closed === p.closed && m.description === p.description && m.dueOn === p.dueOn)
      setCreating(false)
      setEditing(null)
      if (p.verb === 'close' || p.verb === 'reopen') setState(p.closed ? 'closed' : 'open')
    } else {
      await deleteMilestone(sdk, signer, repo, p.title)
      expect.current = (page) => !page.milestones.some((m) => m.title === p.title)
    }
    // The lists' milestone filter and the issue pages' picker read them too.
    invalidateSessionCache('milestones:')
    invalidateRepoFeed(repo, { counts: false })
    reload()
  }

  const define = (m: Milestone, verb: 'close' | 'reopen'): void =>
    setPending({ kind: 'define', verb, title: m.title, description: m.description, dueOn: m.dueOn, closed: verb === 'close' })

  const confirm =
    pending === null
      ? { title: '', description: '', label: '' }
      : pending.kind === 'delete'
        ? {
            title: `Delete milestone "${pending.title}"`,
            description: 'Deletes your definitions of it. The issues and pull requests in it keep the milestone in their history.',
            label: 'Sign & delete',
          }
        : {
            title:
              pending.verb === 'create'
                ? `Create milestone "${pending.title}"`
                : pending.verb === 'close'
                  ? `Close milestone "${pending.title}"`
                  : pending.verb === 'reopen'
                    ? `Reopen milestone "${pending.title}"`
                    : `Edit milestone "${pending.title}"`,
            description: 'One milestone definition (maintainers and writers). The newest definition of a title is the one shown.',
            label: pending.verb === 'create' ? 'Sign & create' : pending.verb === 'close' ? 'Sign & close' : pending.verb === 'reopen' ? 'Sign & reopen' : 'Sign & save',
          }

  return (
    <div className="mx-auto max-w-4xl space-y-4" data-testid="milestones-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TriageNav addr={addr} current="milestones" />
        {canEdit ? (
          <Button variant="primary" size="sm" onClick={() => { setCreating(true); setEditing(null) }} disabled={creating}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New milestone
          </Button>
        ) : null}
      </div>
      {privateRepo && role !== null ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="milestones-private-note">
          Milestones in a private repository are sealed, which this build does not do yet, so they can&apos;t be created here or with dg.
        </p>
      ) : null}

      {creating && canEdit ? (
        <MilestoneForm
          initial={{ title: '', description: '', dueOn: null }}
          editing={false}
          taken={taken}
          disabledReason={disabledReason}
          onCancel={() => setCreating(false)}
          onSubmit={(v) => setPending({ kind: 'define', verb: 'create', closed: false, ...v })}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="flex items-center gap-3 border-b border-anvil-200 bg-anvil-50 px-4 py-2 dark:border-anvil-800 dark:bg-anvil-900" role="tablist" aria-label="Milestone state">
          <StateTab active={state === 'open'} onClick={() => setState('open')}>
            <MilestoneIcon className="h-3.5 w-3.5" aria-hidden /> {data === null ? '' : `${open.length} `}Open
          </StateTab>
          <StateTab active={state === 'closed'} onClick={() => setState('closed')}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {data === null ? '' : `${closed.length} `}Closed
          </StateTab>
        </div>
        {loading && data === null ? (
          <LoadingBlock label="Reading milestones" />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={MilestoneIcon}
            title={state === 'open' ? 'No open milestones' : 'No closed milestones'}
            body={state === 'closed' ? 'A closed milestone shows here.' : canEdit ? 'Create one to track a release or a goal.' : 'A maintainer or writer creates milestones.'}
          />
        ) : (
          <ul aria-label="Milestones">
            {shown.map((m) => {
              const due = dueText(m, now)
              const total = m.open + m.closedItems
              const pct = total === 0 ? 0 : Math.round((m.closedItems / total) * 100)
              const defs = data?.owners.get(m.title) ?? []
              const othersDefined = identity !== null && defs.some((d) => d.owner !== identity)
              const q = /\s/.test(m.title) ? `milestone:"${m.title}"` : `milestone:${m.title}`
              return (
                <li key={m.title} className="border-b border-anvil-100 px-4 py-4 last:border-b-0 dark:border-anvil-850" data-testid="milestone-row" data-title={m.title} data-closed={m.closed ? '1' : '0'}>
                  {editing === m.title ? (
                    <MilestoneForm
                      initial={{ title: m.title, description: m.description, dueOn: m.dueOn }}
                      editing
                      taken={taken}
                      disabledReason={disabledReason}
                      onCancel={() => setEditing(null)}
                      onSubmit={(v) => setPending({ kind: 'define', verb: 'edit', closed: m.closed, ...v })}
                    />
                  ) : (
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-6">
                      <div className="min-w-0 flex-1">
                        <Link href={repoHref('/repo/issues', addr, { state: 'all', q })} className="hit-area break-words text-prose font-semibold text-anvil-900 hover:text-forge-700 hover:underline dark:text-anvil-50 dark:hover:text-forge-400">
                          {m.title}
                        </Link>
                        <p className={due.late ? 'mt-1 flex items-center gap-1 text-[12px] text-danger-700 dark:text-danger-400' : 'mt-1 flex items-center gap-1 text-[12px] text-anvil-500 dark:text-anvil-400'}>
                          {due.late ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <CalendarDays className="h-3.5 w-3.5" aria-hidden />} {m.closed ? 'Closed' : due.text}
                        </p>
                        {m.description ? <p className="mt-2 whitespace-pre-line break-words text-dense text-anvil-700 dark:text-anvil-200">{m.description}</p> : null}
                        {/* The counts cover both, so both lists are a click away (the title opens the issues). */}
                        <p className="mt-2 flex flex-wrap gap-x-3 text-[12px]">
                          <Link href={repoHref('/repo/issues', addr, { state: 'all', q })} className="text-anvil-500 hover:text-forge-700 hover:underline dark:text-anvil-400 dark:hover:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center">
                            Issues
                          </Link>
                          <Link href={repoHref('/repo/pulls', addr, { state: 'all', q })} className="text-anvil-500 hover:text-forge-700 hover:underline dark:text-anvil-400 dark:hover:text-forge-400 coarse:inline-flex coarse:min-h-11 coarse:items-center">
                            Pull requests
                          </Link>
                        </p>
                      </div>
                      <div className="w-full shrink-0 md:w-72">
                        {data?.progress === 'known' ? (
                          <>
                            <div className="h-2 overflow-hidden rounded-full bg-anvil-200 dark:bg-anvil-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${m.title} progress`}>
                              <div className="h-full rounded-full bg-verify-700 dark:bg-verify-400" style={{ width: `${pct}%` }} />
                            </div>
                            <p className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-anvil-600 dark:text-anvil-300" data-testid="milestone-progress">
                              <span><strong className="text-anvil-900 dark:text-anvil-50">{pct}%</strong> complete</span>
                              <span><strong className="text-anvil-900 dark:text-anvil-50">{m.open}</strong> open</span>
                              <span><strong className="text-anvil-900 dark:text-anvil-50">{m.closedItems}</strong> closed</span>
                            </p>
                          </>
                        ) : (
                          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
                            {data?.progress === 'failed'
                              ? "Progress unknown: the repo's issues or pull requests could not be read."
                              : "Progress unknown: the repo's event history is too large to read completely."}
                          </p>
                        )}
                        {canEdit ? (
                          <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
                            <button type="button" onClick={() => { setEditing(m.title); setCreating(false) }} className="inline-flex items-center gap-1 text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11" aria-label={`Edit milestone ${m.title}`}>
                              <Pencil className="h-3 w-3" aria-hidden /> Edit
                            </button>
                            <button type="button" onClick={() => define(m, m.closed ? 'reopen' : 'close')} disabled={disabledReason !== null} className="inline-flex items-center gap-1 text-anvil-500 hover:text-forge-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11">
                              {m.closed ? <RotateCcw className="h-3 w-3" aria-hidden /> : <CheckCircle2 className="h-3 w-3" aria-hidden />} {m.closed ? 'Reopen' : 'Close'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPending({ kind: 'delete', title: m.title })}
                              disabled={disabledReason !== null || othersDefined}
                              title={othersDefined ? 'Another member also defined this milestone; only they can delete their definition. Close it instead.' : undefined}
                              className="inline-flex items-center gap-1 text-anvil-500 hover:text-danger-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-danger-400 coarse:min-h-11"
                              aria-label={`Delete milestone ${m.title}`}
                            >
                              <Trash2 className="h-3 w-3" aria-hidden /> Delete
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={confirm.title}
        description={confirm.description}
        cost={cost}
        confirmLabel={confirm.label}
        onConfirm={run}
      />
    </div>
  )
}
