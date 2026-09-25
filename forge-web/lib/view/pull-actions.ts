/**
 * PR action gating (view glue) — which PR state controls a viewer is shown, and what the
 * merge control may honestly promise.
 *
 * The web app cannot merge code. What it can do is append a `merge` event naming the PR head,
 * which {@link foldPrState} accepts only when (a) the signer held WRITE or MAINTAIN when the
 * event landed and (b) the head has been a tip of the base ref. So the control is offered
 * only to WRITE/MAINTAIN holders, is labelled "Mark as merged", and says up front whether
 * the mark will count now (the head is already on the base branch) or stay inert until the
 * code gets there by a push.
 *
 * Close/reopen stay available to the PR author as well — the fold honors the author's own
 * close/reopen — but not to identities whose event the fold would ignore.
 */

import type { Holdings } from '../rules'
import type { PullView } from '../repo'

/** What the viewer may do from the PR page, and why not when not. */
export interface PullActions {
  /** Offer "Mark as merged". */
  readonly canMarkMerged: boolean
  /** Offer close (open PRs) / reopen (closed, unmerged PRs). */
  readonly canCloseReopen: boolean
  /**
   * The mark would count right away: the head has already been a tip of the base branch.
   * When false the event still lands, but the fold ignores it until a push puts the head
   * there — the dialog must say so.
   */
  readonly markCountsNow: boolean
  /** A short reason shown when the merge control is withheld; null when shown. */
  readonly mergeHint: string | null
}

export interface PullActionInputs {
  readonly pull: Pick<PullView, 'author' | 'headOid' | 'headOnBase' | 'stateComplete' | 'state'>
  /** The signed-in identity, or null when logged out. */
  readonly viewer: string | null
  /**
   * The viewer's current holdings: `'loading'` until read, `null` when the token history
   * could not be read (permission unknown — controls are withheld, with a reason).
   */
  readonly holdings: Holdings | null | 'loading'
}

/** Decide the PR controls for a viewer. Pure — the unit-tested core of the PR page gate. */
export function pullActions({ pull, viewer, holdings }: PullActionInputs): PullActions {
  const known = holdings !== null && holdings !== 'loading'
  const holder = known && (holdings.write || holdings.maintain)
  const isAuthor = viewer !== null && viewer === pull.author
  const { merged, open } = pull.state
  // A PR whose event log was not read completely has no trustworthy state to act on.
  const actionable = pull.stateComplete && !merged

  const canMarkMerged = actionable && open && viewer !== null && holder && pull.headOid !== ''
  const canCloseReopen = actionable && viewer !== null && (holder || isAuthor)

  let mergeHint: string | null = null
  if (!canMarkMerged && actionable && open && viewer !== null && holdings !== 'loading') {
    mergeHint =
      holdings === null
        ? "Couldn't read this repo's token history, so merge permission is unknown."
        : pull.headOid === ''
          ? 'This PR records no head commit to mark as merged.'
          : 'Only WRITE or MAINTAIN holders can mark a PR as merged.'
  }

  return {
    canMarkMerged,
    canCloseReopen,
    markCountsNow: pull.headOnBase,
    mergeHint,
  }
}
