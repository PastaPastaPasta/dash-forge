'use client'

/**
 * Quick add at the foot of a board column (`docs/design/boards.md` §5.3): a title makes a real
 * issue in the home repository (or a source repository picked beside the box) and places it in the
 * column; `#12`, `owner/name#12` or an issue or PR link of this app adds that existing item. A card
 * from a private home repository for another repository's item is confirmed first (§3.3). In a
 * column of a field (or a swimlane of one) the item's value of that field is set too.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CostPreview } from '@/components/ui/cost-preview'
import { useConfirmAction } from '@/components/ui/confirm-action'
import { Input } from '@/components/ui/input'
import type { BoardHookState } from '@/hooks/use-board'
import { useAsync } from '@/hooks/use-async'
import { useSdk } from '@/hooks/use-sdk'
import { crossRepoCardNeedsConfirm, parseItemReference, repoContractIds, resolveItemByNumber, type CardItem, type CardPatch, type RankedCard, type RepoRef } from '@/lib/repo'
import { readRepoById, repoRefOf, resolveAnyRepoWith } from '@/lib/repo/resolveRepo'
import type { BoardSpec, FieldValue } from '@/lib/rules/boards'
import { previewCreate, priceBoardWrites, sumPreviews } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

import { CROSS_REPO_CONFIRM, GuardDeclined } from './use-guarded-board'

/** What quick add's text asks for: a new issue's title, or an existing item by number. */
export type QuickAddPlan =
  | { readonly kind: 'empty' }
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'ref'; readonly owner?: string; readonly name?: string; readonly number: number }

export function quickAddPlan(text: string): QuickAddPlan {
  const t = text.trim()
  if (t === '') return { kind: 'empty' }
  const ref = parseItemReference(t)
  return ref === null ? { kind: 'title', title: t } : { kind: 'ref', ...ref }
}

/** Where a quick add puts the item: a column (`col`), and field values (the column's or the swimlane's field). */
export interface QuickAddTarget {
  /** The status column; null in a view grouped by a field (an existing item keeps its column, a new one gets the default). */
  readonly col: number | null
  /** Field values the column and swimlane stand for (a value, or null to leave unset). */
  readonly fields: Readonly<Record<number, FieldValue | null>>
  /** The status column's cards in rank order (a new issue goes to its bottom). */
  readonly column: readonly RankedCard[]
  /** What the column is called, for the box's label. */
  readonly name: string
}

/** A source repository a title may make its issue in. */
interface SourceRepo {
  readonly repo: RepoRef
  readonly label: string
}

/**
 * The repositories a quick add may create in: the home repository, then each public source
 * repository (a private one other than home needs a session this page does not hold).
 */
function useSourceRepos(spec: BoardSpec, home: RepoRef, homeLabel: string, enabled: boolean): readonly SourceRepo[] {
  const { sdk, ready } = useSdk(repoContractIds(home))
  const others = [...new Set(spec.sources.map((s) => s.r ?? home.repoId))].filter((r) => r !== home.repoId)
  const read = useAsync(
    async () => {
      const out: SourceRepo[] = []
      for (const id of others) {
        const doc = await readRepoById(sdk!, home.forge, id).catch(() => null)
        if (doc !== null && doc.visibility !== 'private') out.push({ repo: repoRefOf(home.forge, doc), label: doc.name })
      }
      return out
    },
    [ready, home.repoId, others.join(',')],
    { enabled: enabled && ready && sdk !== null && others.length > 0 },
  )
  return [{ repo: home, label: homeLabel }, ...(read.data ?? [])]
}

export function QuickAdd({ state, spec, home, homeLabel, target, onAdded }: { state: BoardHookState; spec: BoardSpec; home: RepoRef; homeLabel: string; target: QuickAddTarget; onAdded?: (itemId: string) => void }): JSX.Element {
  const { sdk } = useSdk(repoContractIds(home))
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repoId, setRepoId] = useState(home.repoId)
  const [confirm, confirmDialog] = useConfirmAction()
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const sources = useSourceRepos(spec, home, homeLabel, open)
  const chosen = sources.find((s) => s.repo.repoId === repoId) ?? (sources[0] as SourceRepo)
  const plan = quickAddPlan(text)
  const sealed = home.visibility === 'private'
  const hasFields = Object.values(target.fields).some((v) => v !== null)
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  /** A private home's card for another repository's item tells everyone it tracks it: ask first. */
  const confirmCrossRepo = async (itemRepoId: string): Promise<boolean> => !crossRepoCardNeedsConfirm(home, itemRepoId) || confirm(CROSS_REPO_CONFIRM)

  /** The field values a column or swimlane stands for, as one patch (none: null). */
  const fieldsPatch: CardPatch['fields'] | null = hasFields ? target.fields : null

  /** Close the box and drop what was typed. */
  const close = (): void => {
    setOpen(false)
    setText('')
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (busy || plan.kind === 'empty' || sdk === null) return
    setBusy(true)
    setError(null)
    try {
      if (plan.kind === 'title') {
        if (!(await confirmCrossRepo(chosen.repo.repoId))) return
        const out = await state.quickAdd({ title: plan.title, col: target.col ?? spec.def, column: target.column, target: chosen.repo, confirmCrossRepo: true })
        // The issue exists now, whatever follows: the box empties so a second Create makes no second issue.
        setText('')
        onAdded?.(out.item.id)
        const placed = (e: unknown): string => `Issue #${out.item.number} was created, but it could not be placed here: ${errorMessage(e)}`
        if (out.cardError !== null) {
          setError(placed(out.cardError))
          return
        }
        if (fieldsPatch !== null) await state.write({ id: out.item.id, repoId: out.item.repoId }, { fields: fieldsPatch }, { confirmCrossRepo: true }).catch((e: unknown) => setError(placed(e)))
        return
      }
      const repo = plan.owner !== undefined && plan.name !== undefined ? (await resolveAnyRepoWith(sdk, home.forge, { owner: plan.owner, name: plan.name }))?.repo ?? null : chosen.repo
      if (repo === null) {
        setError(`No repo ${plan.owner}/${plan.name}.`)
        return
      }
      const found = await resolveItemByNumber(sdk, repo, plan.number)
      if (found === null) {
        setError(`No issue or pull request #${plan.number} in ${plan.owner !== undefined ? `${plan.owner}/${plan.name}` : chosen.label}.`)
        return
      }
      const item: CardItem = { id: found.id, repoId: repo.repoId }
      if (!(await confirmCrossRepo(item.repoId))) return
      if (fieldsPatch === null) {
        const out = await state.add([item], target.col ?? undefined, { confirmCrossRepo: true })
        if (out.failed !== null) throw out.failed.error
      } else {
        await state.write(item, { state: 0, ...(target.col !== null ? { col: target.col } : {}), fields: fieldsPatch }, { confirmCrossRepo: true })
      }
      setText('')
      onAdded?.(item.id)
    } catch (e) {
      if (!(e instanceof GuardDeclined)) setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-dense text-anvil-500 hover:bg-anvil-100 hover:text-anvil-800 dark:text-anvil-400 dark:hover:bg-anvil-850 dark:hover:text-anvil-100 coarse:min-h-11"
        data-testid="quick-add-open"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add item
      </button>
    )
  }

  const cost =
    plan.kind === 'title'
      ? sumPreviews([previewCreate('issue', { title: plan.title, body: '' }), priceBoardWrites(1, hasFields ? 1 : 0, { sealed })])
      : plan.kind === 'ref'
        ? priceBoardWrites(1, 0, { sealed })
        : null
  return (
    <form
      className="space-y-1.5 rounded-md border border-anvil-200 bg-white p-2 dark:border-anvil-750 dark:bg-anvil-900"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      data-testid="quick-add"
    >
      <label htmlFor={inputId} className="sr-only">
        Add to {target.name}: a title for a new issue, or #12 or a link for an existing one
      </label>
      <Input
        ref={inputRef}
        id={inputId}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault()
            close()
          }
        }}
        placeholder="Title, #12 or a link"
        maxLength={256}
        className="h-8 py-1"
        disabled={busy}
      />
      {sources.length > 1 && (plan.kind !== 'ref' || plan.owner === undefined) ? (
        <div className="flex items-center gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
          <label htmlFor={`${inputId}-repo`}>In</label>
          <select
            id={`${inputId}-repo`}
            value={chosen.repo.repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-anvil-300 bg-white px-1.5 py-0.5 text-[12px] dark:border-anvil-700 dark:bg-anvil-950 coarse:h-11"
          >
            {sources.map((s) => (
              <option key={s.repo.repoId} value={s.repo.repoId}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <p className="text-[11px] text-anvil-500 dark:text-anvil-400">
        {plan.kind === 'title' ? `Creates an issue in ${chosen.label}.` : plan.kind === 'ref' ? `Adds #${plan.number}${plan.owner !== undefined ? ` of ${plan.owner}/${plan.name}` : ''} to the board.` : 'A title creates an issue. #12 or a link adds one.'}
      </p>
      {cost !== null ? <CostPreview cost={cost} className="px-2 py-1 text-[12px]" /> : null}
      {error !== null ? (
        <p role="alert" className="text-[12px] text-danger-700 dark:text-danger-400" data-testid="quick-add-error">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={close}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={plan.kind === 'empty'}>
          {plan.kind === 'ref' ? 'Add' : 'Create'}
        </Button>
      </div>
      {confirmDialog}
    </form>
  )
}
