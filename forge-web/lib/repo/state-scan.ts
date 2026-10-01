/**
 * The state scan: a repo's `transition` documents read newest first through the `feed` index
 * (`repoId, $createdAt`), 100 per request. A transition is a small document (no title or body),
 * so the scan reads a repo's recent state changes for a fraction of what reading its issues or
 * PRs costs; a list tab whose rows are few and old (the Open PRs of a mirror with thousands of
 * merged ones, QW3-002) finds them through it rather than through every row above them.
 *
 * What a scan proves, newest first (consensus accepts a transition only as a legal move, rules
 * `c1`–`c5` of the registered contract, `forge-collab.json`):
 *
 * - **A target's current state** is the state its newest state-moving transition leaves it in
 *   (`close` → closed, `merge` → merged, `reopen` / `ready` → open, `draft` → draft, …); lock
 *   and unlock leave the state as it was. Reading newest first, the first state-moving
 *   transition the scan meets for a target is its newest, once the scan has read past it
 *   ({@link settledCode}).
 * - **An issue or PR created after the watermark** (`$createdAt` greater than the oldest
 *   transition read) has every one of its transitions read: a transition is written after its
 *   target. Numbers are dense in creation order (the `dense` rule: a new issue or PR carries the
 *   repo's issue and PR totals plus one), so every number above such a row's was created after
 *   it too: a number above it that no transition names is open and was never closed.
 *
 * The scan only nominates rows: each is then read by id or number with its proved state sum,
 * and a page is complete only by the proved counts or the watermark rule above
 * (`./target-index` `scanSelect`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { ISSUE_CLOSE, ISSUE_REOPEN, PR_CLOSE, PR_DRAFT, PR_DRAFT_CLOSE, PR_DRAFT_REOPEN, PR_MERGE, PR_READY, PR_REOPEN } from '../rules/transition'
import { DOC, asIdentifierString, num, str, type RepoRef } from './contract'
import { repoSource } from './source'

/** Transitions per scan request (Drive's page limit). */
export const SCAN_PAGE = 100

/** The state code a state-moving transition of `kind` leaves its target in (the contract's `c1`–`c5`), or null (a lock). */
export function codeAfter(kind: number): number | null {
  switch (kind) {
    case ISSUE_CLOSE:
    case PR_CLOSE:
      return 1
    case ISSUE_REOPEN:
    case PR_REOPEN:
    case PR_READY:
      return 0
    case PR_MERGE:
      return 2
    case PR_DRAFT:
    case PR_DRAFT_REOPEN:
      return 8
    case PR_DRAFT_CLOSE:
      return 9
    default:
      return null
  }
}

/** What the scan knows of one target. */
export interface ScanTarget {
  readonly id: string
  readonly number: number
  /** `targetKind`: 0 an issue, 1 a PR. */
  readonly kind: number
  /**
   * The state its newest state-moving transition read leaves it in; null when only lock
   * transitions are read so far, or when two state moves share its newest timestamp (their order
   * is not knowable from the scan; the proved sum decides).
   */
  code: number | null
  /** That transition's `$createdAt`. */
  newest: number
}

/** A repo's state scan (mutable while it reads). */
export interface StateScan {
  readonly targets: Map<string, ScanTarget>
  /** Target ids by number. */
  readonly byNumber: Map<number, string>
  /** Transition ids read (a page re-reads its boundary timestamp). */
  readonly seen: Set<string>
  /** Every transition created after this is read; null before the first page. */
  watermark: number | null
  /** The scan reached the repo's first transition. */
  done: boolean
  /** False when it stopped on a timestamp shared by 100 or more transitions. */
  complete: boolean
  /** Requests made. */
  pages: number
  /** The target numbers of the oldest page read, ascending (where reliable coverage ends). */
  edge: number[]
}

export function newScan(): StateScan {
  return { targets: new Map(), byNumber: new Map(), seen: new Set(), watermark: null, done: false, complete: true, pages: 0, edge: [] }
}

/**
 * A target's state as the scan proves it, or null when the scan cannot tell yet: its newest
 * state-moving transition is read only once the scan is past that transition's timestamp (a page
 * may end inside a timestamp it shares with other transitions).
 */
export function settledCode(scan: StateScan, t: ScanTarget): number | null {
  if (t.code === null) return null
  return scan.done || (scan.watermark !== null && t.newest > scan.watermark) ? t.code : null
}

/** Record one page of transitions, newest first. */
export function recordScanPage(scan: StateScan, docs: readonly PlainDocument[]): void {
  const before = scan.seen.size
  for (const d of docs) {
    const id = str(d, '$id')
    if (id === '' || scan.seen.has(id)) continue
    scan.seen.add(id)
    const targetId = asIdentifierString(d['targetId'])
    if (targetId === '') continue
    const createdAt = num(d, '$createdAt')
    const code = codeAfter(num(d, 'kind'))
    let t = scan.targets.get(targetId)
    if (t === undefined) {
      t = { id: targetId, number: num(d, 'targetNumber'), kind: num(d, 'targetKind'), code: null, newest: -Infinity }
      scan.targets.set(targetId, t)
      scan.byNumber.set(t.number, targetId)
    }
    if (code === null) continue
    if (t.newest === -Infinity) {
      t.code = code
      t.newest = createdAt
    } else if (createdAt === t.newest) {
      // Two state moves in one block: their order is not knowable here.
      t.code = null
    }
  }
  scan.pages++
  if (docs.length < SCAN_PAGE) {
    scan.done = true
    return
  }
  const last = docs[docs.length - 1]?.['$createdAt']
  // A full page that added nothing sits on one timestamp shared by 100+ transitions: stop.
  if (typeof last !== 'number' || (scan.seen.size === before && scan.watermark === last)) {
    scan.done = true
    scan.complete = false
    return
  }
  scan.watermark = last
  scan.edge = docs.map((d) => num(d, 'targetNumber')).sort((a, b) => a - b)
}

/** Read the scan's next page (newest first, `$createdAt <=` the watermark). */
export async function readScanPage(sdk: EvoSDK, repo: RepoRef, scan: StateScan): Promise<void> {
  if (scan.done) return
  const where: [string, '<=', number][] = scan.watermark === null ? [] : [['$createdAt', '<=', scan.watermark]]
  const { documents } = await queryDocumentsWithProof(sdk, {
    ...repoSource(repo).repoQuery(DOC.transition, { where, orderBy: [['$createdAt', 'desc']] }),
    limit: SCAN_PAGE,
  })
  recordScanPage(scan, documents)
}

/**
 * About the lowest number the scan's coverage reaches: the middle target number of its oldest page
 * (closes of much older rows, read in that page, do not drag it down), or 1 once the scan is done.
 * Only a cost bound: a number named below the real coverage is read and its proved state decides.
 */
export function scanFloor(scan: StateScan): number {
  if (scan.done) return 1
  if (scan.edge.length === 0) return Infinity
  return scan.edge[Math.floor((scan.edge.length - 1) / 2)] ?? Infinity
}

/**
 * The state codes the scan proves for `docs` (issues or PRs read by id or number): a target whose
 * newest state change it has read ({@link settledCode}); and one no change names, created after
 * the watermark (every change of its would be read) or once the scan has read every change:
 * never moved, so open (0). Others are left out, for a proved sum to decide.
 */
export function scanCodes(scan: StateScan, docs: readonly PlainDocument[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const d of docs) {
    const id = str(d, '$id')
    const t = scan.targets.get(id)
    if (t !== undefined) {
      const code = settledCode(scan, t)
      if (code !== null) out.set(id, code)
      continue
    }
    if ((scan.done && scan.complete) || (scan.watermark !== null && num(d, '$createdAt') > scan.watermark)) out.set(id, 0)
  }
  return out
}
