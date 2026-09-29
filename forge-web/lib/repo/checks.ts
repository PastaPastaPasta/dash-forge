/**
 * Check runs (`checkRun`, forge-collab; review-parity spec P3, platform-parity spec §2): what CI,
 * a relay or a maintainer reported for a commit. A `checkRun` is gated at consensus
 * (`ownerRefersTo` runner, maintainer or writer), but a reporter revoked since is no longer trusted,
 * so a run counts only while its reporter is a current member or runner. The newest run per name
 * by `($createdAt, $id)` stands.
 *
 * Parity: forge-core `collab::v2::newest_check_runs` / `Collab::check_runs`, and `dg pr checks`
 * (`crates/dg/src/pr/state.rs`) for passed / failing / pending.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { compareKey } from '../rules'
import { hexToBase64, queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, byteFieldToHex, num, str, type RepoRef } from './contract'
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
  /** The reporter is a current maintainer, writer or runner: the run counts. */
  readonly trusted: boolean
  readonly createdAt: number
  /** When the run started / completed (ms), as the reporter says; 0 when not given. */
  readonly startedAt: number
  readonly completedAt: number
  /** Where the log is and its SHA-256 (hex); '' when none. The bytes are checked against it. */
  readonly logUrl: string
  readonly logSha256: string
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
      startedAt: num(d, 'startedAt'),
      completedAt: num(d, 'completedAt'),
      logUrl: str(d, 'logUrl'),
      logSha256: byteFieldToHex(d, 'logSha256'),
    }))
}

/** The trusted runs' tally: what the checks row and the policy's `requireChecks` read. */
export interface ChecksSummary {
  readonly passed: number
  readonly failing: number
  readonly pending: number
  /** Trusted runs (the ones that count). */
  readonly total: number
  /** Runs listed but not counted (their reporter is no longer a member or runner). */
  readonly untrusted: number
  /** The membership was read: without it no run can be trusted, and nothing is known. */
  readonly membersKnown: boolean
}

export function summarizeChecks(runs: readonly CheckRun[], membersKnown: boolean): ChecksSummary {
  const trusted = runs.filter((r) => r.trusted)
  const n = (o: CheckOutcome) => trusted.filter((r) => checkOutcome(r) === o).length
  return { passed: n('passed'), failing: n('failing'), pending: n('pending'), total: trusted.length, untrusted: runs.length - trusted.length, membersKnown }
}

/** "3 passed, 1 failing", "No checks reported", or why nothing is known. */
export function checksPhrase(s: ChecksSummary): string {
  if (!s.membersKnown) return "Couldn't read the members, so which checks count is unknown"
  const extra = s.untrusted > 0 ? ` (${s.untrusted} not counted: reporter no longer a member or runner)` : ''
  if (s.total === 0) return `No checks reported${extra}`
  const parts = [s.passed > 0 ? `${s.passed} passed` : '', s.failing > 0 ? `${s.failing} failing` : '', s.pending > 0 ? `${s.pending} pending` : ''].filter((p) => p !== '')
  return `${parts.join(', ')}${extra}`
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

/**
 * The repo's current runners (forge-core `runner` documents, owner-granted): identities whose check
 * runs count besides the maintainers' and writers'. Complete (paged).
 */
export async function readRunners(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.runner, { orderBy: [['repoId', 'asc'], ['memberId', 'asc']] }))
  return docs.map((d) => asIdentifierString(d['memberId'])).filter((id) => id !== '')
}

/** The newest run per name on `headOid`, trusted when the reporter is in `members` or a current runner. */
export async function readCheckRuns(sdk: EvoSDK, repo: RepoRef, headOid: string, members: ReadonlySet<string>): Promise<CheckRun[]> {
  const docs = await readCheckRunDocs(sdk, repo, headOid)
  if (docs.length === 0) return []
  const runners = new Set(await readRunners(sdk, repo))
  return newestCheckRuns(docs, (who) => members.has(who) || runners.has(who))
}

/** Logs larger than this are not read into the page (spec §2.5 caps a log at 32 MiB). */
export const LOG_MAX_BYTES = 32 * 1024 * 1024

/** A run's log, read from where the reporter stored it, and whether it hashed to `logSha256`. */
export interface VerifiedLog {
  readonly text: string
  readonly bytes: number
  readonly sha256: string
  readonly verified: boolean
}

/**
 * Fetch a run's log and check it against the SHA-256 the run records: the bytes come from the
 * reporter's own storage, so only the on-chain hash says they are the log that was reported.
 * `verified: false` is shown as a warning, never as the log.
 */
export async function fetchVerifiedLog(run: Pick<CheckRun, 'logUrl' | 'logSha256'>, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<VerifiedLog> {
  const url = safeLogUrl(run.logUrl)
  if (url === null) throw new Error('the run records no log a browser can read (https, or http on 127.0.0.1)')
  const resp = await fetchImpl(url)
  if (!resp.ok) throw new Error(`the log's storage answered HTTP ${resp.status}`)
  const buf = new Uint8Array(await resp.arrayBuffer())
  if (buf.length > LOG_MAX_BYTES) throw new Error('the log is larger than 32 MiB')
  const got = bytesToHex(sha256(buf))
  return { text: new TextDecoder().decode(buf), bytes: buf.length, sha256: got, verified: got === run.logSha256.toLowerCase() }
}

/** A log URL a page may fetch: https, or http on this machine (a local MinIO/RustFS in tests). */
export function safeLogUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.toString()
    return null
  } catch {
    return null
  }
}

/** How long a run took, `1m 5s`, from its reported start and completion; '' when unknown. */
export function runDuration(r: Pick<CheckRun, 'startedAt' | 'completedAt'>): string {
  if (r.startedAt <= 0 || r.completedAt < r.startedAt) return ''
  const s = Math.round((r.completedAt - r.startedAt) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
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

/**
 * Why a run is not counted, in its row: its reporter is no longer a member, or (the members could
 * not be read) it cannot be told whether they are, which is not the same claim.
 */
export function untrustedWords(summary: Pick<ChecksSummary, 'membersKnown'>): string {
  return summary.membersKnown ? 'reporter is no longer a member or runner: not counted' : 'members could not be read: not counted until they are'
}
