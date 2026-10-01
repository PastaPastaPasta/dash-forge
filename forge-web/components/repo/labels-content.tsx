'use client'

/**
 * LabelsContent — `/repo/labels` (QW-019): the repo's labels as GitHub's Labels page lists them,
 * with New label, Edit (colour and description) and Delete for maintainers and writers.
 *
 * Labels are forge-core `label` definitions: member-gated, immutable, newest definition per name
 * wins (`lib/repo/labels`). So an edit writes a new definition of the same name; a rename would
 * leave every issue carrying the old name (a label on an issue is an event naming it), so the name
 * is fixed once defined. A delete removes the signer's definitions and, when another member also
 * defined the name, writes a retirement first (`deleteLabel`, parity with `dg label delete`); a
 * retired label is listed apart and can be restored. Labels already on issues stay in their
 * history either way.
 */

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Pencil, Plus, RefreshCw, RotateCcw, Tag, Trash2 } from 'lucide-react'
import type { RepoHome } from '@/lib/view'
import { checkLabelInput, deleteLabel, defineLabel, invalidateRepoFeed, LABEL_COLORS, LABEL_LIMITS, planLabelDelete, readLabelDocs, readLabels, repoContractIds, repoKey, type LabelDef } from '@/lib/repo'
import { previewCreate, previewDelete, sumPreviews, type CostPreview as Cost } from '@/lib/sdk'
import { readUntil } from '@/lib/view/retry'
import { useSdk } from '@/hooks/use-sdk'
import { useAsync } from '@/hooks/use-async'
import { useAuth } from '@/contexts/auth-context'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { capabilitiesOf } from '@/lib/rules/roles'
import { RoleLimitNote } from '@/components/repo/role-limit-note'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states'
import { LabelChip } from '@/components/repo/issue-bits'
import { TriageNav } from '@/components/repo/triage-nav'
import { cn, inputProblem } from '@/lib/utils'

const HEX = /^#[0-9a-fA-F]{6}$/

/** A write the confirm dialog is about to sign. */
type Pending =
  | { kind: 'define'; name: string; color: string; description: string; verb: 'create' | 'edit' | 'restore' }
  /** `retire`: a retirement is written first (null: the definitions could not be read to tell); `deletes`: the signer's definitions removed. */
  | { kind: 'delete'; name: string; retire: boolean | null; deletes: number }
  | null

/** A random colour from GitHub's palette (the New label form's refresh). */
function randomColor(not: string): string {
  const choices = LABEL_COLORS.filter((c) => c !== not)
  return choices[Math.floor(Math.random() * choices.length)] ?? '#1d76db'
}

/**
 * The label form: name (fixed once defined), description, colour with a preview. `mode`:
 * `create` a new name, `edit` a live label, `restore` a retired one (its colour and description
 * went with the retirement, so they are chosen afresh).
 */
function LabelForm({
  initial,
  mode,
  taken,
  onCancel,
  onSubmit,
  disabledReason,
}: {
  initial: { name: string; color: string; description: string }
  mode: 'create' | 'edit' | 'restore'
  /** Every defined name, lower-cased, to whether it is retired. */
  taken: ReadonlyMap<string, boolean>
  onCancel: () => void
  onSubmit: (v: { name: string; color: string; description: string }) => void
  disabledReason: string | null
}): JSX.Element {
  const editing = mode !== 'create'
  const [name, setName] = useState(initial.name)
  const [color, setColor] = useState(initial.color)
  const [description, setDescription] = useState(initial.description)
  const trimmed = name.trim()
  const clash = editing ? undefined : taken.get(trimmed.toLowerCase())
  // The schema's own bounds (characters and bytes) first, as `defineLabel` checks them. A name
  // differing only in case is refused, as the issue page's picker refuses it.
  const problem =
    inputProblem(() => checkLabelInput({ name: trimmed, description })) ??
    (clash === true
      ? 'A retired label has this name: restore it below.'
      : clash === false
        ? 'A label with this name exists.'
        : color !== '' && !HEX.test(color)
          ? 'A colour looks like #1f883d.'
          : null)
  const unchanged = mode === 'edit' && color.toLowerCase() === initial.color.toLowerCase() && description === initial.description
  const id = editing ? `label-${initial.name.replace(/\s+/g, '-')}` : 'new-label'
  return (
    <form
      className="space-y-3 rounded-lg border border-anvil-200 bg-anvil-50 p-4 dark:border-anvil-800 dark:bg-anvil-900"
      onSubmit={(e) => {
        e.preventDefault()
        if (problem === null && !unchanged) onSubmit({ name: trimmed, color: color.toLowerCase(), description })
      }}
      data-testid={mode === 'create' ? 'label-new-form' : mode === 'edit' ? 'label-edit-form' : 'label-restore-form'}
    >
      <div>
        <LabelChip name={trimmed || 'Label preview'} def={{ name: trimmed, color: HEX.test(color) ? color.toLowerCase() : '', description, retired: false, createdAt: 0, id: '' }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <Field label="Label name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LABEL_LIMITS.name}
            disabled={editing}
            title={editing ? 'Issues carry a label by its name, so a defined label keeps its name' : undefined}
            autoFocus={!editing}
          />
        </Field>
        <Field label="Description" htmlFor={`${id}-description`}>
          <Input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={LABEL_LIMITS.description} placeholder="Description (optional)" autoFocus={editing} />
        </Field>
        <Field label="Color" htmlFor={`${id}-color`}>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setColor(randomColor(color))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-anvil-300 dark:border-anvil-700 coarse:h-11 coarse:w-11"
              style={HEX.test(color) ? { backgroundColor: color } : undefined}
              aria-label="Pick a random colour"
              title="Pick a random colour"
            >
              <RefreshCw className="h-3.5 w-3.5 text-white mix-blend-difference" aria-hidden />
            </button>
            <Input id={`${id}-color`} value={color} onChange={(e) => setColor(e.target.value.trim())} maxLength={7} className="w-28 font-mono" placeholder="#1d76db" />
          </span>
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color.toLowerCase() === c}
            aria-label={c}
            onClick={() => setColor(c)}
            className={cn('h-6 w-6 rounded-full border coarse:h-9 coarse:w-9', color.toLowerCase() === c ? 'border-anvil-900 ring-2 ring-forge-500 dark:border-white' : 'border-transparent')}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      {problem !== null && trimmed !== '' ? <p className="text-[12px] text-danger-700 dark:text-danger-400">{problem}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={problem !== null || unchanged || disabledReason !== null} title={disabledReason ?? undefined}>
          {mode === 'create' ? 'Create label' : mode === 'edit' ? 'Save changes' : 'Restore label'}
        </Button>
      </div>
    </form>
  )
}

export function LabelsContent({ home, addr }: { home: RepoHome; addr: RepoAddress }): JSX.Element {
  const repo = home.repo
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const { role } = useViewerRole(repo)
  // Writers and triage define labels (consensus: `label` r 1..2); a reader cannot.
  const canEdit = capabilitiesOf(role).canLabel && home.config?.archived !== true
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  /** The label whose delete is being planned (its definitions read, to price it). */
  const [planning, setPlanning] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // After a write the page re-reads until the write shows (a node a block behind answers without it).
  const expect = useRef<((l: LabelDef[]) => boolean) | null>(null)
  const { data, loading, error, reload } = useAsync<LabelDef[]>(
    async () => {
      const read = (): Promise<LabelDef[]> => readLabels(sdk!, repo)
      const first = await read()
      const want = expect.current
      if (want === null) return first
      expect.current = null
      return (await readUntil(read, [want], { first })) ?? first
    },
    [ready, repoKey(repo), network],
    { enabled: ready && sdk !== null },
  )
  const labels = useMemo(() => data ?? [], [data])
  const live = labels.filter((l) => !l.retired)
  const retired = labels.filter((l) => l.retired)
  const q = filter.trim().toLowerCase()
  const shown = q === '' ? live : live.filter((l) => l.name.toLowerCase().includes(q) || l.description.toLowerCase().includes(q))
  const taken = useMemo(() => new Map(labels.map((l) => [l.name.toLowerCase(), l.retired])), [labels])
  const disabledReason = signer === null ? 'Sign in to change labels' : null

  // A delete is priced as it will run: a retirement (a charge) when another member also defined
  // the name, then one refund per definition of the signer's.
  const cost: Cost | null =
    pending === null
      ? null
      : pending.kind === 'define'
        ? previewCreate('label', { name: pending.name, color: pending.color, description: pending.description })
        : sumPreviews([
            ...(pending.retire !== false ? [previewCreate('label', { name: pending.name, retired: true })] : []),
            ...Array.from({ length: pending.deletes }, () => previewDelete('label')),
          ])

  const askDelete = async (name: string): Promise<void> => {
    if (!sdk || !signer) return
    setPlanning(name)
    try {
      const plan = planLabelDelete(await readLabelDocs(sdk, repo, name), signer.identityId)
      setPending({ kind: 'delete', name, retire: plan.retire, deletes: plan.mine.length })
    } catch {
      setPending({ kind: 'delete', name, retire: null, deletes: 1 })
    } finally {
      setPlanning(null)
    }
  }

  const run = async (intent: string): Promise<void> => {
    if (!sdk || !signer || pending === null) throw new Error('sign in to continue')
    const p = pending
    if (p.kind === 'define') {
      await defineLabel(sdk, signer, repo, { name: p.name, color: p.color, description: p.description, intent })
      expect.current = (l) => l.some((d) => d.name === p.name && !d.retired && d.color === p.color && d.description === p.description)
      setCreating(false)
      setEditing(null)
      setRestoring(null)
    } else {
      await deleteLabel(sdk, signer, repo, p.name, intent)
      expect.current = (l) => !l.some((d) => d.name === p.name && !d.retired)
    }
    // The lists' labels (and the issue pages') come from the repo feed: drop it.
    invalidateRepoFeed(repo, { counts: false })
    reload()
  }

  const confirm =
    pending === null
      ? { title: '', description: '', label: '' }
      : pending.kind === 'delete'
        ? {
            title: `Delete label "${pending.name}"`,
            description: `${
              pending.retire === true
                ? 'Another member also defined it, so a retirement is written first (no one is offered it any more), then your definitions of it are deleted.'
                : pending.retire === false
                  ? 'Deletes your definitions of it.'
                  : 'Deletes your definitions of it. If another member also defined it, a retirement is written first, so no one is offered it any more.'
            } Issues and pull requests that carry it keep it in their history.`,
            label: 'Sign & delete',
          }
        : {
            title: pending.verb === 'create' ? `Create label "${pending.name}"` : pending.verb === 'restore' ? `Restore label "${pending.name}"` : `Edit label "${pending.name}"`,
            description: 'One label definition for the whole repo (maintainers and writers). The newest definition of a name is the one shown.',
            label: pending.verb === 'create' ? 'Sign & create' : pending.verb === 'restore' ? 'Sign & restore' : 'Sign & save',
          }

  return (
    <div className="mx-auto max-w-4xl space-y-4" data-testid="labels-page">
      <div className="flex flex-wrap items-center gap-3">
        <TriageNav addr={addr} current="labels" />
        <label htmlFor="label-search" className="sr-only">Search all labels</label>
        <Input id="label-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search all labels" className="min-w-[10rem] flex-1" />
        {canEdit ? (
          <Button variant="primary" size="sm" onClick={() => { setCreating(true); setEditing(null); setRestoring(null) }} disabled={creating}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New label
          </Button>
        ) : null}
      </div>
      {home.config?.archived !== true ? <RoleLimitNote role={role} what="create or edit labels" /> : null}

      {creating ? (
        <LabelForm
          initial={{ name: '', color: randomColor(''), description: '' }}
          mode="create"
          taken={taken}
          disabledReason={disabledReason}
          onCancel={() => setCreating(false)}
          onSubmit={(v) => setPending({ kind: 'define', verb: 'create', ...v })}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-anvil-200 dark:border-anvil-800">
        <div className="border-b border-anvil-200 bg-anvil-50 px-4 py-2.5 text-dense font-medium text-anvil-700 dark:border-anvil-800 dark:bg-anvil-900 dark:text-anvil-200">
          {data === null ? 'Labels' : `${live.length} ${live.length === 1 ? 'label' : 'labels'}`}
        </div>
        {loading && data === null ? (
          <LoadingBlock label="Reading labels" />
        ) : error ? (
          <div className="p-4"><ErrorState message={error} onRetry={reload} /></div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Tag}
            title={q !== '' ? 'No labels match' : 'No labels yet'}
            body={q !== '' ? 'Try another search.' : canEdit ? 'Create one to sort issues and pull requests.' : 'A maintainer, writer or triage member creates labels.'}
          />
        ) : (
          <ul aria-label="Labels">
            {shown.map((l) => (
              <li key={l.name} className="border-b border-anvil-100 px-4 py-3 last:border-b-0 dark:border-anvil-850" data-testid="label-row" data-label={l.name}>
                {editing === l.name ? (
                  <LabelForm
                    initial={{ name: l.name, color: l.color, description: l.description }}
                    mode="edit"
                    taken={taken}
                    disabledReason={disabledReason}
                    onCancel={() => setEditing(null)}
                    onSubmit={(v) => setPending({ kind: 'define', verb: 'edit', ...v })}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="w-full sm:w-48 sm:shrink-0">
                      <LabelChip name={l.name} def={l} />
                    </div>
                    <p className="min-w-0 flex-1 break-words text-dense text-anvil-600 dark:text-anvil-300">{l.description || <span className="italic text-anvil-500 dark:text-anvil-400">No description</span>}</p>
                    <span className="flex items-center gap-3 text-[12px]">
                      <Link href={repoHref('/repo/issues', addr, { label: l.name, state: 'all' })} className="text-anvil-500 hover:text-forge-700 hover:underline dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:min-w-11 coarse:inline-flex coarse:items-center coarse:justify-center">
                        Issues
                      </Link>
                      <Link href={repoHref('/repo/pulls', addr, { label: l.name, state: 'all' })} className="text-anvil-500 hover:text-forge-700 hover:underline dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:min-w-11 coarse:inline-flex coarse:items-center coarse:justify-center">
                        Pull requests
                      </Link>
                      {canEdit ? (
                        <>
                          <button type="button" onClick={() => { setEditing(l.name); setCreating(false); setRestoring(null) }} className="inline-flex items-center gap-1 text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:min-w-11 coarse:justify-center" aria-label={`Edit label ${l.name}`}>
                            <Pencil className="h-3 w-3" aria-hidden /> Edit
                          </button>
                          <button type="button" onClick={() => void askDelete(l.name)} disabled={disabledReason !== null || planning !== null} aria-busy={planning === l.name} className="inline-flex items-center gap-1 text-anvil-500 hover:text-danger-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-danger-400 coarse:min-h-11 coarse:min-w-11 coarse:justify-center" aria-label={`Delete label ${l.name}`}>
                            <Trash2 className="h-3 w-3" aria-hidden /> Delete
                          </button>
                        </>
                      ) : null}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {retired.length > 0 ? (
        <details className="rounded-lg border border-anvil-200 px-4 py-3 text-dense dark:border-anvil-800" data-testid="retired-labels">
          <summary className="cursor-pointer text-anvil-600 dark:text-anvil-300">{retired.length} retired {retired.length === 1 ? 'label' : 'labels'}</summary>
          <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">A retired label is no longer offered; issues that carry it keep it.</p>
          <ul className="mt-2 space-y-2">
            {retired.map((l) =>
              restoring === l.name ? (
                <li key={l.name}>
                  <LabelForm
                    initial={{ name: l.name, color: randomColor(''), description: '' }}
                    mode="restore"
                    taken={taken}
                    disabledReason={disabledReason}
                    onCancel={() => setRestoring(null)}
                    onSubmit={(v) => setPending({ kind: 'define', verb: 'restore', ...v })}
                  />
                </li>
              ) : (
                <li key={l.name} className="flex flex-wrap items-center gap-3" data-testid="retired-label" data-label={l.name}>
                  <LabelChip name={l.name} def={{ ...l, color: '' }} />
                  {canEdit ? (
                    <button type="button" onClick={() => { setRestoring(l.name); setEditing(null); setCreating(false) }} className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11">
                      <RotateCcw className="h-3 w-3" aria-hidden /> Restore
                    </button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </details>
      ) : null}

      {home.repo.visibility === 'private' ? (
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Label definitions (names, colours, descriptions) are not encrypted in a private repository; the labels on its issues are.</p>
      ) : null}

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
