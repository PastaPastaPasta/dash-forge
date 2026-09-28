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
 * Two branch rules then narrow it for a writer (`review-parity-spec.md` §4.8):
 *
 * - A **protected** base (its full ref name matches `config.protectedPatterns`): only a
 *   maintainer can move it (`protectedRefUpdate` is maintainer-gated at consensus, and a plain
 *   `refUpdate` there is inert), so a writer's merge could never land. Refused for writers.
 * - An unmet **branch policy** (`policy`, newest wins): a client rule. A writer's button is
 *   disabled; a maintainer is offered "Merge anyway (policy override)". Nothing at consensus
 *   requires approvals.
 *
 * Close/reopen stay available to the PR author as well (an `authorEvent`), but not to anyone
 * consensus would refuse.
 */

import { isOidHex, isPlainBranchRef, matchesProtected, type Holdings } from '../rules'
import type { Policy, PolicyStatus } from '../rules/v2'
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
  /** The base branch is protected (only maintainers can update it). */
  readonly baseProtected: boolean
  /**
   * The branch policy is not met and the viewer is a maintainer: the mark is offered as an
   * explicit override ("Merge anyway (policy override)").
   */
  readonly policyOverride: boolean
}

export interface PullActionInputs {
  readonly pull: Pick<PullView, 'author' | 'headOid' | 'headOnBase' | 'stateComplete' | 'state'> & {
    /** The full base ref (`refs/heads/main`); absent when unknown. */
    readonly baseRefName?: string
  }
  /** The signed-in identity, or null when logged out. */
  readonly viewer: string | null
  /**
   * The viewer's current permissions: `'loading'` until read, `null` when the membership could
   * not be read — permission unknown, controls withheld with a reason.
   */
  readonly holdings: Holdings | null | 'loading'
  /** `config.protectedPatterns` in force (empty or absent: nothing protected). */
  readonly protectedPatterns?: readonly string[]
  /**
   * How the PR's approvals stand against the branch policy; null or absent: no policy;
   * `'unknown'`: it could not be read, so a writer's merge is withheld (fail closed).
   */
  readonly policy?: PolicyStatus | null | 'unknown'
  /**
   * The branch policy requires passing checks (`requireChecks`) and the head's trusted check runs
   * are not all passing (none, pending or failing). A client rule like the approvals: a writer's
   * merge is withheld, a maintainer may override.
   */
  readonly checksBlocking?: boolean
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

/**
 * Why every write control is disabled in an archived repo. Archiving is a client rule
 * (`config.archived`): consensus still admits a member's writes, so the clients refuse them
 * (the CLI helper with E606).
 */
export const ARCHIVED_REASON = 'This repo is archived: it is read-only until a maintainer unarchives it.'

/**
 * The branch policy and its status as the PR page should use them. `approvals` null means the
 * approvals (and so the policy) could not be read: `'unknown'`, so a writer's merge is withheld
 * and the rules card says so, never "no policy".
 */
export function policyOf(
  approvals: { readonly policy: Policy | null | 'unknown'; readonly policyStatus: PolicyStatus | null | 'unknown' } | null,
): { policy: Policy | null | 'unknown'; status: PolicyStatus | null | 'unknown' } {
  return approvals === null ? { policy: 'unknown', status: 'unknown' } : { policy: approvals.policy, status: approvals.policyStatus }
}

/** Decide the PR controls for a viewer. Pure — the unit-tested core of the PR page gate. */
export function pullActions({ pull, viewer, holdings, protectedPatterns = [], policy = null, checksBlocking = false }: PullActionInputs): PullActions {
  const known = holdings !== null && holdings !== 'loading'
  const maintainer = known && holdings.maintain
  const holder = known && (holdings.write || holdings.maintain)
  const isAuthor = viewer !== null && viewer === pull.author
  const { merged, open } = pull.state
  // A PR whose event log was not read completely has no trustworthy state to act on.
  const actionable = pull.stateComplete && !merged
  const base = pull.baseRefName ?? ''
  const baseProtected = base !== '' && matchesProtected(base, protectedPatterns)
  const policyUnknown = policy === 'unknown'
  const policyUnmet = policyUnknown || (policy !== null && !policy.met) || checksBlocking

  const eligible = actionable && open && viewer !== null && holder && pull.headOid !== ''
  // A writer can neither move a protected base nor override the policy.
  const writerBlocked = !maintainer && (baseProtected || policyUnmet)
  const canMarkMerged = eligible && !writerBlocked
  const canCloseReopen = actionable && viewer !== null && (holder || isAuthor)

  let mergeHint: string | null = null
  if (!canMarkMerged && actionable && open && viewer !== null && holdings !== 'loading') {
    if (holdings === null) {
      mergeHint = `Couldn't read this repo's ${ACL_NAME}, so merge permission is unknown.`
    } else if (pull.headOid === '') {
      mergeHint = 'This PR records no head commit to mark as merged.'
    } else if (!holder) {
      mergeHint = "Only this repo's maintainers and writers can mark a PR as merged."
    } else if (baseProtected) {
      mergeHint = `${shortRef(base)} is a protected branch: only maintainers can merge into it.`
    } else if (policyUnknown) {
      mergeHint = "Couldn't read the branch policy, so only a maintainer can merge for now."
    } else if (policy !== null && typeof policy === 'object' && !policy.met) {
      mergeHint = `The branch policy needs ${policy.need} approval${policy.need === 1 ? '' : 's'} (${policy.have} so far). Only a maintainer can merge before then.`
    } else if (checksBlocking) {
      mergeHint = 'The branch policy requires passing checks on the head. Only a maintainer can merge before then.'
    }
  }

  return {
    canMarkMerged,
    canCloseReopen,
    markCountsNow: pull.headOnBase,
    mergeHint,
    baseProtected,
    policyOverride: canMarkMerged && maintainer && policyUnmet,
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
 *   ({@link mergeRefProblem} says to open a new PR instead, as `dg pr merge` does).
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
    return 'This PR was retargeted, and a merge counts only into the base it was opened against, so a merge into the new base would never show. Close it and open a new PR against the new base.'
  }
  if (!isPlainBranchRef(baseRefName)) return `The PR's base "${baseRefName.slice(0, 80)}" is not a plain branch (refs/heads/<name>); it is not merged in the browser.`
  if (!isOidHex(baseTipOid)) {
    return 'The base branch does not exist, or was not a branch when this PR was opened, so a merge into it would not count. Open a new PR against an existing branch.'
  }
  if (!isOidHex(headOid)) return 'The PR names no valid head commit.'
  return null
}

/**
 * Why "Delete the branch after merging" cannot delete the PR's source branch, or null when it
 * can. Refused, as `dg pr merge --delete-branch` refuses (`deletable_source`), for the base branch
 * itself and the source repo's default branch; and, beyond dg, unless the branch still points at
 * the PR head that was merged: a commit pushed after it would be lost. `defaultBranch` null: it
 * could not be read, so the branch might be the default one: refused (it fails closed). `tip`
 * undefined: not read yet (only the fixed refusals apply); null: the branch is already gone.
 */
export function deleteBranchProblem(i: {
  readonly refName: string
  readonly sameRepo: boolean
  readonly baseRefName: string
  readonly defaultBranch: string | null
  readonly headOid: string
  readonly tip?: string | null
}): string | null {
  const name = shortRef(i.refName)
  if (i.sameRepo && i.refName === i.baseRefName) return "the PR's source branch is its base branch"
  const d = i.defaultBranch
  if (d === null || d === '') return `the source repo's default branch could not be read, so ${name} is not deleted`
  if (i.refName === d || i.refName === `refs/heads/${d}`) return `${name} is the source repo's default branch`
  if (i.tip === undefined || i.tip === null) return null
  if (i.tip.toLowerCase() !== i.headOid.toLowerCase()) return `${name} moved to ${i.tip.slice(0, 9)} after the merged head; not deleted, so those commits are kept`
  return null
}

function shortRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
