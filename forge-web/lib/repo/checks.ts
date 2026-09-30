/**
 * Check runs (`checkRun`, forge-collab; review-parity spec P3, platform-parity spec §2): what CI,
 * a relay or a maintainer reported for a commit. A `checkRun` is gated at consensus
 * (`ownerRefersTo` runner, maintainer or writer), but a reporter revoked since is no longer trusted,
 * so a run counts only while its reporter is a current member or runner. The newest run per name
 * by `($createdAt, $id)` stands.
 *
 * A branch policy may pin a required check to one reporter (`requiredCheckSources`, RC1 R-08):
 * that check then counts only that runner's or maintainer's runs, so its row names the source
 * ("build · from ci-bot") and a run by anyone else reads "not from the required source".
 *
 * Parity: forge-core `collab::v2::newest_check_runs` / `Collab::check_runs`, and `dg pr checks`
 * (`crates/dg/src/pr/state.rs`) for passed / failing / pending.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { compareKey } from '../rules'
import { pinnedSources, type CheckRunRow, type ChecksPolicy } from '../rules/parity'
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
  /** The reporter the policy pins this check to (base58), or null: any trusted reporter counts. */
  readonly requiredSource: string | null
  /** No source is pinned, or this run is from it; false: the run cannot decide the check. */
  readonly fromRequiredSource: boolean
}

/**
 * Each required check's pinned source, by name: the pairing `checksState` applies
 * (`pinnedSources`, forge-core `pinned_sources`). `requiredChecks` is unique, so each name has one
 * source (the first, should a reader's input repeat a name).
 */
export function requiredSources(policy: ChecksPolicy | null): Map<string, string> {
  return new Map([...pinnedSources(policy ?? {})].map(([name, sources]) => [name, [...sources][0] as string]))
}

/** A run counts toward the checks: its reporter is trusted and, for a pinned check, is the source. */
export function runCounts(r: Pick<CheckRun, 'trusted' | 'fromRequiredSource'>): boolean {
  return r.trusted && r.fromRequiredSource
}

/** A check the policy requires by name that no run on the head reports yet ("Expected"). */
export interface ExpectedCheck {
  readonly name: string
  /** Its pinned source, or null. */
  readonly source: string | null
}

/** The policy's required checks (in policy order) with no run listed in `runs`. */
export function expectedChecks(runs: readonly Pick<CheckRun, 'name'>[], policy: ChecksPolicy | null): ExpectedCheck[] {
  const reported = new Set(runs.map((r) => r.name))
  const pins = requiredSources(policy)
  return [...new Set(policy?.requiredChecks ?? [])].filter((n) => n !== '' && !reported.has(n)).map((name) => ({ name, source: pins.get(name) ?? null }))
}

/** How a run reads: passed, failing or still pending (the `dg pr checks` split). */
export type CheckOutcome = 'passed' | 'failing' | 'pending'

const PASSING = new Set(['success', 'neutral', 'skipped'])

export function checkOutcome(r: Pick<CheckRun, 'status' | 'conclusion'>): CheckOutcome {
  if (r.status !== 'completed') return 'pending'
  return PASSING.has(r.conclusion) ? 'passed' : 'failing'
}

/**
 * One run per name (sorted by name): the newest run that counts (its reporter `isMember`, and for
 * a check `pins` pins, the pinned source), which is what the merge box counts (`checksState`,
 * forge-core `checks_state`); a run that does not count never shadows it. A name with no counting
 * run shows its newest trusted run, else its newest run, marked not counted.
 */
export function newestCheckRuns(docs: readonly PlainDocument[], isMember: (who: string) => boolean, pins: ReadonlyMap<string, string> = new Map()): CheckRun[] {
  const newest = new Map<string, PlainDocument>()
  const key = (d: PlainDocument) => ({ createdAt: num(d, '$createdAt'), id: str(d, '$id') })
  // 2 counts, 1 trusted but not from the pinned source, 0 untrusted.
  const rank = (d: PlainDocument, name: string): number => {
    const who = str(d, '$ownerId')
    if (!isMember(who)) return 0
    const pin = pins.get(name)
    return pin === undefined || pin === who ? 2 : 1
  }
  for (const d of docs) {
    const name = str(d, 'name')
    if (name === '') continue
    const held = newest.get(name)
    const r = rank(d, name)
    const heldRank = held === undefined ? -1 : rank(held, name)
    if (held === undefined || r > heldRank || (r === heldRank && compareKey(key(d), key(held)) > 0)) newest.set(name, d)
  }
  return [...newest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, d]) => {
      const reporter = str(d, '$ownerId')
      const pin = pins.get(name) ?? null
      return {
        id: str(d, '$id'),
        name,
        status: str(d, 'status'),
        conclusion: str(d, 'conclusion'),
        detailsUrl: str(d, 'detailsUrl'),
        summary: str(d, 'summary'),
        reporter,
        trusted: isMember(reporter),
        createdAt: num(d, '$createdAt'),
        startedAt: num(d, 'startedAt'),
        completedAt: num(d, 'completedAt'),
        logUrl: str(d, 'logUrl'),
        logSha256: byteFieldToHex(d, 'logSha256'),
        requiredSource: pin,
        fromRequiredSource: pin === null || pin === reporter,
      }
    })
}

/** The trusted runs' tally: what the checks row and the policy's `requireChecks` read. */
export interface ChecksSummary {
  readonly passed: number
  readonly failing: number
  readonly pending: number
  /** Runs that count: a trusted reporter, and for a pinned check its source. */
  readonly total: number
  /** Runs listed but not counted (their reporter is no longer a member or runner). */
  readonly untrusted: number
  /** Runs listed but not counted: a trusted reporter, but not the source the policy pins the check to. */
  readonly offSource: number
  /** The membership was read: without it no run can be trusted, and nothing is known. */
  readonly membersKnown: boolean
}

export function summarizeChecks(runs: readonly CheckRun[], membersKnown: boolean): ChecksSummary {
  const counted = runs.filter(runCounts)
  const n = (o: CheckOutcome) => counted.filter((r) => checkOutcome(r) === o).length
  const untrusted = runs.filter((r) => !r.trusted).length
  const offSource = runs.filter((r) => r.trusted && !r.fromRequiredSource).length
  return { passed: n('passed'), failing: n('failing'), pending: n('pending'), total: counted.length, untrusted, offSource, membersKnown }
}

/** "3 passed, 1 failing", "No checks reported", or why nothing is known. */
export function checksPhrase(s: ChecksSummary): string {
  if (!s.membersKnown) return "Couldn't read the members, so which checks count is unknown"
  const notCounted = [
    s.untrusted > 0 ? `${s.untrusted} not counted: reporter no longer a member or runner` : '',
    s.offSource > 0 ? `${s.offSource} not from the required source` : '',
  ].filter((p) => p !== '')
  const extra = notCounted.length > 0 ? ` (${notCounted.join('; ')})` : ''
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

// Runners change rarely and every commit and PR page of a repo reads them: cached per repo, like
// the members. A failed read is never cached.
const RUNNERS_TTL_MS = 5 * 60_000
const runnersCache = new Map<string, { at: number; promise: Promise<string[]> }>()

/** {@link readRunners} through the per-repo session cache. */
export function readRunnersCached(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  const key = `${repo.forge.core}:${repo.repoId}`
  const hit = runnersCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < RUNNERS_TTL_MS) return hit.promise
  const promise = readRunners(sdk, repo)
  runnersCache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (runnersCache.get(key)?.promise === promise) runnersCache.delete(key)
  })
  return promise
}

/** A head's check runs as the page shows them, and the rows the merge-box rule reads. */
export interface HeadChecks {
  /** Per name: the newest trusted run, or (none trusted) the newest run, listed as not counted. */
  readonly runs: CheckRun[]
  /** Every run on the head, flattened for {@link checksState}. */
  readonly rows: CheckRunRow[]
  /** The repo's current runners. */
  readonly runners: ReadonlySet<string>
}

/**
 * The check runs on `headOid`, trusted when the reporter is in `members` or a current runner; a
 * check `pins` pins ({@link requiredSources}) counts its source's runs only.
 */
export async function readCheckRuns(sdk: EvoSDK, repo: RepoRef, headOid: string, members: ReadonlySet<string>, pins: ReadonlyMap<string, string> = new Map()): Promise<HeadChecks> {
  const docs = await readCheckRunDocs(sdk, repo, headOid)
  if (docs.length === 0) return { runs: [], rows: [], runners: new Set() }
  const runners = new Set(await readRunnersCached(sdk, repo))
  return {
    runs: newestCheckRuns(docs, (who) => members.has(who) || runners.has(who), pins),
    rows: docs.map((d) => ({
      id: str(d, '$id'),
      headOid: headOid.toLowerCase(),
      name: str(d, 'name'),
      status: str(d, 'status'),
      conclusion: str(d, 'conclusion') || null,
      reporter: str(d, '$ownerId'),
      createdAt: num(d, '$createdAt'),
    })),
    runners,
  }
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

/** How long a log read may take before it is abandoned. */
export const LOG_TIMEOUT_MS = 30_000

/**
 * Fetch a run's log and check it against the SHA-256 the run records: the bytes come from the
 * reporter's own storage, so only the on-chain hash says they are the log that was reported.
 * `verified: false` is shown as a warning, never as the log. The read is streamed and stops at
 * {@link LOG_MAX_BYTES} (refused up front when the length says so), sends no credentials and no
 * referrer, and is abandoned after {@link LOG_TIMEOUT_MS}.
 */
export async function fetchVerifiedLog(run: Pick<CheckRun, 'logUrl' | 'logSha256'>, fetchImpl: typeof fetch = (i, init) => fetch(i, init), pageHost: string = typeof location === 'undefined' ? '' : location.hostname): Promise<VerifiedLog> {
  const url = safeLogUrl(run.logUrl, pageHost)
  if (url === null) throw new Error('the run records no log this page can read (https, or http on this machine for a page served from it)')
  const signal = AbortSignal.timeout(LOG_TIMEOUT_MS)
  const resp = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
  if (!resp.ok) throw new Error(`the log's storage answered HTTP ${resp.status}`)
  const declared = Number(resp.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > LOG_MAX_BYTES) throw new Error('the log is larger than 32 MiB')
  const hash = sha256.create()
  const parts: Uint8Array[] = []
  let total = 0
  const take = (chunk: Uint8Array): void => {
    total += chunk.length
    if (total > LOG_MAX_BYTES) throw new Error('the log is larger than 32 MiB')
    hash.update(chunk)
    parts.push(chunk)
  }
  if (resp.body === null) take(new Uint8Array(await resp.arrayBuffer()))
  else {
    const reader = resp.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        take(value)
      }
    } catch (e) {
      await reader.cancel().catch(() => undefined)
      throw e
    }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  const got = bytesToHex(hash.digest())
  return { text: new TextDecoder().decode(bytes), bytes: total, sha256: got, verified: got === run.logSha256.toLowerCase() }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A log URL a page may fetch: https; or plain http on this machine, and only when the page itself
 * is served from this machine (a local test bucket). A public page never reads an http URL.
 */
export function safeLogUrl(url: string, pageHost: string = typeof location === 'undefined' ? '' : location.hostname): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:' && LOOPBACK.has(u.hostname) && LOOPBACK.has(pageHost)) return u.toString()
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
