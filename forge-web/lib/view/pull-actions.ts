/**
 * PR action gating (view glue) — which PR state controls a viewer is shown, and what the
 * merge control may honestly promise.
 *
 * The web app cannot merge code. What it can do is append a `merge` event naming the PR head.
 * Consensus admits an `event` only from a current maintainer or writer, and `foldPrStateV2`
 * applies the merge only when the head has been a tip of the base ref. So the control is
 * offered only to members, is labelled "Mark as merged", and says up front whether the mark
 * will count now (the head is already on the base branch) or stay inert until the code gets
 * there by a push.
 *
 * Close/reopen stay available to the PR author as well (an `authorEvent`), but not to anyone
 * consensus would refuse.
 */

import { isOidHex, isPlainBranchRef, type Holdings } from '../rules'
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
   * The viewer's current permissions: `'loading'` until read, `null` when the membership could
   * not be read — permission unknown, controls withheld with a reason.
   */
  readonly holdings: Holdings | null | 'loading'
}

/** What a repo's ACL is read from, for "couldn't read …" messages. */
export const ACL_NAME = 'members'

/**
 * The browser merge button (`ux-dx-spec.md` §5.7), forge-v2 only. Its label says what it does;
 * a disabled state says why.
 */
export type MergeButton =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'fast-forward'; readonly label: 'Merge (fast-forward)' }
  | { readonly kind: 'merge-commit'; readonly label: 'Create merge commit and merge' }
  | { readonly kind: 'conflicts'; readonly label: 'Conflicts or overlapping changes — merge with `dg pr merge`'; readonly checkout: string }
  | { readonly kind: 'protected'; readonly label: 'Protected branch — maintainers only' }
  | { readonly kind: 'mobile'; readonly label: 'Use a desktop browser for this step' }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface MergeButtonInputs {
  /** From {@link pullActions}: the viewer is a current maintainer or writer and the PR is open. */
  readonly canMerge: boolean
  /** Private repos are not merged in the browser yet (their packs must be encrypted). */
  readonly isPublic: boolean
  /** Why the PR's base or head cannot be merged at all (not a plain branch, no tip, bad oid), or null. */
  readonly refProblem: string | null
  /** The base repo's own reader is loaded (the merge never reads the base side from the fork). */
  readonly baseLoaded: boolean
  readonly isMaintainer: boolean
  /** The base branch matches the repo's current protected patterns. */
  readonly baseProtected: boolean
  readonly narrow: boolean
  /** The worker's verdict, or null while it runs; an error string when it could not decide. */
  readonly check: 'fast-forward' | 'merge' | 'conflict' | 'malformed' | 'too-large' | 'up-to-date' | 'unrelated' | { readonly error: string } | null
  /** `dg pr checkout <repo> <n>` for the conflicts row. */
  readonly checkout: string
}

export function mergeButton(i: MergeButtonInputs): MergeButton {
  if (!i.canMerge) return { kind: 'hidden' }
  if (!i.isPublic) return { kind: 'unavailable', reason: 'Private repositories are merged with `dg pr merge` for now.' }
  if (i.refProblem !== null) return { kind: 'unavailable', reason: i.refProblem }
  if (i.baseProtected && !i.isMaintainer) return { kind: 'protected', label: 'Protected branch — maintainers only' }
  if (i.narrow) return { kind: 'mobile', label: 'Use a desktop browser for this step' }
  if (!i.baseLoaded) return { kind: 'unavailable', reason: 'Load the base repo to merge (see Files changed below).' }
  const c = i.check
  if (c === null) return { kind: 'checking' }
  if (typeof c === 'object') return { kind: 'unavailable', reason: `Couldn't check the merge in the browser (${c.error}).` }
  switch (c) {
    case 'fast-forward':
      return { kind: 'fast-forward', label: 'Merge (fast-forward)' }
    case 'merge':
      return { kind: 'merge-commit', label: 'Create merge commit and merge' }
    case 'conflict':
      // The browser merges only disjoint changes; anything both sides touched is the CLI's.
      return { kind: 'conflicts', label: 'Conflicts or overlapping changes — merge with `dg pr merge`', checkout: i.checkout }
    case 'malformed':
      return {
        kind: 'unavailable',
        reason: 'This history holds a commit or tree git would reject or read differently, or changes a .gitmodules or .gitattributes file; merge it with `dg pr merge` after checking it.',
      }
    case 'too-large':
      return { kind: 'unavailable', reason: 'This merge is too large to build in the browser; merge it with `dg pr merge`.' }
    case 'up-to-date':
      return { kind: 'unavailable', reason: 'The base branch already contains this head; record the merge with "Mark as merged".' }
    case 'unrelated':
      return { kind: 'unavailable', reason: 'The head and the base branch share no history.' }
  }
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
    if (holdings === null) {
      mergeHint = `Couldn't read this repo's ${ACL_NAME}, so merge permission is unknown.`
    } else if (pull.headOid === '') {
      mergeHint = 'This PR records no head commit to mark as merged.'
    } else {
      mergeHint = "Only this repo's maintainers and writers can mark a PR as merged."
    }
  }

  return {
    canMarkMerged,
    canCloseReopen,
    markCountsNow: pull.headOnBase,
    mergeHint,
  }
}

/**
 * The base tip a browser merge may build on (D-501), or `''` when there is none, which
 * {@link mergeRefProblem} refuses:
 * - the base must be a branch now (`currentTip`, the resolved branch; never the PR's historical
 *   tip): pushing to a deleted base would re-create it;
 * - the PR's own base must have been a branch when the PR was opened: its `baseTipOid` is empty
 *   otherwise (`prBaseTips`), and a merge event into it would never count;
 * - the PR must not have been retargeted: the fold checks a merge against the base the PR was
 *   opened with, so a merge into the new base would move that branch and never count
 *   ({@link mergeRefProblem} says what to do instead, as `dg pr merge` does).
 */
export function mergeBaseTip(
  pull: Pick<PullView, 'baseRefName' | 'baseTipOid'>,
  baseRefName: string,
  currentTip: string | null,
): string {
  if (currentTip === null || baseRefName !== pull.baseRefName || pull.baseTipOid === '') return ''
  return currentTip
}

/**
 * Why a PR cannot be merged in the browser before anything is read: the base must be a plain
 * branch that exists (`refs/heads/<name>`, check-ref-format; parity with `dg`'s
 * `require_branch_ref`) and the head a full commit id. Null when both hold.
 */
export function mergeRefProblem(
  baseRefName: string,
  baseTipOid: string,
  headOid: string,
  openedBaseRefName: string = baseRefName,
): string | null {
  if (baseRefName !== openedBaseRefName) {
    return 'This PR was retargeted, and a merge counts only into the base it was opened against. Merge it by hand into the new base, then record it with `dg pr merge --event-only --merge-oid <commit>`.'
  }
  if (!isPlainBranchRef(baseRefName)) return `The PR's base "${baseRefName.slice(0, 80)}" is not a plain branch (refs/heads/<name>); it is not merged in the browser.`
  if (!isOidHex(baseTipOid)) {
    return 'The base branch does not exist, or was not a branch when this PR was opened, so a merge into it would not count. Open a new PR against an existing branch.'
  }
  if (!isOidHex(headOid)) return 'The PR names no valid head commit.'
  return null
}
