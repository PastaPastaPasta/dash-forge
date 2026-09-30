/**
 * Platform-parity rules (`docs/design/platform-parity-spec.md` §2.6, §1.2, §4; part of
 * FORGE_RULES_V2). TypeScript port of `crates/forge-core/src/rules/parity.rs`, function for
 * function; the `"rules": "v2"` vectors `checks__*`, `thread_meta__*`, `pinned__*`,
 * `milestones__*` and `trending__*` hold the two in parity.
 *
 * - {@link checksState}: whether a head's check runs meet a branch policy's required checks.
 * - {@link foldThreadMetaV2}: an issue's or PR's milestone, pinned and locked state (kinds 17–22).
 * - {@link pinnedTargets}: the repo's pinned issues and PRs, from its event feed.
 * - {@link foldMilestonesV2}: a repo's milestones with their open and closed counts.
 * - {@link trendingWindow} / {@link trendingRecount}: the window a trending read covers and the
 *   ranking it proves, recomputed from the beats themselves.
 */

import { compareKey, compareStrings } from './oid'
import type { RoleOracle } from './v2'
import type { Event } from './types'

// ---------------------------------------------------------------------------
// Required checks
// ---------------------------------------------------------------------------

/** One `checkRun` document, flattened. */
export interface CheckRunRow {
  readonly id: string
  /** `headOid`, hex. */
  readonly headOid: string
  readonly name: string
  /** `queued` | `in_progress` | `completed`. */
  readonly status: string
  /** The outcome once completed; absent before. */
  readonly conclusion?: string | null
  /** `$ownerId`. */
  readonly reporter: string
  readonly createdAt: number
}

/** What a branch `policy` says about checks. */
export interface ChecksPolicy {
  /** Every reported check must pass, and at least one must be reported. */
  readonly requireChecks?: boolean
  /** These checks must be reported and pass (overrides "every reported check" when set). */
  readonly requiredChecks?: readonly string[]
  /**
   * The identity (a runner or a maintainer, base58) each required check must come from, paired
   * by position with `requiredChecks` (RC1 R-08); empty: any trusted reporter counts.
   */
  readonly requiredCheckSources?: readonly string[]
}

export type CheckState = 'passed' | 'failing' | 'pending' | 'missing'

export interface RequiredCheck {
  readonly name: string
  readonly state: CheckState
  /** The deciding run's `$id`. */
  readonly runId: string | null
}

export interface ChecksState {
  /** The checks the policy requires, by name (code-point order). */
  readonly required: readonly RequiredCheck[]
  readonly met: boolean
  /** Runs on the head not counted: their reporter is no longer a maintainer, writer or runner. */
  readonly untrusted: number
}

/**
 * Each pinned check name and the sources that may decide it: empty unless `requiredCheckSources`
 * pairs up with `requiredChecks` one for one; an empty name or source pins nothing. Parity:
 * forge-core `pinned_sources`.
 */
export function pinnedSources(policy: ChecksPolicy): Map<string, Set<string>> {
  const names = policy.requiredChecks ?? []
  const sources = policy.requiredCheckSources ?? []
  const pins = new Map<string, Set<string>>()
  if (sources.length !== names.length) return pins
  names.forEach((name, i) => {
    const source = sources[i] as string
    if (name === '' || source === '') return
    pins.set(name, (pins.get(name) ?? new Set()).add(source))
  })
  return pins
}

/** The conclusions that pass a required check. */
export const PASSING_CONCLUSIONS: readonly string[] = ['success', 'neutral', 'skipped']

/**
 * A run's `outcome` (RC1 O-07 `outcomeOf`): 0 not completed, 1 completed with a passing
 * conclusion, 2 completed otherwise. Consensus refuses a run whose `outcome` disagrees.
 */
export function checkRunOutcome(status: string, conclusion: string | null | undefined): 0 | 1 | 2 {
  if (status !== 'completed') return 0
  return PASSING_CONCLUSIONS.includes(conclusion ?? '') ? 1 : 2
}

function checkStateOf(run: CheckRunRow): CheckState {
  if (run.status !== 'completed') return 'pending'
  return PASSING_CONCLUSIONS.includes(run.conclusion ?? '') ? 'passed' : 'failing'
}

/**
 * Whether the check runs on `headOid` meet `policy`. A run counts only when its reporter is a
 * current maintainer or writer (`oracle`) or a current runner (`runners`); the newest counting
 * run per name by `($createdAt, $id)` decides it. `requiredChecks` names what must pass;
 * otherwise `requireChecks` means every counting name must pass and at least one exist. A
 * required check with a pinned source (`requiredCheckSources`, by position) counts only that
 * source's runs. A client rule for the merge box, never consensus. Parity: forge-core `checks_state`.
 */
export function checksState(
  runs: readonly CheckRunRow[],
  headOid: string,
  oracle: RoleOracle,
  runners: ReadonlySet<string>,
  policy: ChecksPolicy,
): ChecksState {
  const trusted = (who: string) => oracle.currentRole(who) !== null || runners.has(who)
  const pinned = pinnedSources(policy)
  const newest = new Map<string, CheckRunRow>()
  let untrusted = 0
  const head = headOid.toLowerCase()
  for (const run of runs) {
    if (run.headOid.toLowerCase() !== head || run.name === '') continue
    if (!trusted(run.reporter)) {
      untrusted += 1
      continue
    }
    const sources = pinned.get(run.name)
    if (sources !== undefined && !sources.has(run.reporter)) continue
    const held = newest.get(run.name)
    if (held === undefined || compareKey(run, held) > 0) newest.set(run.name, run)
  }
  // An empty name names nothing (the schema refuses one; a reader's input may not).
  const named = (policy.requiredChecks ?? []).filter((n) => n !== '')
  const requireAll = named.length === 0 && policy.requireChecks === true
  const names = [...new Set(requireAll ? newest.keys() : named)].sort(compareStrings)
  const required: RequiredCheck[] = names.map((name) => {
    const run = newest.get(name)
    return run === undefined ? { name, state: 'missing', runId: null } : { name, state: checkStateOf(run), runId: run.id }
  })
  const allPass = required.every((c) => c.state === 'passed')
  return { required, met: allPass && !(requireAll && required.length === 0), untrusted }
}

// ---------------------------------------------------------------------------
// Milestone, pin, lock (event kinds 17–22)
// ---------------------------------------------------------------------------

export interface ThreadMeta {
  readonly milestone: string | null
  readonly pinned: boolean
  /** When the standing pin was made (ms). */
  readonly pinnedAt: number | null
  /** Locked: clients offer the composer to members only. */
  readonly locked: boolean
}

/**
 * Fold a target's member `event`s into its {@link ThreadMeta}: milestone set/clear (17/18) and
 * pin/unpin/lock/unlock (19–22), members' kinds only (an `authorEvent` cannot carry them). The
 * newest of each pair by `($createdAt, $id)` stands; a milestone set without a value is inert.
 */
export function foldThreadMetaV2(events: readonly Event[]): ThreadMeta {
  let milestone: string | null = null
  let pinned = false
  let pinnedAt: number | null = null
  let locked = false
  for (const e of [...events].sort(compareKey)) {
    switch (e.kind) {
      case 'milestoneSet':
        if (e.value) milestone = e.value
        break
      case 'milestoneClear':
        milestone = null
        break
      case 'pin':
        pinned = true
        pinnedAt = e.createdAt
        break
      case 'unpin':
        pinned = false
        pinnedAt = null
        break
      case 'lock':
        locked = true
        break
      case 'unlock':
        locked = false
        break
      default:
        break
    }
  }
  return { milestone, pinned, pinnedAt, locked }
}

export interface PinnedTarget {
  readonly targetId: string
  readonly pinnedAt: number
}

/** The pinned issues and PRs among a repo's member events: newest pin first, ties by target id. */
export function pinnedTargets(events: readonly Event[]): PinnedTarget[] {
  const state = new Map<string, number | null>()
  for (const e of [...events].filter((x) => (x.kind === 'pin' || x.kind === 'unpin') && x.targetId).sort(compareKey)) {
    state.set(e.targetId as string, e.kind === 'pin' ? e.createdAt : null)
  }
  return [...state.entries()]
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([targetId, pinnedAt]) => ({ targetId, pinnedAt }))
    .sort((a, b) => b.pinnedAt - a.pinnedAt || compareStrings(a.targetId, b.targetId))
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/** One `milestone` document, flattened (decrypted first in a private repo). */
export interface MilestoneDoc {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly dueOn?: number | null
  readonly closed?: boolean
  readonly createdAt: number
}

/** What a milestone holds: one issue or PR, its fold's `open` and milestone. */
export interface MilestoneItem {
  readonly open: boolean
  readonly milestone?: string | null
}

export interface Milestone {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly dueOn: number | null
  readonly closed: boolean
  readonly open: number
  readonly closedItems: number
}

/**
 * A repo's milestones: the newest definition per title by `($createdAt, $id)`, each with the
 * open and closed counts of the items in it. Sorted by title (code-point order).
 */
export function foldMilestonesV2(docs: readonly MilestoneDoc[], items: readonly MilestoneItem[]): Milestone[] {
  const newest = new Map<string, MilestoneDoc>()
  for (const d of docs) {
    if (d.title === '') continue
    const held = newest.get(d.title)
    if (held === undefined || compareKey(d, held) > 0) newest.set(d.title, d)
  }
  const counts = new Map<string, { open: number; closed: number }>()
  for (const item of items) {
    if (!item.milestone) continue
    const c = counts.get(item.milestone) ?? { open: 0, closed: 0 }
    if (item.open) c.open += 1
    else c.closed += 1
    counts.set(item.milestone, c)
  }
  return [...newest.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([title, d]) => ({
      id: d.id,
      title,
      description: d.description ?? '',
      dueOn: d.dueOn ?? null,
      closed: d.closed === true,
      open: counts.get(title)?.open ?? 0,
      closedItems: counts.get(title)?.closed ?? 0,
    }))
}

// ---------------------------------------------------------------------------
// Trending
// ---------------------------------------------------------------------------

/** A `timeRange` grid, in seconds. */
export interface TimeGrid {
  readonly range: number
  readonly step: number
  readonly phase?: number
}

/** forge-collab `starBeat.byWeek`: seven-day windows starting every day at 00:00 UTC. */
export const STAR_BEAT_GRID: TimeGrid = { range: 604_800, step: 86_400, phase: 0 }

/** `newest`: today so far; `oldest`: a near-full trailing week; `all`: every star. */
export type TrendingSelector = 'newest' | 'oldest' | 'all'

export interface Window {
  readonly start: number
  readonly end: number
}

/**
 * The window `selector` names at `nowMs` on `grid`, as rs-dpp resolves it (`most_recent_start`,
 * `oldest_active_start`). Null for `all`, a zero step, or `now` before the phase.
 */
export function trendingWindow(grid: TimeGrid, nowMs: number, selector: TrendingSelector): Window | null {
  const range = grid.range * 1000
  const step = grid.step * 1000
  const phase = (grid.phase ?? 0) * 1000
  if (step === 0 || nowMs < phase || selector === 'all') return null
  const back = selector === 'newest' ? 0 : Math.max(Math.floor(range / step) - 1, 0) * step
  const newest = phase + Math.floor((nowMs - phase) / step) * step
  const start = Math.max(newest - back, phase)
  return { start, end: start + range }
}

/** One star (or trending beat): the repo id as hex (the ranked group key) and when it was written. */
export interface StarBeat {
  readonly repo: string
  readonly createdAt: number
}

export interface TrendingEntry {
  /** The repo id, hex (lowercase). */
  readonly repo: string
  readonly count: number
}

/**
 * The ranking a `documents.ranked` read proves, recomputed from the beats: count per repo inside
 * the window (all beats for `all`), highest first, equal counts by repo id descending (the
 * ranked secondary's descending walk), at most `limit` rows.
 */
export function trendingRecount(beats: readonly StarBeat[], grid: TimeGrid, nowMs: number, selector: TrendingSelector, limit: number): TrendingEntry[] {
  const window = trendingWindow(grid, nowMs, selector)
  if (window === null && selector !== 'all') return []
  const counts = new Map<string, number>()
  for (const b of beats) {
    if (b.repo === '') continue
    if (window !== null && (b.createdAt < window.start || b.createdAt >= window.end)) continue
    const repo = b.repo.toLowerCase()
    counts.set(repo, (counts.get(repo) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || compareStrings(b.repo, a.repo))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Check-run reports: monotonic status and times
// ---------------------------------------------------------------------------

/** The stored run a report would update, as the monotonic rules read it. */
export interface StoredRun {
  readonly status: string
  readonly startedAt?: number | null
  readonly completedAt?: number | null
  readonly conclusion?: string | null
  readonly externalId?: string | null
}

/** What a reporter says now. */
export interface RunReport {
  readonly status: string
  readonly conclusion?: string | null
  readonly startedAt?: number | null
  readonly completedAt?: number | null
  readonly externalId?: string | null
}

/** The write a report makes; on a replace only a field the stored run lacks is set (null keeps it). */
export interface RunWrite {
  readonly action: 'create' | 'replace'
  readonly startedAt: number | null
  readonly completedAt: number | null
  readonly conclusion: string | null
  readonly externalId: string | null
}

const STATUS_RANK: ReadonlyMap<string, number> = new Map([
  ['queued', 0],
  ['in_progress', 1],
  ['completed', 2],
])

/** Whether `stored` can take the report as a replace (parity: forge-core `continues`). */
function continues(stored: StoredRun, report: RunReport, rank: number): boolean {
  const held = STATUS_RANK.get(stored.status)
  if (held === undefined) return false
  const sameRun = stored.externalId == null || report.externalId == null || stored.externalId === report.externalId
  const conclusionKept = stored.conclusion == null || stored.conclusion === (report.conclusion ?? null)
  return sameRun && rank >= held && conclusionKept
}

/**
 * The write that records `report` against `stored` at `nowMs`, so the forge-community `checkRun`
 * rules hold (D-5): a conclusion with `completed` and only with it; `startedAt` on the first
 * non-queued report, `completedAt` on the first completed one (the CI's own time when given,
 * never before the start); a stored time, conclusion or `externalId` never changed or dropped;
 * a backwards move, a changed conclusion or another `externalId` is a new run. Null when
 * consensus would refuse the report whatever is stored. Parity: forge-core `check_run_write`.
 */
export function checkRunWrite(stored: StoredRun | null, report: RunReport, nowMs: number): RunWrite | null {
  const rank = STATUS_RANK.get(report.status)
  if (rank === undefined) return null
  if ((rank === 2) !== (report.conclusion != null)) return null
  const keeps = stored !== null && continues(stored, report, rank)
  const heldStart = keeps ? stored.startedAt ?? null : null
  const heldEnd = keeps ? stored.completedAt ?? null : null
  const start = heldStart ?? (rank >= 1 ? report.startedAt ?? nowMs : null)
  let end = heldEnd
  if (end === null && rank === 2) {
    const e = report.completedAt ?? nowMs
    end = start === null ? e : Math.max(e, start)
  }
  const unset = (held: string | null | undefined, given: string | null | undefined): string | null => (keeps && held != null ? null : given ?? null)
  return {
    action: keeps ? 'replace' : 'create',
    startedAt: heldStart !== null ? null : start,
    completedAt: heldEnd !== null ? null : end,
    conclusion: unset(stored?.conclusion, report.conclusion),
    externalId: unset(stored?.externalId, report.externalId),
  }
}
