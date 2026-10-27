'use client'

/**
 * The item panel (`docs/design/boards.md` §5.5): an issue or pull request opened beside the board,
 * deep-linked as `&item=<id>`. It shows the title, state, author, body (the repository's Markdown),
 * labels, assignees and milestone, and the board's Status and custom fields. Members (`can.place`)
 * edit the fields here, each change one card write; they archive, restore or remove the item.
 * Labels and assignees are the issue's own member events, edited with the issue page's pickers
 * and confirm, for an item of the board's home repository (another repository's: on its page).
 *
 * A modal side sheet: focus moves in on open, Tab stays inside, Escape and the backdrop close it,
 * and focus returns to the card that opened it.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, ExternalLink, Lock, Trash2, X } from 'lucide-react'

import { Author } from '@/components/author'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { MarkdownView } from '@/components/markdown-view'
import { AssigneePicker, LabelPicker, applySetChange, assigneesConfirm, labelsConfirm, type SetChange } from '@/components/repo/target-rail'
import { useRepoLinks } from '@/components/repo/target-href'
import { Button } from '@/components/ui/button'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { CostPreview } from '@/components/ui/cost-preview'
import { LoadingBlock } from '@/components/ui/states'
import { useAuth } from '@/contexts/auth-context'
import type { BoardHookState } from '@/hooks/use-board'
import { useAsync } from '@/hooks/use-async'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useSdk } from '@/hooks/use-sdk'
import { trapTab } from '@/lib/focus'
import { defineLabel, repoContractIds, setAssignee, setLabel, type CardPatch, type LabelDef, type RepoRef } from '@/lib/repo'
import { readRepoById, repoRefOf } from '@/lib/repo/resolveRepo'
import { capabilitiesOf } from '@/lib/rules/roles'
import type { BoardItem, BoardSpec, Placement } from '@/lib/rules/boards'
import { previewCreate, sumPreviews } from '@/lib/sdk'
import { loadIssueThread, loadPullThread } from '@/lib/view'
import { timeAgo } from '@/lib/view/format'
import { errorMessage } from '@/lib/utils'

import { itemStateWords } from './board-bits'
import { ColorDot, FieldInput, ItemStateIcon, StatusSelect, columnName, fieldValueText } from './board-fields'
import { GuardDeclined, cardWritesCost } from './use-guarded-board'

/** What the panel reads of the item beyond the board's facts: its body and its repository's labels and members. */
interface ItemDetail {
  readonly body: string
  readonly labels: readonly LabelDef[]
  readonly members: readonly string[]
}

/** A labels or assignees change awaiting its confirm. */
type Pending =
  | { readonly kind: 'labels'; readonly change: SetChange }
  | { readonly kind: 'assignees'; readonly change: SetChange }
  | { readonly kind: 'defineLabel'; readonly name: string; readonly color: string; readonly description: string }

export interface ItemPanelProps {
  readonly state: BoardHookState
  readonly spec: BoardSpec
  readonly itemId: string
  /** The board's home repository and the page's address. */
  readonly home: RepoRef
  readonly addr: RepoAddress
  readonly labels?: ReadonlyMap<string, LabelDef> | undefined
  onClose(): void
}

export function ItemPanel({ state, spec, itemId, home, addr, labels, onClose }: ItemPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const item = state.items?.items.find((i) => i.id === itemId) ?? null
  const placement = state.fold?.items.find((p) => p.id === itemId) ?? null
  const hidden = state.items?.hidden.has(itemId) === true

  // Focus in on open, Tab kept inside, Escape closes (unless a picker or a dialog over the panel took it), focus back on close.
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const opener = document.activeElement
    panel.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      // A dialog opened over the panel (a confirm) keeps Tab itself.
      if (e.key === 'Tab' && panel.contains(document.activeElement) && panel.querySelector('[role="dialog"][aria-modal="true"]') === null) trapTab(panel, e)
      if (e.key === 'Escape') {
        // After the event has been through every listener: a popover or a dialog above takes it first.
        setTimeout(() => {
          if (!e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-item-panel])')) closeRef.current()
        }, 0)
      }
    }
    document.addEventListener('keydown', onKey)
    // The board behind does not scroll under the sheet (as behind a dialog).
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-testid="item-panel-layer">
      <div className="absolute inset-0 bg-anvil-950/40 animate-fade-in" aria-hidden onMouseDown={() => onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-panel-title"
        tabIndex={-1}
        data-item-panel
        data-testid="item-panel"
        className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-anvil-200 bg-white shadow-xl outline-none animate-fade-in dark:border-anvil-800 dark:bg-anvil-900"
      >
        {item === null || placement === null || !placement.on ? (
          <PanelFrame title="Item not on this board" onClose={onClose}>
            <p className="text-dense text-anvil-600 dark:text-anvil-300">This item is not on the board, or it has not loaded yet.</p>
          </PanelFrame>
        ) : hidden ? (
          <PanelFrame title="A private item" onClose={onClose}>
            <p className="flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300">
              <Lock className="h-4 w-4" aria-hidden /> It belongs to a private repo you can&apos;t read here.
            </p>
            <PlacementSection state={state} spec={spec} item={item} placement={placement} home={home} />
          </PanelFrame>
        ) : (
          <ItemBody state={state} spec={spec} item={item} placement={placement} home={home} addr={addr} labels={labels} onClose={onClose} />
        )}
      </div>
    </div>
  )
}

function PanelFrame({ title, number, onClose, children }: { title: string; number?: React.ReactNode; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <div className="flex items-start gap-3 border-b border-anvil-200 px-5 py-3.5 dark:border-anvil-800">
        <div className="min-w-0 flex-1">
          {number}
          <h2 id="item-panel-title" className="break-words text-prose font-semibold text-anvil-900 dark:text-anvil-50">
            {title}
          </h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close panel" className="-mr-1.5 -mt-1">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
    </>
  )
}

/** The item's repository (the home repository, or a public other one), and the address of its pages. */
function useItemRepo(item: BoardItem, home: RepoRef, addr: RepoAddress): { readonly repo: RepoRef | null; readonly addr: RepoAddress | null; readonly loading: boolean } {
  const { sdk, ready } = useSdk(repoContractIds(home))
  const other = item.repoId !== home.repoId
  const read = useAsync(() => readRepoById(sdk!, home.forge, item.repoId), [ready, item.repoId], { enabled: other && ready && sdk !== null })
  if (!other) return { repo: home, addr, loading: false }
  const doc = read.data
  if (doc === null || doc === undefined || doc.visibility === 'private') return { repo: null, addr: doc ? { owner: doc.ownerId, name: doc.name } : null, loading: read.loading }
  return { repo: repoRefOf(home.forge, doc), addr: { owner: doc.ownerId, name: doc.name }, loading: false }
}

function ItemBody({ state, spec, item, placement, home, addr, labels, onClose }: { state: BoardHookState; spec: BoardSpec; item: BoardItem; placement: Placement; home: RepoRef; addr: RepoAddress; labels?: ReadonlyMap<string, LabelDef> | undefined; onClose: () => void }): JSX.Element {
  const { sdk, ready, network } = useSdk(repoContractIds(home))
  const { signer } = useAuth()
  const itemRepo = useItemRepo(item, home, addr)
  const atHome = item.repoId === home.repoId
  const role = useViewerRole(home).role
  const caps = capabilitiesOf(role)
  const links = useRepoLinks(itemRepo.addr ?? addr, '')
  const detail = useAsync<ItemDetail | null>(
    async () => {
      const repo = itemRepo.repo as RepoRef
      if (item.kind === 'issue') {
        const t = await loadIssueThread(sdk!, repo, item.number, network)
        return t === null ? null : { body: t.issue.body, labels: t.labels, members: t.members.map((m) => m.identity) }
      }
      const t = await loadPullThread(sdk!, repo, item.number, network)
      return t === null ? null : { body: t.pull.body, labels: t.labels, members: t.members.map((m) => m.identity) }
    },
    // Read again when the board's items show other labels or assignees (a change made here, or by someone else).
    [ready, item.id, itemRepo.repo?.repoId ?? '', item.labels.join('\n'), item.assignees.join(',')],
    { enabled: ready && sdk !== null && itemRepo.repo !== null },
  )
  const [pending, setPending] = useState<Pending | null>(null)
  const byName = new Map((detail.data?.labels ?? []).map((l) => [l.name, l]))
  for (const [n, d] of labels ?? []) if (!byName.has(n)) byName.set(n, d)
  const target = { id: item.id, number: item.number }
  const confirmText =
    pending === null
      ? null
      : pending.kind === 'labels'
        ? labelsConfirm(pending.change)
        : pending.kind === 'assignees'
          ? assigneesConfirm(pending.change)
          : { title: `Create label "${pending.name}"`, description: 'Defines the label for this repo and applies it to this item.', label: 'Sign & create' }
  const pendingCost =
    pending === null ? null : pending.kind === 'defineLabel' ? sumPreviews([previewCreate('label', { name: pending.name, color: pending.color, description: pending.description }), previewCreate('event')]) : sumPreviews([...pending.change.add, ...pending.change.remove].map(() => previewCreate('event')))
  const runPending = async (intent: string): Promise<void> => {
    if (pending === null || sdk === null || signer === null) return
    if (pending.kind === 'labels') await applySetChange(pending.change, intent, (label, add, i) => setLabel(sdk, signer, home, { target, label, add, intent: i }))
    else if (pending.kind === 'assignees') await applySetChange(pending.change, intent, (who, add, i) => setAssignee(sdk, signer, home, { target, assignee: who, assign: add, intent: i }))
    else {
      await defineLabel(sdk, signer, home, { name: pending.name, color: pending.color, description: pending.description, intent: `${intent}:def` })
      await setLabel(sdk, signer, home, { target, label: pending.name, add: true, intent: `${intent}:apply` })
    }
    // The board's items carry labels and assignees: read them again.
    state.refresh()
  }

  const page = itemRepo.addr === null ? null : repoHref(item.kind === 'pr' ? '/repo/pull' : '/repo/issue', itemRepo.addr, { number: String(item.number) })
  const editMeta = atHome && signer !== null && state.board?.state === 'open'
  return (
    <PanelFrame
      title={item.title || '(untitled)'}
      onClose={onClose}
      number={
        <p className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
          <ItemStateIcon item={item} />
          <span className="font-medium text-anvil-700 dark:text-anvil-200">{itemStateWords(item)}</span>
          <span className="font-mono">
            {item.repo !== undefined && !atHome ? `${item.repo} ` : ''}#{item.number}
          </span>
          {page !== null ? (
            <Link href={page} className="hit-area inline-flex items-center gap-1 text-forge-700 hover:underline dark:text-forge-400" data-testid="item-page-link">
              Open {item.kind === 'pr' ? 'pull request' : 'issue'} <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          ) : null}
        </p>
      }
    >
      <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
        <Author identityId={item.author} /> opened {timeAgo(item.createdAt)}
        {item.milestone !== null ? <span>· Milestone {item.milestone}</span> : null}
      </p>

      <PlacementSection state={state} spec={spec} item={item} placement={placement} home={home} />

      <section aria-labelledby="item-panel-labels">
        <h3 id="item-panel-labels" className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
          Labels
        </h3>
        <LabelPicker
          applied={item.labels}
          defs={detail.data?.labels ?? [...(labels?.values() ?? [])]}
          byName={byName}
          canEdit={editMeta && caps.canLabel && detail.data != null}
          onApply={(change) => setPending({ kind: 'labels', change })}
          onDefine={(name, color, description) => setPending({ kind: 'defineLabel', name, color, description })}
        />
      </section>
      <section aria-labelledby="item-panel-assignees">
        <h3 id="item-panel-assignees" className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-anvil-500 dark:text-anvil-400">
          Assignees
        </h3>
        <AssigneePicker assignees={item.assignees} members={detail.data?.members ?? []} canEdit={editMeta && caps.canAssign && detail.data != null} onApply={(change) => setPending({ kind: 'assignees', change })} />
      </section>
      {!atHome && signer !== null ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Labels and assignees of another repo&apos;s item are changed on its page.</p> : null}

      <section aria-labelledby="item-panel-body" className="border-t border-anvil-200 pt-4 dark:border-anvil-800">
        <h3 id="item-panel-body" className="sr-only">
          Description
        </h3>
        {itemRepo.loading || (detail.loading && detail.data === null) ? (
          <LoadingBlock label="Reading the description" />
        ) : detail.error !== null ? (
          <p className="text-dense text-danger-700 dark:text-danger-400">Couldn&apos;t read the description: {detail.error}</p>
        ) : itemRepo.repo === null ? (
          <p className="text-dense text-anvil-500 dark:text-anvil-400">Open the item to read its description.</p>
        ) : detail.data == null || detail.data.body.trim() === '' ? (
          <p className="text-dense italic text-anvil-500 dark:text-anvil-400">No description provided.</p>
        ) : (
          <MarkdownView source={detail.data.body} links={links} />
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={confirmText?.title ?? ''}
        description={confirmText?.description ?? ''}
        cost={pendingCost}
        confirmLabel={confirmText?.label ?? 'Sign'}
        onConfirm={runPending}
      />
    </PanelFrame>
  )
}

/** The board's Status and fields for the item, editable by members, and archive / restore / remove. */
function PlacementSection({ state, spec, item, placement, home }: { state: BoardHookState; spec: BoardSpec; item: BoardItem; placement: Placement; home: RepoRef }): JSX.Element {
  const { identity } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, confirmDialog] = useConfirmAction()
  const can = state.can.place
  const cardItem = { id: item.id, repoId: item.repoId }
  const pending = state.pending.has(item.id)

  /** Run one write of this item as `key` (the control that shows it busy); a guard that stopped it says nothing more. */
  const attempt = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await run()
    } catch (e) {
      if (!(e instanceof GuardDeclined)) setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const write = (key: string, patch: CardPatch): Promise<void> => attempt(key, () => state.write(cardItem, patch))
  const bulk = (key: string, run: () => Promise<{ readonly failed: { readonly error: unknown } | null }>): Promise<void> =>
    attempt(key, async () => {
      const out = await run()
      if (out.failed !== null) setError(errorMessage(out.failed.error))
    })

  return (
    <section aria-labelledby="item-panel-fields" className="rounded-md border border-anvil-200 dark:border-anvil-800" data-testid="item-panel-fields">
      <h3 id="item-panel-fields" className="border-b border-anvil-200 bg-anvil-50 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-anvil-500 dark:border-anvil-800 dark:bg-anvil-850 dark:text-anvil-400">
        On this board
      </h3>
      <dl className="divide-y divide-anvil-100 dark:divide-anvil-850">
        <FieldRow label="Status" htmlFor="item-field-status">
          {can ? (
            <StatusSelect id="item-field-status" spec={spec} value={placement.col} disabled={busy !== null} onChange={(col) => void write('status', { col })} />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <ColorDot color={spec.columns.find((c) => c.id === placement.col)?.color} /> {columnName(spec, placement.col)}
            </span>
          )}
        </FieldRow>
        {spec.fields.map((f) => (
          <FieldRow key={f.id} label={f.name} htmlFor={`item-field-${f.id}`}>
            {can ? (
              <FieldInput id={`item-field-${f.id}`} field={f} value={placement.fields[String(f.id)]} now={state.now} disabled={busy !== null} onCommit={(v) => void write(`f${f.id}`, { fields: { [f.id]: v } })} />
            ) : (
              <span className={placement.fields[String(f.id)] === undefined ? 'text-anvil-500 dark:text-anvil-400' : undefined}>{fieldValueText(f, placement.fields[String(f.id)]) || 'None'}</span>
            )}
          </FieldRow>
        ))}
      </dl>
      {can ? (
        <div className="space-y-2 border-t border-anvil-200 px-3 py-2.5 dark:border-anvil-800">
          <div className="flex flex-wrap items-center gap-2">
            {placement.archived !== null ? (
              <Button size="sm" variant="outline" loading={busy === 'unarchive'} disabled={busy !== null} onClick={() => void bulk('unarchive', () => state.unarchive([cardItem]))}>
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> Restore
              </Button>
            ) : (
              <Button size="sm" variant="outline" loading={busy === 'archive'} disabled={busy !== null} onClick={() => void bulk('archive', () => state.archive([cardItem]))}>
                <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'remove'}
              disabled={busy !== null}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Remove from this board?',
                  body: placement.sourced ? 'The item leaves the board even though the board’s sources include it. Adding it again brings it back.' : 'The item leaves the board. Adding it again brings it back.',
                  confirmLabel: 'Remove',
                })
                if (ok) await bulk('remove', () => state.remove([cardItem]))
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
            </Button>
            {pending ? <span className="text-[12px] text-anvil-500 dark:text-anvil-400">Saving…</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-anvil-500 dark:text-anvil-400">
            <span>Each change:</span>
            <CostPreview cost={cardWritesCost(state, identity, [item.id], home.visibility === 'private')} className="px-2 py-0.5 text-[12px]" />
          </div>
          {error !== null ? (
            <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400" data-testid="item-panel-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : placement.archived !== null ? (
        <p className="border-t border-anvil-200 px-3 py-2 text-[12px] text-anvil-500 dark:border-anvil-800 dark:text-anvil-400">Archived</p>
      ) : null}
      {confirmDialog}
    </section>
  )
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 px-3 py-1.5">
      <dt>
        <label htmlFor={htmlFor} className="text-dense text-anvil-600 dark:text-anvil-300">
          {label}
        </label>
      </dt>
      <dd className="min-w-0 text-dense text-anvil-900 dark:text-anvil-100">{children}</dd>
    </div>
  )
}
