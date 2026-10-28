'use client'

/**
 * The priced confirm a board action of several card writes passes through (`docs/design/boards.md`
 * §2.6 re-rank, §5.4 the next iteration, archiving a column): one write per item, a create for
 * each the signer has no card for, priced before signing (`priceBoardWrites`). It is the house
 * {@link ConfirmDialog}: the balance and key budget are checked, one toast totals the writes, and
 * a retry of one opening replays the same intents rather than signing twice.
 */

import { ConfirmDialog } from '@/components/confirm-dialog'
import { useAuth } from '@/contexts/auth-context'
import type { BoardHookState } from '@/hooks/use-board'
import { crossRepoCardNeedsConfirm, type BulkWritten, type CardItem, type CardWriteOptions, type RepoRef } from '@/lib/repo'

import { CROSS_REPO_CONFIRM, cardWritesCost } from './use-guarded-board'

/** One bulk board action awaiting its confirm. */
export interface BulkAction {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  /** The items it writes (what is priced). */
  readonly items: readonly CardItem[]
  /** Run it under the dialog's intent; a failed write is thrown, so the dialog shows it. */
  run(opts: CardWriteOptions): Promise<BulkWritten>
  /** What the one toast says once every write landed. */
  readonly done: string
}

export function BulkActionDialog({ action, state, home, onClose }: { action: BulkAction | null; state: BoardHookState; home: RepoRef; onClose: () => void }): JSX.Element | null {
  const { identity } = useAuth()
  if (action === null) return null
  const crossRepo = action.items.some((i) => crossRepoCardNeedsConfirm(home, i.repoId))
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={action.title}
      description={crossRepo ? `${action.description} ${CROSS_REPO_CONFIRM.body}` : action.description}
      cost={cardWritesCost(state, identity, action.items.map((i) => i.id), home.visibility === 'private')}
      confirmLabel={action.confirmLabel}
      successNote={action.done}
      onConfirm={async (intent) => {
        // This dialog is the confirm: another repo's items on a private board are confirmed by it.
        const out = await action.run({ intent, ...(crossRepo ? { confirmCrossRepo: true } : {}) })
        if (out.failed !== null) throw out.failed.error
      }}
    />
  )
}

/** "1 card" / "3 cards". */
export function cardCount(n: number): string {
  return n === 1 ? '1 card' : `${n} cards`
}

/** The re-rank action for a column's items in their order (§2.6). */
export function rerankAction(state: BoardHookState, columnName: string, items: readonly CardItem[]): BulkAction {
  return {
    title: `Re-rank ${columnName}`,
    description: `Spaces the order of ${cardCount(items.length)} evenly, so cards can be dropped between them again. The order stays as it is.`,
    confirmLabel: `Re-rank ${cardCount(items.length)}`,
    items,
    run: (opts) => state.rerank(items, opts),
    done: 'Column re-ranked',
  }
}
