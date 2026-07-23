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
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { DOC, toEvent, type RepoRef } from './contract'
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
  const v = doc[field]
  // Content integer fields (e.g. issue/PR `number`) come back as bigint from the SDK; only
  // system numeric fields are pre-normalized to `number`.
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' ? v : 0
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
  return Promise.all(documents.map((doc) => readIssue(sdk, repo, doc, resolver)))
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
    state: foldPrState(events, author, resolver, baseTip, isAncestor),
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
  return Promise.all(documents.map((doc) => readPull(sdk, repo, doc, resolver)))
}
