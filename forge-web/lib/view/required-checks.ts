/**
 * The branch policy's required status checks as the settings editor edits them (RC1 R-08):
 * `policy.requiredChecks`, at most 10 distinct names, paired by position with
 * `requiredCheckSources`, one runner or maintainer id each.
 *
 * The contract's `sourcesMatchNames` takes either no sources at all or exactly one per name, so
 * the editor does not offer a per-row "any source": one switch pins every check to a reporter or
 * none, and with it on every row must name one. Each source must hold a `runner` or `maintainer`
 * document of the repo (`refersTo`, re-checked at consensus on every save), so a writer is never
 * offered. The same rules `policyData` / `setPolicy` refuse before signing (`lib/repo/review-writes.ts`).
 *
 * Pure: the unit-tested core of the editor in `components/repo/repo-settings-sections.tsx`.
 */

import type { Membership, Policy } from '../rules/v2'

/** The contract's cap on `requiredChecks` (and `requiredCheckSources`). */
export const MAX_REQUIRED_CHECKS = 10
/** The contract's caps on one check name: 100 characters and 200 UTF-8 bytes. */
export const CHECK_NAME_MAX_CHARS = 100
export const CHECK_NAME_MAX_BYTES = 200

/** One required check as edited: its name and (when pinning) its source's id, `''` for none yet. */
export interface CheckRow {
  /**
   * The row's own key, for the list (never saved): a removed row takes its focus with it, not the
   * next row's. Stable for a policy's rows, which the editor re-derives on every render.
   */
  readonly key: string
  readonly name: string
  readonly source: string
}

let added = 0

/** A new, empty row. */
export function newCheckRow(): CheckRow {
  added += 1
  return { key: `new-${added}`, name: '', source: '' }
}

/** The editor's required checks. */
export interface RequiredChecksDraft {
  readonly rows: readonly CheckRow[]
  /** Every check is pinned to a reporter (`requiredCheckSources` set), or none is. */
  readonly pinned: boolean
}

/** The required checks of `policy`, as the editor starts from them. */
export function draftOfPolicy(policy: Pick<Policy, 'requiredChecks' | 'requiredCheckSources'>): RequiredChecksDraft {
  const names = policy.requiredChecks ?? []
  const sources = policy.requiredCheckSources ?? []
  // `toPolicy` keeps sources only when they pair one for one with the names.
  const pinned = sources.length > 0 && sources.length === names.length
  return { rows: names.map((name, i) => ({ key: `policy-${i}`, name, source: pinned ? sources[i] ?? '' : '' })), pinned }
}

/** A reporter a check can be pinned to, and what makes it one. */
export interface SourceOption {
  readonly id: string
  readonly runner: boolean
  readonly maintainer: boolean
}

/** The repo's runners and maintainers (never writers: the contract refers a source to one of those two). */
export function sourceOptions(members: readonly Membership[], runners: readonly string[]): SourceOption[] {
  const maintainers = new Set(members.filter((m) => m.role === 'maintainer').map((m) => m.identity))
  const runnerSet = new Set(runners)
  return [...new Set([...maintainers, ...runnerSet])]
    .filter((id) => id !== '')
    .sort()
    .map((id) => ({ id, runner: runnerSet.has(id), maintainer: maintainers.has(id) }))
}

/** "runner", "maintainer" or "runner and maintainer". */
export function sourceRole(o: Pick<SourceOption, 'runner' | 'maintainer'>): string {
  if (o.runner && o.maintainer) return 'runner and maintainer'
  return o.runner ? 'runner' : 'maintainer'
}

/** What is wrong with a draft: per row (null: fine) and for the whole list (null: fine). */
export interface ChecksProblems {
  readonly rows: readonly (string | null)[]
  readonly form: string | null
}

/** Whether `p` finds nothing wrong. */
export function checksOk(p: ChecksProblems): boolean {
  return p.form === null && p.rows.every((r) => r === null)
}

function nameProblem(name: string): string | null {
  if (name === '') return 'Name the check (as its runs report it)'
  if ([...name].length > CHECK_NAME_MAX_CHARS) return `At most ${CHECK_NAME_MAX_CHARS} characters`
  if (new TextEncoder().encode(name).length > CHECK_NAME_MAX_BYTES) return `At most ${CHECK_NAME_MAX_BYTES} bytes`
  return null
}

/**
 * Check `draft` against the contract: names non-empty, within the caps and distinct; at most
 * {@link MAX_REQUIRED_CHECKS}; when pinned, a source on every row, each one of `valid` (the
 * repo's current runners and maintainers; null while unknown, when nothing is flagged for it
 * and `setPolicy` re-checks before signing).
 */
export function requiredChecksProblems(draft: RequiredChecksDraft, valid: ReadonlySet<string> | null): ChecksProblems {
  const names = draft.rows.map((r) => r.name.trim())
  const seen = new Map<string, number>()
  names.forEach((n) => seen.set(n, (seen.get(n) ?? 0) + 1))
  const rows = draft.rows.map((r, i) => {
    const name = names[i] ?? ''
    const bad = nameProblem(name)
    if (bad !== null) return bad
    if ((seen.get(name) ?? 0) > 1) return 'Each check is named once'
    if (!draft.pinned) return null
    if (r.source === '') return 'Pick the runner or maintainer this check must come from'
    if (valid !== null && !valid.has(r.source)) return 'No longer a runner or maintainer of this repo: pick another source'
    return null
  })
  const form = draft.rows.length > MAX_REQUIRED_CHECKS ? `At most ${MAX_REQUIRED_CHECKS} required checks` : null
  return { rows, form }
}

/** `policy` with the draft's required checks: names trimmed, sources only when pinned (all or none). */
export function policyWithChecks(policy: Policy, draft: RequiredChecksDraft): Policy {
  const { requiredChecks: _names, requiredCheckSources: _sources, ...rest } = policy
  const names = draft.rows.map((r) => r.name.trim())
  if (names.length === 0) return rest
  return {
    ...rest,
    requiredChecks: names,
    ...(draft.pinned ? { requiredCheckSources: draft.rows.map((r) => r.source) } : {}),
  }
}

/** The two policies say the same thing, field by field (an absent field reads as its default). */
export function samePolicy(a: Policy, b: Policy): boolean {
  return (
    a.requiredApprovals === b.requiredApprovals &&
    (a.approverRole ?? 0) === (b.approverRole ?? 0) &&
    (a.requireChecks ?? false) === (b.requireChecks ?? false) &&
    (a.mergeMethods ?? 0) === (b.mergeMethods ?? 0) &&
    sameRequiredChecks(a, b)
  )
}

/** The two policies require the same checks from the same sources, in the same order. */
export function sameRequiredChecks(a: Pick<Policy, 'requiredChecks' | 'requiredCheckSources'>, b: Pick<Policy, 'requiredChecks' | 'requiredCheckSources'>): boolean {
  const eq = (x: readonly string[] = [], y: readonly string[] = []): boolean => x.length === y.length && x.every((v, i) => v === y[i])
  return eq(a.requiredChecks, b.requiredChecks) && eq(a.requiredCheckSources, b.requiredCheckSources)
}
