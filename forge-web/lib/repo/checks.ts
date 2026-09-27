/**
 * Check runs (`checkRun`, forge-collab; review-parity spec P3, §4.8 row 2): what CI, a relay or a
 * maintainer reported for a commit. A `checkRun` is member-gated at consensus (`ownerRefersTo`
 * maintainer or writer), but a reporter revoked since is no longer trusted, so a run counts only
 * while its reporter is a current member. The newest run per name by `($createdAt, $id)` stands.
 *
 * Parity: forge-core `collab::v2::newest_check_runs` / `Collab::check_runs`, and `dg pr checks`
 * (`crates/dg/src/pr/state.rs`) for passed / failing / pending.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { compareKey } from '../rules'
import { hexToBase64, queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, num, str, type RepoRef } from './contract'
import { repoSource } from './source'

/** The newest run of one check name on a commit. */
export interface CheckRun {
  readonly id: string
  readonly name: string
  /** `queued` | `in_progress` | `completed` (the schema's enum). */
  readonly status: string
  /** Set once completed: `success`, `failure`, `neutral`, `skipped`, `cancelled`, … */
  readonly conclusion: string
  readonly detailsUrl: string
  readonly summary: string
  readonly reporter: string
  /** The reporter is a current maintainer or writer: the run counts. */
  readonly trusted: boolean
  readonly createdAt: number
}

/** How a run reads: passed, failing or still pending (the `dg pr checks` split). */
export type CheckOutcome = 'passed' | 'failing' | 'pending'

const PASSING = new Set(['success', 'neutral', 'skipped'])

export function checkOutcome(r: Pick<CheckRun, 'status' | 'conclusion'>): CheckOutcome {
  if (r.status !== 'completed') return 'pending'
  return PASSING.has(r.conclusion) ? 'passed' : 'failing'
}

/** The newest run per name (sorted by name), trusted when `isMember(reporter)`. */
export function newestCheckRuns(docs: readonly PlainDocument[], isMember: (who: string) => boolean): CheckRun[] {
  const newest = new Map<string, PlainDocument>()
  const key = (d: PlainDocument) => ({ createdAt: num(d, '$createdAt'), id: str(d, '$id') })
  for (const d of docs) {
    const name = str(d, 'name')
    if (name === '') continue
    const held = newest.get(name)
    if (held === undefined || compareKey(key(d), key(held)) > 0) newest.set(name, d)
  }
  return [...newest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, d]) => ({
      id: str(d, '$id'),
      name,
      status: str(d, 'status'),
      conclusion: str(d, 'conclusion'),
      detailsUrl: str(d, 'detailsUrl'),
      summary: str(d, 'summary'),
      reporter: str(d, '$ownerId'),
      trusted: isMember(str(d, '$ownerId')),
      createdAt: num(d, '$createdAt'),
    }))
}

/** The trusted runs' tally: what the checks row and the policy's `requireChecks` read. */
export interface ChecksSummary {
  readonly passed: number
  readonly failing: number
  readonly pending: number
  readonly total: number
}

export function summarizeChecks(runs: readonly CheckRun[]): ChecksSummary {
  const trusted = runs.filter((r) => r.trusted)
  const n = (o: CheckOutcome) => trusted.filter((r) => checkOutcome(r) === o).length
  return { passed: n('passed'), failing: n('failing'), pending: n('pending'), total: trusted.length }
}

/** Every `checkRun` document on `headOid` in `repo` (the `head (repoId, headOid, $createdAt)` index). */
export function readCheckRunDocs(sdk: EvoSDK, repo: RepoRef, headOid: string): Promise<PlainDocument[]> {
  return queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.checkRun, {
      where: [['headOid', '==', hexToBase64(headOid)]],
      orderBy: [['repoId', 'asc'], ['headOid', 'asc'], ['$createdAt', 'asc']],
    }),
  )
}

/** A link a check reports, when it is a plain https URL (the field is reporter-written). */
export function safeDetailsUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
