/**
 * Issue / PR reads — list + fold (data-contracts §2.3, §4).
 *
 * Issue/PR *state* is not an on-chain field (mutation ownership forbids a maintainer
 * editing an author-owned doc); it is a deterministic fold of the append-only `event` log
 * via {@link foldIssueState} / {@link foldPrState}. Spam events from non-holders exist but
 * are inert. Actor authorization is evaluated **as-of** each event's `$createdAt` from the
 * token-history — supplied here as an {@link AuthzResolver}.
 *
 * TOKEN-HISTORY WIRING: the as-of WRITE/MAINTAIN holdings come from the system token-history
 * contract (mint/freeze/unfreeze/destroy), reconstructed by {@link resolveAuthz} /
 * {@link readTokenHistory}. Each read below resolves that history once (when the caller does
 * not supply an {@link AuthzResolver}) so holder-gated actions — a non-author maintainer's
 * close / label / merge — fold correctly. If the history read fails the resolver is empty and
 * the fold still honors the target author's own close/reopen (graceful degradation).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  AuthzResolver,
  foldIssueState,
  foldPrState,
  type Event,
  type IsAncestor,
  type IssueState,
  type PrState,
} from '../rules'
import {
  IncompleteReadError,
  queryAllDocuments,
  queryDocumentsWithProof,
  type PlainDocument,
} from '../sdk'
import { asIdentifierString, byteFieldToHex, DOC, toEvent, type RepoRef } from './contract'
import { readRefUpdates } from './refs'
import { resolveAuthz } from './tokens'
import { base64ToHex } from '../sdk'

/** An empty authorization resolver (target-author actions only; token history unavailable). */
export function emptyAuthz(): AuthzResolver {
  return new AuthzResolver([])
}

/** An issue with its folded state. */
export interface IssueView {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: number
  readonly state: IssueState
  /**
   * False when the event log could not be read to completion, so `state` is a fold over a
   * partial history and must not be presented as authoritative. Only list surfaces can
   * produce this — a detail read throws instead, because there a wrong state is worse than
   * an error. See {@link listIssues}.
   */
  readonly stateComplete: boolean
}

/** A PR (patch) with its folded state. */
export interface PullView {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: number
  readonly baseRefName: string
  readonly headOid: string
  /**
   * The **source** repo contract id (base58) — where the PR's objects actually live.
   *
   * Surfaced because a reviewer cannot fetch a PR without it: a PR's head commit usually
   * sits in a different contract from the repo it targets, and this is the only pointer the
   * patch document carries to it. Empty for a malformed document.
   */
  readonly sourceContractId: string
  /** The branch the PR was opened from, in the source repo, when recorded. */
  readonly sourceRefName: string | null
  readonly state: PrState
  /** See {@link IssueView.stateComplete}. */
  readonly stateComplete: boolean
}

/** A review verdict, as recorded on-chain. Parity with forge-core `Verdict`. */
export type VerdictName = 'approve' | 'requestChanges' | 'comment' | 'unknown'

const VERDICT_BY_INT: Readonly<Record<number, VerdictName>> = {
  1: 'approve',
  2: 'requestChanges',
  3: 'comment',
}

/** Short label for a verdict, matching `dg pr view`. */
export const VERDICT_LABEL: Readonly<Record<VerdictName, string>> = {
  approve: 'approved',
  requestChanges: 'changes requested',
  comment: 'commented',
  unknown: 'unknown verdict',
}

/**
 * Decode an on-chain verdict code.
 *
 * Keeps the raw `code` alongside the name so an unrecognized verdict retains its identity
 * instead of collapsing into an untyped "unknown" — a review written by a newer client
 * still belongs in a PR's history, and forge-core's `Verdict::Unknown(n)` keeps the same
 * information. Pinned by the shared `verdict__*` conformance vectors.
 */
export function verdictFromCode(code: number): { verdict: VerdictName; code: number } {
  return { verdict: VERDICT_BY_INT[code] ?? 'unknown', code }
}

/** A `review` document, flattened. */
export interface ReviewView {
  readonly id: string
  readonly reviewer: string
  readonly verdict: VerdictName
  /** The raw on-chain code, retained even when `verdict` is `unknown`. */
  readonly verdictCode: number
  readonly commitOid: string
  readonly body: string
  readonly createdAt: number
}

function num(doc: PlainDocument, field: string): number {
  const v = doc[field]
  // Content integer fields (e.g. issue/PR `number`) come back as bigint from the SDK; only
  // system numeric fields are pre-normalized to `number`.
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' ? v : 0
}
function str(doc: PlainDocument, field: string): string {
  return typeof doc[field] === 'string' ? (doc[field] as string) : ''
}

/**
 * Fetch a target's **complete** event log (ascending), converted to rules {@link Event}s.
 *
 * COMPLETENESS IS LOAD-BEARING, not a nicety. `foldIssueState` / `foldPrState` are folds
 * over the whole log: a close at row 101 that never arrives leaves the issue open forever.
 * `event` carries no `tokenCost` in the repo contract template, so anyone can append —
 * a stranger padding a fresh issue with 100 inert events would permanently freeze its
 * displayed state if this read stopped at one page. It pages to exhaustion, and
 * {@link queryAllDocuments} throws rather than returning a short answer if it cannot
 * prove it reached the end. Parity: forge-core `CollabEngine::fetch_events` uses
 * `query_all_documents` for exactly this reason.
 */
export async function readEvents(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<Event[]> {
  const documents = await queryAllDocuments(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.event,
    where: [['targetId', '==', targetId]],
    orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
  })
  return documents.map(toEvent).filter((e): e is Event => e !== null)
}

/**
 * Read **every** `review` on a patch, oldest first.
 *
 * Reviews were write-only across the whole codebase until this existed: the CLI could post
 * "changes requested" and no reader, view or command ever queried it back, so the verdict
 * was a paid-for record invisible to everyone — including the contributor it was addressed
 * to. Complete, for the same reason the event log is: `review` is un-gated, so anyone may
 * append, and a verdict buried past row 100 is exactly the one that matters.
 * Parity: forge-core `PullRequestService::list_reviews`.
 */
export async function readReviews(sdk: EvoSDK, repo: RepoRef, patchId: string): Promise<ReviewView[]> {
  const documents = await queryAllDocuments(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.review,
    where: [['patchId', '==', patchId]],
    orderBy: [['patchId', 'asc'], ['$createdAt', 'asc']],
  })
  return documents.map((d) => {
    const { verdict, code } = verdictFromCode(num(d, 'verdict'))
    return {
      id: str(d, '$id'),
      reviewer: str(d, '$ownerId'),
      verdict,
      verdictCode: code,
      commitOid: byteFieldToHex(d, 'commitOid'),
      body: str(d, 'body'),
      createdAt: num(d, '$createdAt'),
    }
  })
}

/** Read one issue and fold its state. Resolves the token-history authz when not supplied. */
export async function readIssue(
  sdk: EvoSDK,
  repo: RepoRef,
  issueDoc: PlainDocument,
  authz?: AuthzResolver,
): Promise<IssueView> {
  const resolver = authz ?? (await resolveAuthz(sdk, repo))
  const id = str(issueDoc, '$id')
  const author = str(issueDoc, '$ownerId')
  const events = await readEvents(sdk, repo, id)
  return {
    id,
    number: num(issueDoc, 'number'),
    title: str(issueDoc, 'title'),
    body: str(issueDoc, 'body'),
    author,
    createdAt: num(issueDoc, '$createdAt'),
    state: foldIssueState(events, author, resolver),
    stateComplete: true,
  }
}

/** List issues (newest first) with folded state. Resolves the authz once for the whole page. */
export async function listIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  authz?: AuthzResolver,
  limit = 50,
): Promise<IssueView[]> {
  const resolver = authz ?? (await resolveAuthz(sdk, repo))
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.issue,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  // Per-row tolerance. `issue`, `event` and `comment` are un-gated, so one target padded
  // past the reader's completeness bound must not take down a whole page of issues — and
  // dropping the row silently would be the same class of bug this all fixes. The row is
  // kept with `stateComplete: false`; callers render the state as unverified.
  return Promise.all(
    documents.map((doc) =>
      readIssue(sdk, repo, doc, resolver).catch((e: unknown) => {
        if (!(e instanceof IncompleteReadError)) throw e
        return incompleteIssueView(doc)
      }),
    ),
  )
}

/** An issue row whose event log could not be read completely: identity only, no folded state. */
function incompleteIssueView(doc: PlainDocument): IssueView {
  return {
    id: str(doc, '$id'),
    number: num(doc, 'number'),
    title: str(doc, 'title'),
    body: str(doc, 'body'),
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
    state: { open: true, labels: [], assignees: [] },
    stateComplete: false,
  }
}

/**
 * A historical-tips merge predicate for {@link foldPrState}: a merge oid stays valid once
 * the base ref advances past it, so the predicate tests membership in the set of every tip
 * the base ref has EVER had — not reflexive equality (the BLOCKER-1 fix). Built from the
 * base ref's full `refUpdate`/`protectedRefUpdate` history.
 */
export function historicalTipsPredicate(baseRefNewOidsHex: readonly string[]): IsAncestor {
  const tips = new Set(baseRefNewOidsHex)
  return (oid) => tips.has(oid)
}

/** Read one PR (patch) and fold its state, using the historical-tips merge predicate. */
export async function readPull(
  sdk: EvoSDK,
  repo: RepoRef,
  patchDoc: PlainDocument,
  authz?: AuthzResolver,
): Promise<PullView> {
  const resolver = authz ?? (await resolveAuthz(sdk, repo))
  const id = str(patchDoc, '$id')
  const author = str(patchDoc, '$ownerId')
  const baseRefNameHashRaw = patchDoc['baseRefNameHash']
  const baseHeadOidRaw = patchDoc['headOid']

  // Build the base ref's historical-tips set for the merge-reachability predicate.
  let isAncestor: IsAncestor = () => false
  let baseTip: string | undefined
  if (typeof baseRefNameHashRaw === 'string' && baseRefNameHashRaw.length > 0) {
    const baseUpdates = await readRefUpdates(sdk, repo, baseRefNameHashRaw)
    const newOids = baseUpdates.map((u) => u.newOid).filter((o) => o.length > 0)
    isAncestor = historicalTipsPredicate(newOids)
    baseTip = newOids[newOids.length - 1]
  }

  const events = await readEvents(sdk, repo, id)
  let headOid = ''
  if (typeof baseHeadOidRaw === 'string' && baseHeadOidRaw.length > 0) {
    try {
      headOid = base64ToHex(baseHeadOidRaw)
    } catch {
      headOid = baseHeadOidRaw
    }
  }

  return {
    id,
    number: num(patchDoc, 'number'),
    title: str(patchDoc, 'title'),
    body: str(patchDoc, 'body'),
    author,
    createdAt: num(patchDoc, '$createdAt'),
    baseRefName: str(patchDoc, 'baseRefName'),
    headOid,
    sourceContractId: asIdentifierString(patchDoc['sourceContractId']),
    sourceRefName: typeof patchDoc['sourceRefName'] === 'string' ? patchDoc['sourceRefName'] : null,
    state: foldPrState(events, author, resolver, baseTip, isAncestor),
    stateComplete: true,
  }
}

/** List PRs (patches, newest first) with folded state. Resolves the authz once for the page. */
export async function listPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  authz?: AuthzResolver,
  limit = 50,
): Promise<PullView[]> {
  const resolver = authz ?? (await resolveAuthz(sdk, repo))
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.patch,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  // Same per-row tolerance as `listIssues`.
  return Promise.all(
    documents.map((doc) =>
      readPull(sdk, repo, doc, resolver).catch((e: unknown) => {
        if (!(e instanceof IncompleteReadError)) throw e
        return incompletePullView(doc)
      }),
    ),
  )
}

/** A PR row whose event log could not be read completely: identity only, no folded state. */
function incompletePullView(doc: PlainDocument): PullView {
  let headOid = ''
  const raw = doc['headOid']
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      headOid = base64ToHex(raw)
    } catch {
      headOid = raw
    }
  }
  return {
    id: str(doc, '$id'),
    number: num(doc, 'number'),
    title: str(doc, 'title'),
    body: str(doc, 'body'),
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
    baseRefName: str(doc, 'baseRefName'),
    headOid,
    // The source pointer is plain document content, not a fold — it is readable even when
    // the event log is not, and it is what a reviewer needs to fetch the PR at all.
    sourceContractId: asIdentifierString(doc['sourceContractId']),
    sourceRefName: typeof doc['sourceRefName'] === 'string' ? doc['sourceRefName'] : null,
    state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [] },
    stateComplete: false,
  }
}
