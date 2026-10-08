'use client'

/**
 * Bulk close, reopen and label on the issue and pull request lists, as GitHub's lists offer them:
 * a checkbox per row and one for the page, a bar naming how many are selected, then one confirm
 * for the whole batch with its cost, per-item progress, and what failed and why with "Retry
 * failed". Members who may close and label only (`capabilitiesOf(role)`); everyone else sees no
 * checkbox. Nothing is read until the viewer acts: the role is the repo header's (shared, cached),
 * and the costs are previews.
 *
 * Platform takes one transition per write, so a batch is one write per item, signed in turn
 * (`lib/view/bulk.ts`).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, Circle, Loader2, Minus, Tag, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { Dialog } from '@/components/ui/dialog'
import { useAuth } from '@/contexts/auth-context'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useSdk } from '@/hooks/use-sdk'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { IllegalTransitionError, repoContractIds, setLabelIfNeeded, setTargetState, type LabelDef } from '@/lib/repo'
import { capabilitiesOf } from '@/lib/rules/roles'
import { statusOfCode } from '@/lib/rules/transition'
import { SupersededWriteError, UnconfirmedWriteError, newIntent, previewCreate, sumPreviews, type CostPreview as Cost } from '@/lib/sdk'
import type { RepoHome } from '@/lib/view'
import { ARCHIVED_REASON } from '@/lib/view'
import {
  ALREADY_MERGED,
  actionTitle,
  allReopenable,
  doneWord,
  unchangedSummary,
  unchangedWord,
  labelCoverage,
  menuPlacement,
  type MenuPlacement,
  nounFor,
  planBulk,
  retryable,
  runBatch,
  tally,
  type BulkAction,
  type BulkOutcome,
  type BulkRow,
} from '@/lib/view/bulk'
import { writeFailure } from '@/lib/view/write-errors'
import { cn } from '@/lib/utils'

export type BulkKind = 'issue' | 'pull'

/** Whether the viewer may use the bulk bar here (a member who may close and label; not archived). */
export function useBulkAllowed(home: RepoHome): boolean {
  const { identity } = useAuth()
  const role = useViewerRole(home.repo)
  const caps = capabilitiesOf(role.role)
  return identity !== null && role.known && caps.canCloseReopen && caps.canLabel
}

/**
 * Keep showing the list while a batch runs: each close or reopen re-reads the list, which drops
 * its rows while the read is under way. `keep(data)` is the newest rows, or while `busy` the last
 * ones shown. The batch's own dialog works from the rows it was opened with.
 */
export function useBulkHold<T>(): { readonly busy: boolean; readonly setBusy: (on: boolean) => void; readonly keep: (data: T | null) => T | null } {
  const [busy, setBusy] = useState(false)
  const last = useRef<T | null>(null)
  const keep = (data: T | null): T | null => {
    if (data !== null) last.current = data
    return data ?? (busy ? last.current : null)
  }
  return { busy, setBusy, keep }
}

/** The rows selected on this page; cleared when the page's rows change (a filter, a page). */
export function useBulkSelection(rows: readonly BulkRow[]): {
  readonly selected: ReadonlySet<string>
  readonly selectedRows: readonly BulkRow[]
  readonly toggle: (id: string, on: boolean) => void
  readonly setAll: (on: boolean) => void
  readonly clear: () => void
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const key = rows.map((r) => r.id).join(',')
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    // Keep what is still shown (a reload after a batch keeps the rows' selection).
    const ids = new Set(rows.map((r) => r.id))
    setSelected((s) => new Set([...s].filter((id) => ids.has(id))))
  }
  const toggle = useCallback((id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }), [])
  const setAll = useCallback((on: boolean) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set()), [rows])
  const clear = useCallback(() => setSelected(new Set()), [])
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected])
  return { selected, selectedRows, toggle, setAll, clear }
}

/** A row's checkbox ("Select issue #12"). */
export function BulkRowCheckbox({ kind, number, checked, onChange }: { kind: BulkKind; number: number; checked: boolean; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={`Select ${nounFor(kind, 1)} #${number}`}
      className="mt-0.5 h-4 w-4 shrink-0 accent-forge-600 coarse:h-5 coarse:w-5"
      data-testid="bulk-select-row"
    />
  )
}

/**
 * The select-all checkbox and, once something is selected, the bar: "3 selected", Close (or
 * Reopen when every selected row is closed) and Label. Sits in the list header in place of the
 * filters' row start.
 */
export function BulkBar({
  kind,
  home,
  rows,
  selection,
  labels,
  onWritten,
  onBusy,
}: {
  kind: BulkKind
  home: RepoHome
  rows: readonly BulkRow[]
  selection: ReturnType<typeof useBulkSelection>
  labels: readonly LabelDef[]
  /** The batch is done and something was written: re-read the list. */
  onWritten: () => void
  /** A batch's dialog opened (true) or closed (false): the page keeps its rows meanwhile. */
  onBusy?: (busy: boolean) => void
}): JSX.Element | null {
  const { selectedRows, setAll, clear } = selection
  const n = selectedRows.length
  const all = rows.length > 0 && n === rows.length
  const archived = home.config?.archived === true
  const guard = useWriteGuard()
  const disabled = archived ? ARCHIVED_REASON : guard.disabledReason
  // The batch and the rows it acts on, fixed when its dialog opens: the list re-reads as it
  // writes, and its rows must not change the batch under way.
  const [batch, setBatch] = useState<{ readonly action: BulkAction; readonly rows: readonly BulkRow[] } | null>(null)
  const setAction = (action: BulkAction): void => {
    setBatch({ action, rows: selectedRows })
    onBusy?.(true)
  }
  const reopen = allReopenable(selectedRows)
  // Leaving the page mid-batch releases the page's hold on its rows.
  const onBusyRef = useRef(onBusy)
  onBusyRef.current = onBusy
  useEffect(() => () => onBusyRef.current?.(false), [])
  const allBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = n > 0 && !all
  }, [n, all])
  if (rows.length === 0 && batch === null) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-testid="bulk-bar">
      <label className="inline-flex items-center gap-2 text-dense text-anvil-600 dark:text-anvil-300 coarse:min-h-11">
        <input
          ref={allBox}
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          aria-label={`Select every ${nounFor(kind, 1)} on this page`}
          className="h-4 w-4 accent-forge-600 coarse:h-5 coarse:w-5"
          data-testid="bulk-select-all"
        />
        <span aria-live="polite">{n > 0 ? `${n} selected` : null}</span>
      </label>
      {n > 0 ? (
        <>
          {reopen ? (
            <Button size="sm" variant="outline" disabled={disabled !== null} title={disabled ?? undefined} onClick={() => setAction({ kind: 'reopen' })} data-testid="bulk-reopen">
              Reopen
            </Button>
          ) : kind === 'issue' ? (
            <Menu label="Close" testId="bulk-close" disabled={disabled}>
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); setAction({ kind: 'close', reason: 'completed' }) }}>Close as completed</MenuItem>
                  <MenuItem onClick={() => { close(); setAction({ kind: 'close', reason: 'not_planned' }) }}>Close as not planned</MenuItem>
                </>
              )}
            </Menu>
          ) : (
            <Button size="sm" variant="outline" disabled={disabled !== null} title={disabled ?? undefined} onClick={() => setAction({ kind: 'close' })} data-testid="bulk-close">
              Close
            </Button>
          )}
          <Menu label="Label" icon={<Tag className="h-3.5 w-3.5" aria-hidden />} testId="bulk-label" disabled={disabled}>
            {(close) =>
              labels.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-anvil-500 dark:text-anvil-400">This repository has no labels yet.</p>
              ) : (
                labels.map((l) => {
                  const cover = labelCoverage(selectedRows, l.name)
                  return (
                    <MenuItem
                      key={l.name}
                      onClick={() => {
                        close()
                        setAction({ kind: 'label', label: l.name, add: cover !== 'all' })
                      }}
                      title={cover === 'all' ? `Remove ${l.name}` : `Add ${l.name}`}
                    >
                      <span className="inline-flex w-4 justify-center" aria-hidden>
                        {cover === 'all' ? <Check className="h-3.5 w-3.5" /> : cover === 'some' ? <Minus className="h-3.5 w-3.5" /> : null}
                      </span>
                      <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: l.color || 'transparent' }} aria-hidden />
                      <span className="truncate">{l.name}</span>
                      <span className="sr-only">{cover === 'all' ? ' (on all selected; removes it)' : cover === 'some' ? ' (on some selected; adds it to the rest)' : ''}</span>
                    </MenuItem>
                  )
                })
              )
            }
          </Menu>
          <Button size="sm" variant="ghost" onClick={clear} data-testid="bulk-clear">
            Clear selection
          </Button>
        </>
      ) : null}
      {batch !== null ? (
        <BulkDialog
          kind={kind}
          home={home}
          action={batch.action}
          rows={batch.rows}
          onClose={(wrote) => {
            setBatch(null)
            onBusy?.(false)
            if (wrote) {
              clear()
              onWritten()
            }
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * A small menu button: the panel opens below it (above when there is no room), Escape or a pick
 * closes it and returns focus. The panel is drawn on the page, not inside the list's box, whose
 * edges clip anything that overflows it (on a phone, or under a short list).
 */
function Menu({ label, icon, testId, disabled, children }: { label: string; icon?: JSX.Element; testId: string; disabled: string | null; children: (close: () => void) => React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    button.current?.focus()
  }, [])
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = (): void => {
      const r = button.current?.getBoundingClientRect()
      if (r) setPlacement(menuPlacement(r, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  // Focus the first item once the panel is there, not on each reposition.
  const shown = open && placement !== null
  useEffect(() => {
    if (shown) panel.current?.querySelector<HTMLElement>('button')?.focus()
  }, [shown])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div
      className="relative"
      onBlur={(e) => {
        // Focus leaving the button and its panel closes the panel (the panel is drawn elsewhere
        // in the page, so it is checked by its own node).
        const to = e.relatedTarget as Node | null
        if (open && !e.currentTarget.contains(to) && !panel.current?.contains(to)) setOpen(false)
      }}
    >
      <Button
        ref={button}
        size="sm"
        variant="outline"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled !== null}
        title={disabled ?? undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {icon}
        {label}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {shown
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-label={label}
              data-testid={`${testId}-menu`}
              className="fixed z-40 overflow-auto rounded-md border border-anvil-200 bg-white py-1 shadow-lg dark:border-anvil-700 dark:bg-anvil-900"
              style={{ left: placement.left, width: placement.width, maxHeight: placement.maxHeight, top: placement.top, bottom: placement.bottom }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  close()
                } else if (e.key === 'Tab') {
                  // The panel is drawn at the end of the page: Tab goes back to the button, where
                  // the bar's own order continues.
                  e.preventDefault()
                  close()
                }
              }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function MenuItem({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" onClick={onClick} title={title} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-dense text-anvil-800 hover:bg-anvil-100 focus-visible:bg-anvil-100 focus-visible:outline-none dark:text-anvil-100 dark:hover:bg-anvil-800 dark:focus-visible:bg-anvil-800 coarse:min-h-11">
      {children}
    </button>
  )
}

/** The batch's cost: one transition per close or reopen, one event per label change (upper bounds: no first-write reads). */
export function bulkCost(action: BulkAction, count: number): Cost {
  const one = action.kind === 'label' ? previewCreate('event', { value: action.label }) : previewCreate('transition', {})
  return sumPreviews(Array.from({ length: count }, () => one))
}

const SHOWN = 8

function BulkDialog({ kind, home, action, rows, onClose }: { kind: BulkKind; home: RepoHome; action: BulkAction; rows: readonly BulkRow[]; onClose: (wrote: boolean) => void }): JSX.Element {
  const repo = home.repo
  const { sdk } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const plan = useMemo(() => planBulk(action, rows), [action, rows])
  const cost = useMemo(() => bulkCost(action, plan.apply.length), [action, plan.apply.length])
  const intent = useRef(newIntent()).current
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, BulkOutcome> | null>(null)
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  // Items whose last write was sent and not yet shown: a retry finding them done finds its own work.
  const maybeLanded = useRef(new Set<string>())
  const noun = nounFor(kind, plan.apply.length)
  const title = actionTitle(action, kind, plan.apply.length)

  const run = async (items: readonly BulkRow[]): Promise<void> => {
    if (!sdk || !signer) return
    stop.current = false
    setRunning(true)
    setOutcomes((cur) => {
      const next = new Map(cur ?? [])
      for (const r of items) next.set(r.id, { status: 'waiting' })
      return next
    })
    await runBatch(items, {
      intent,
      shouldStop: () => stop.current,
      write: async (row, itemIntent) => {
        // An earlier attempt of this item was sent and not yet shown: if the item is in the
        // asked state now, that attempt landed and it is this batch's doing.
        const mine = maybeLanded.current.has(row.id)
        try {
          const result =
            action.kind === 'label'
              ? await setLabelIfNeeded(sdk, signer, repo, { target: { id: row.id, number: row.number }, label: action.label, add: action.add, intent: itemIntent })
              : await setTargetState(sdk, signer, repo, {
                  target: { id: row.id, number: row.number, type: kind === 'issue' ? 'issue' : 'patch', author: row.author },
                  action: action.kind,
                  isMember: true,
                  intent: itemIntent,
                  ...(action.kind === 'close' && kind === 'issue' && action.reason !== undefined ? { closed: { reason: action.reason, duplicateOf: null } } : {}),
                })
          // Nothing was written: it was already in the asked state (a close or reopen answers an
          // empty document id, a label null). Someone else made the change, unless this item's
          // own earlier attempt did.
          return { changed: mine || (result !== null && result.documentId !== '') }
        } catch (e) {
          // An earlier attempt of this same item landed: it is written.
          if (e instanceof SupersededWriteError) return { changed: true }
          // Someone else moved it since the list was read: nothing to write. A merged pull
          // request is said to be merged, not closed.
          if (e instanceof IllegalTransitionError) {
            if ((e.code & 2) !== 0) return { changed: false, note: ALREADY_MERGED }
            // Only when the state really is the asked one; any other refusal is this item's failure.
            if (action.kind !== 'label' && statusOfCode(e.code).open === (action.kind === 'reopen')) return { changed: false }
          }
          throw e
        }
      },
      classify: (e) => {
        const f = writeFailure(e)
        return { message: f.message, unconfirmed: e instanceof UnconfirmedWriteError, stop: f.sheet !== null }
      },
      onOutcome: (id, o) => {
        if (o.status === 'unconfirmed') maybeLanded.current.add(id)
        // Only a settled item forgets it: a failed or stopped retry leaves the earlier write able to land.
        else if (o.status === 'done' || o.status === 'unchanged') maybeLanded.current.delete(id)
        setOutcomes((cur) => new Map(cur ?? []).set(id, o))
      },
    })
    setRunning(false)
  }

  const started = outcomes !== null
  const t = outcomes === null ? null : tally(outcomes)
  // What "Retry" would take up again: what failed, is still arriving, or was not tried.
  const failed = plan.apply.filter((r) => retryable(outcomes?.get(r.id)))
  // Sent but not yet shown: they may still land, so they are not counted as failed.
  const arriving = t?.unconfirmed ?? 0
  // Left alone because the batch stopped first (asked to, or out of funds): not a failure.
  const notTried = t?.stopped ?? 0
  const notThrough = t?.failed ?? 0
  const wrote = t !== null && t.done + t.unchanged + t.unconfirmed > 0
  const finished = started && !running

  return (
    <Dialog
      open
      onClose={() => {
        if (!running) onClose(wrote)
      }}
      title={title}
      description={started ? undefined : `One write per ${nounFor(kind, 1)}, signed one after another.`}
      footer={
        !started ? (
          <>
            <Button variant="ghost" onClick={() => onClose(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={plan.apply.length === 0 || guard.disabledReason !== null}
              onClick={() => {
                if (guard.check(cost, 'collab')) void run(plan.apply)
              }}
              data-testid="bulk-confirm"
            >
              {`Sign ${plan.apply.length} ${plan.apply.length === 1 ? 'write' : 'writes'}`}
            </Button>
          </>
        ) : running ? (
          <Button
            variant="outline"
            onClick={() => {
              stop.current = true
            }}
            data-testid="bulk-stop"
          >
            Stop after this one
          </Button>
        ) : (
          <>
            {failed.length > 0 ? (
              <Button
                variant="outline"
                disabled={guard.disabledReason !== null}
                onClick={() => {
                  if (guard.check(bulkCost(action, failed.length), 'collab')) void run(failed)
                }}
                data-testid="bulk-retry"
              >
                {notThrough === 0 && arriving === 0 ? `Continue ${failed.length}` : arriving === 0 && notTried === 0 ? `Retry ${failed.length} failed` : `Retry ${failed.length}`}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => onClose(wrote)} data-testid="bulk-done">
              Done
            </Button>
          </>
        )
      }
    >
      {!started ? (
        <div className="space-y-3 text-dense">
          <ul className="space-y-1" aria-label={`${noun} to change`}>
            {plan.apply.slice(0, SHOWN).map((r) => (
              <li key={r.id} className="truncate">
                <span className="font-mono text-anvil-500 dark:text-anvil-400">#{r.number}</span> {r.title || '(untitled)'}
              </li>
            ))}
            {plan.apply.length > SHOWN ? <li className="text-anvil-500 dark:text-anvil-400">{`and ${plan.apply.length - SHOWN} more`}</li> : null}
          </ul>
          {plan.unchanged > 0 ? (
            <p className="text-anvil-500 dark:text-anvil-400" data-testid="bulk-unchanged">
              {`${plan.unchanged} selected ${plan.unchanged === 1 ? 'is' : 'are'} already that way and ${plan.unchanged === 1 ? 'is' : 'are'} left as ${plan.unchanged === 1 ? 'it is' : 'they are'}.`}
            </p>
          ) : null}
          {plan.apply.length === 0 ? <p>Nothing to change.</p> : <CostPreview cost={cost} />}
        </div>
      ) : (
        <div className="space-y-3 text-dense">
          {t !== null ? (
            <p aria-live="polite" className={cn('font-medium', finished && notThrough > 0 && 'text-danger-700 dark:text-danger-400')} data-testid="bulk-summary">
              {running
                ? `${t.done + t.unchanged} of ${plan.apply.length} done…`
                : failed.length === 0
                  ? t.done === 0
                    ? `Nothing was changed. ${unchangedSummary(t.unchanged)}`
                    : [`${doneWord(action)}: ${t.done} ${nounFor(kind, t.done)}.`, t.unchanged > 0 ? unchangedSummary(t.unchanged) : ''].filter((x) => x !== '').join(' ')
                  : [
                      `${t.done + t.unchanged} of ${plan.apply.length} done.`,
                      notThrough > 0 ? `${notThrough} didn't go through.` : '',
                      arriving > 0 ? `${arriving} still arriving.` : '',
                      notTried > 0 ? `${notTried} not tried.` : '',
                    ]
                      .filter((x) => x !== '')
                      .join(' ')}
            </p>
          ) : null}
          <ul className="max-h-72 space-y-1 overflow-auto" aria-label="Progress" data-testid="bulk-progress">
            {plan.apply.map((r) => {
              const o = outcomes?.get(r.id)
              return (
                <li key={r.id} className="flex items-start gap-2" data-status={o?.status ?? 'waiting'}>
                  <StatusIcon status={o?.status ?? 'waiting'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      <span className="font-mono text-anvil-500 dark:text-anvil-400">#{r.number}</span> {r.title || '(untitled)'}
                    </p>
                    {o?.message && o.status !== 'unchanged' ? <p className={cn('text-[12px]', o.status === 'failed' ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400')}>{o.message}</p> : null}
                    {o?.status === 'stopped' ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">Not tried.</p> : null}
                    {o?.status === 'unchanged' ? <p className="text-[12px] text-anvil-500 dark:text-anvil-400">{o.message ?? unchangedWord(action)}</p> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Dialog>
  )
}

function StatusIcon({ status }: { status: BulkOutcome['status'] }): JSX.Element {
  switch (status) {
    case 'running':
      return (
        <>
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-forge-600" aria-hidden />
          <span className="sr-only">In progress</span>
        </>
      )
    case 'done':
    case 'unchanged':
      return (
        <>
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-verify" aria-hidden />
          <span className="sr-only">Done</span>
        </>
      )
    case 'unconfirmed':
      return (
        <>
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
          <span className="sr-only">Sent, not yet shown</span>
        </>
      )
    case 'failed':
      return (
        <>
          <X className="mt-0.5 h-4 w-4 shrink-0 text-danger-600" aria-hidden />
          <span className="sr-only">Failed</span>
        </>
      )
    case 'stopped':
      return (
        <>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-anvil-500" aria-hidden />
          <span className="sr-only">Not tried</span>
        </>
      )
    case 'waiting':
      return (
        <>
          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-anvil-400" aria-hidden />
          <span className="sr-only">Waiting</span>
        </>
      )
  }
}
