/**
 * Issue / PR reads — list + fold (data-contracts §2.3, §4).
 *
 * Issue/PR *state* is not an on-chain field (mutation ownership forbids a maintainer
 * editing an author-owned doc); it is a deterministic fold of the append-only `event` log
 * via {@link foldIssueState} / {@link foldPrState}. Spam events from non-holders exist but
 * are inert. Actor authorization is evaluated **as-of** each event's `$createdAt` from the
 * token-history — supplied here as an {@link AuthzResolver}.
 *
 * TOKEN-HISTORY WIRING (M3 status): the as-of WRITE/MAINTAIN holdings come from the system
 * token-history contract (mint/freeze/destroy). That system-contract read is not wired in
 * this module yet — callers pass an {@link AuthzResolver} (build one with the repo's
 * token-history records once that read lands). With an empty resolver the fold still honors
 * the target author's own close/reopen; holder-gated actions (maintainer close, merge,
 * labels) require the records. This is the one repo read that is authz-record-pending; the
 * fold logic itself is vector-proven.
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
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { DOC, toEvent, type RepoRef } from './contract'
import { readRefUpdates } from './refs'
import { base64ToHex } from '../sdk'

/** An empty authorization resolver (target-author actions only; see module note). */
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
  readonly state: PrState
}

function num(doc: PlainDocument, field: string): number {
  return typeof doc[field] === 'number' ? (doc[field] as number) : 0
}
function str(doc: PlainDocument, field: string): string {
  return typeof doc[field] === 'string' ? (doc[field] as string) : ''
}

/** Fetch a target's full event log (ascending), converted to rules {@link Event}s. */
export async function readEvents(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<Event[]> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.event,
    where: [['targetId', '==', targetId]],
    orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
    limit: 100,
  })
  return documents.map(toEvent).filter((e): e is Event => e !== null)
}

/** Read one issue and fold its state. */
export async function readIssue(
  sdk: EvoSDK,
  repo: RepoRef,
  issueDoc: PlainDocument,
  authz: AuthzResolver = emptyAuthz(),
): Promise<IssueView> {
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
    state: foldIssueState(events, author, authz),
  }
}

/** List issues (newest first) with folded state. */
export async function listIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  authz: AuthzResolver = emptyAuthz(),
  limit = 50,
): Promise<IssueView[]> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.issue,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  return Promise.all(documents.map((doc) => readIssue(sdk, repo, doc, authz)))
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
  authz: AuthzResolver = emptyAuthz(),
): Promise<PullView> {
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
    state: foldPrState(events, author, authz, baseTip, isAncestor),
  }
}

/** List PRs (patches, newest first) with folded state. */
export async function listPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  authz: AuthzResolver = emptyAuthz(),
  limit = 50,
): Promise<PullView[]> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.patch,
    orderBy: [['$createdAt', 'desc']],
    limit,
  })
  return Promise.all(documents.map((doc) => readPull(sdk, repo, doc, authz)))
}
