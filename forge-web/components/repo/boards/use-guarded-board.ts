'use client'

/**
 * The board hook with every card write passed through two checks first, so a layout calls
 * `state.move` and the like with no checks of its own:
 *
 * - the write guard (`useWriteGuard`: signed in, writes not paused, the session holds forge-meta,
 *   the balance and key budget cover the write's price, `priceBoardWrites`). A write it stops (it
 *   opened the sheet that fixes it) rejects with {@link GuardDeclined}, which callers ignore.
 * - on a private repository's board, a card for another repository's item tells everyone that
 *   this repository tracks that item (§3.3): every write refuses it unconfirmed
 *   (`crossRepoCardNeedsConfirm`), so the viewer is asked once per item, and a "no" is a
 *   {@link GuardDeclined} too.
 *
 * A refused write sets the hook's `refusal` as before. The confirm's dialog is the second value:
 * render it once. Multi-write actions behind a priced confirm (re-rank, the next iteration,
 * archiving a column) are confirmed there (`board-dialogs.tsx`).
 */

import { useRef } from 'react'

import { useConfirmAction } from '@/components/ui/confirm-action'
import { useAuth } from '@/contexts/auth-context'
import type { BoardHookState } from '@/hooks/use-board'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { writeContractKind } from '@/lib/layout'
import { crossRepoCardNeedsConfirm, planCardWrites, type CardItem, type CardWriteOptions, type RepoRef } from '@/lib/repo'
import { DOC } from '@/lib/repo/contract'
import { previewCreate, priceBoardWrites, sumPreviews, type CostPreview } from '@/lib/sdk'

/** A write that was not started: the guard opened what fixes it, or the viewer said no. */
export class GuardDeclined extends Error {
  constructor() {
    super("You weren't charged. Finish the step that opened, then try again.")
    this.name = 'GuardDeclined'
  }
}

/** The price of card writes for `items` by `me` on `state`'s board: a create where they have no card yet, else a replace. */
export function cardWritesCost(state: Pick<BoardHookState, 'cards'>, me: string | null, items: readonly string[], sealed: boolean): CostPreview {
  const plan = me === null ? { creates: items.length, replaces: 0 } : planCardWrites(state.cards, me, items)
  return priceBoardWrites(plan.creates, plan.replaces, { sealed })
}

/** The confirm a private board's card for another repository's item needs (§3.3). */
export const CROSS_REPO_CONFIRM = {
  title: 'Place another repo’s item?',
  body: 'This board is in a private repo. Placing an item of another repo on it shows everyone that this repo tracks that item.',
  confirmLabel: 'Place it anyway',
  tone: 'primary',
} as const

export function useGuardedBoard(state: BoardHookState, home: RepoRef): readonly [BoardHookState, JSX.Element | null] {
  const guard = useWriteGuard()
  const { identity } = useAuth()
  const [confirm, dialog] = useConfirmAction()
  /** Items the viewer confirmed this visit. */
  const confirmed = useRef(new Set<string>())
  const sealed = home.visibility === 'private'
  const card = writeContractKind(home.forge, DOC.card)

  /** Run the guard and the cross-repository confirm for `items`; the options the write then takes. */
  const ready = async (items: readonly CardItem[], action: string, opts: CardWriteOptions | undefined): Promise<CardWriteOptions | undefined> => {
    if (!guard.check(cardWritesCost(state, identity, items.map((i) => i.id), sealed), card, action)) throw new GuardDeclined()
    const crossRepo = items.filter((i) => crossRepoCardNeedsConfirm(home, i.repoId))
    const ask = crossRepo.filter((i) => !confirmed.current.has(i.id))
    if (opts?.confirmCrossRepo === true || ask.length === 0) return crossRepo.length > 0 ? { ...opts, confirmCrossRepo: true } : opts
    if (!(await confirm(CROSS_REPO_CONFIRM))) throw new GuardDeclined()
    for (const i of ask) confirmed.current.add(i.id)
    return { ...opts, confirmCrossRepo: true }
  }

  const guarded: BoardHookState = {
    ...state,
    write: async (item, patch, opts) => state.write(item, patch, await ready([item], 'change this card', opts)),
    move: async (item, target, column, before, opts) => state.move(item, target, column, before, await ready([item], 'move this card', opts)),
    add: async (items, col, opts) => state.add(items, col, await ready(items, 'add to this board', opts)),
    archive: async (items, opts) => state.archive(items, await ready(items, 'archive this card', opts)),
    unarchive: async (items, opts) => state.unarchive(items, await ready(items, 'restore this card', opts)),
    remove: async (items, opts) => state.remove(items, await ready(items, 'remove this card', opts)),
    quickAdd: (input) => {
      const cost = sumPreviews([previewCreate(DOC.issue, { title: input.title, body: '' }), priceBoardWrites(1, 0, { sealed })])
      if (!guard.check(cost, ['collab', card], 'add an issue to this board')) return Promise.reject(new GuardDeclined())
      return state.quickAdd(input)
    },
  }
  return [guarded, dialog] as const
}
