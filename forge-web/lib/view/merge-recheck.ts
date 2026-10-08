/**
 * The merge gate ({@link pullActions}) judged again when the merge is clicked, against the repo's
 * membership (and, when a required check is counted, its runners) read then, uncached. The page's
 * own reads can be minutes old: a member revoked since must not carry a merge (as the merger, as a
 * counted approver, or as a trusted check reporter), and a maintainer made a writer must not
 * bypass the branch rules. The reviews, the policy, the check runs and the code owners file are the
 * page's; the approvals they count are judged again with the members read at the click.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { readRunnersFresh } from '../repo/checks'
import type { RepoRef } from '../repo/contract'
import { holdingsOfRole, readMembershipsFresh } from '../repo/members'
import { checksState, type CheckRunRow } from '../rules/parity'
import { meetsPolicy, RoleOracle, type Approvals, type ChecksState, type CodeOwnerStatus, type Membership, type Policy, type PolicyStatus } from '../rules/v2'
import { pullActions, type PullActionInputs } from './pull-actions'

export interface MergeRecheck {
  /** The gate's inputs as the page judged them, less the four that follow the membership. */
  readonly gate: Omit<PullActionInputs, 'holdings' | 'policy' | 'checks' | 'codeOwners'>
  /** The branch policy in force (null: none; `'unknown'`: unread). */
  readonly policy: Policy | null | 'unknown'
  /** How the page found the approvals stand against it. */
  readonly status: PolicyStatus | null | 'unknown'
  /** The page's approval fold on the head (null: the page could not read the members). */
  readonly approvals: Approvals | null
  /**
   * The head's required checks (null: none required), trusting the reporters `oracle` holds and
   * `runners` (null: the page's runners, when {@link readsRunners} is false).
   */
  readonly checks: (oracle: RoleOracle, runners: ReadonlySet<string> | null) => ChecksState | null | 'unknown'
  /** The checks count runners' runs: read the runners again too. */
  readonly readsRunners: boolean
  /**
   * Where the PR stands against `requireCodeOwners` with `members` (null: not required). Absent:
   * not required.
   */
  readonly codeOwners?: (members: readonly Membership[]) => CodeOwnerStatus | null | 'unknown'
  /** The rules the merger confirmed bypassing (empty: none). */
  readonly bypass: readonly string[]
}

const CHANGED = 'Something changed since the page loaded.'

/**
 * Why the merge must stop under `members` (the membership now) and `runners` (null: the page's),
 * or null: the viewer can no longer merge, or the rules left unmet are not exactly the ones the
 * merger confirmed bypassing.
 */
export function mergeMembersProblem(members: readonly Membership[], r: MergeRecheck, runners: ReadonlySet<string> | null = null): string | null {
  const oracle = new RoleOracle([...members])
  const status = r.approvals !== null && r.policy !== null && r.policy !== 'unknown' ? meetsPolicy(r.approvals, oracle, r.policy) : r.status
  const role = r.gate.viewer === null ? null : oracle.currentRole(r.gate.viewer)
  const now = pullActions({ ...r.gate, holdings: holdingsOfRole(role), policy: status, checks: r.checks(oracle, runners), codeOwners: r.codeOwners?.(members) ?? null })
  if (!now.canMerge) return `${CHANGED} ${now.mergeHint ?? 'You can no longer merge this pull request.'}`
  if (now.unmetRules.length === r.bypass.length && now.unmetRules.every((rule, i) => rule === r.bypass[i])) return null
  // The merge box lists the rules as they stand now (the page re-reads on a refusal).
  if (r.bypass.length === 0) return `${CHANGED} The branch rules are no longer met. Review the pull request and try again.`
  return `${CHANGED} The branch rules to bypass are different now. Review them and try again.`
}

/** The error a merge stops with when the members or runners cannot be read: whether it may go ahead is unknown. */
export const MERGE_UNCONFIRMED = "Couldn't confirm the merge. Try again."

/** The refusal when there is no Platform connection to read the members with. */
export const MERGE_OFFLINE = "Couldn't confirm the merge because Platform isn't connected yet. Try again."

/**
 * {@link mergeMembersProblem} with the membership (and the runners, {@link MergeRecheck.readsRunners})
 * read now. Both reads land in their caches, so the page's next read shows them.
 *
 * @throws Error ({@link MERGE_UNCONFIRMED}) when they cannot be read: the caller stops the merge.
 */
export async function recheckMergeMembers(sdk: EvoSDK, repo: RepoRef, network: Network, r: MergeRecheck): Promise<string | null> {
  const [members, runners] = await Promise.all([
    readMembershipsFresh(sdk, repo, network),
    r.readsRunners ? readRunnersFresh(sdk, repo).then((ids) => new Set(ids)) : null,
  ]).catch(() => {
    throw new Error(MERGE_UNCONFIRMED)
  })
  return mergeMembersProblem(members, r, runners)
}

/** The pull page's reads behind its merge gate, as {@link pageMergeRecheck} takes them. */
export interface PageMerge {
  readonly gate: MergeRecheck['gate']
  /** The branch policy in force (null: none; `'unknown'`: unread). */
  readonly policy: Policy | null | 'unknown'
  readonly status: PolicyStatus | null | 'unknown'
  readonly approvals: Approvals | null
  /** The head's required checks as the page judged them (null: none required; `'unknown'`: unread). */
  readonly requiredChecks: ChecksState | null | 'unknown'
  /** The head's check runs and the runners the page read (null: not read yet). */
  readonly checkRuns: { readonly rows: readonly CheckRunRow[]; readonly runners: ReadonlySet<string> } | null
  /** The page's code owner rule, judged with given members ({@link MergeRecheck.codeOwners}); absent: not required. */
  readonly codeOwners?: MergeRecheck['codeOwners']
}

/**
 * The recheck of the page's merge gate, `bypass` the rules confirmed bypassed. Required checks the
 * page counted are judged again with the members (and the runners) read at the click; an unread
 * or absent requirement stays as the page judged it, and no runners are read for it.
 */
export function pageMergeRecheck(page: PageMerge, bypass: readonly string[]): MergeRecheck {
  const { policy, requiredChecks, checkRuns } = page
  const counted = requiredChecks !== null && requiredChecks !== 'unknown' && checkRuns !== null && policy !== null && policy !== 'unknown' ? { runs: checkRuns, policy } : null
  return {
    gate: page.gate,
    policy,
    status: page.status,
    approvals: page.approvals,
    checks: (oracle, runners) => (counted === null ? requiredChecks : checksState(counted.runs.rows, page.gate.pull.headOid, oracle, runners ?? counted.runs.runners, counted.policy)),
    readsRunners: counted !== null,
    ...(page.codeOwners === undefined ? {} : { codeOwners: page.codeOwners }),
    bypass,
  }
}

/**
 * The pull page's merge recheck ({@link recheckMergeMembers} of {@link pageMergeRecheck}): a
 * refusal ({@link MERGE_OFFLINE}) with no Platform connection to read with.
 */
export function recheckPageMerge(sdk: EvoSDK | null, repo: RepoRef, network: Network, page: PageMerge, bypass: readonly string[]): Promise<string | null> {
  if (sdk === null) return Promise.resolve(MERGE_OFFLINE)
  return recheckMergeMembers(sdk, repo, network, pageMergeRecheck(page, bypass))
}

/**
 * "Mark as merged (done elsewhere)" under the confirm's `intent`: judge the merge again
 * (`recheck(bypass)`), record it (`merge`, the merge transition), then the bypass's record
 * (`recordBypass(bypass)`, when `bypass` names rules). `landed` holds the intent whose transition
 * landed: a retry of that intent (the record failed) neither judges nor writes the merge again,
 * as it is recorded and final, and only the record is retried. Any other intent starts afresh.
 */
export async function markMerged(run: {
  readonly intent: string
  readonly bypass: readonly string[]
  readonly landed: { current: string | null }
  readonly recheck: (bypass: readonly string[]) => Promise<string | null>
  readonly merge: () => Promise<unknown>
  readonly recordBypass: (bypass: readonly string[]) => Promise<unknown>
  /** Platform's answer, worded for the person (the write guard's `failed`). */
  readonly describe: (e: unknown) => string
}): Promise<void> {
  if (run.landed.current !== run.intent) {
    const problem = await run.recheck(run.bypass)
    if (problem !== null) throw new Error(problem)
    await run.merge()
    run.landed.current = run.intent
  }
  if (run.bypass.length === 0) return
  try {
    await run.recordBypass(run.bypass)
  } catch (e) {
    throw new Error(`The merge is recorded, but recording the rules bypass failed: ${run.describe(e)} Retry to record it.`)
  }
}
