/**
 * Issue/PR thread composition (view glue) — read comments and interleave them with the folded
 * event log into a single chronological timeline for the detail view.
 *
 * State itself (open/closed, labels) is the deterministic {@link foldIssueState} fold done by
 * the core `readIssue`; this module only adds the human thread (comments + rendered events).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DOC, readEvents, readIssue, readPull, type IssueView, type PullView, type RepoRef } from '../repo'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import type { Event } from '../rules'

/** One comment on an issue/PR. */
export interface CommentView {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: number
}

function str(doc: PlainDocument, field: string): string {
  const v = doc[field]
  return typeof v === 'string' ? v : ''
}
function num(doc: PlainDocument, field: string): number {
  const v = doc[field]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0
}

/** Read all comments on a target (issue/PR), oldest first. */
export async function readComments(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<CommentView[]> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.comment,
    where: [['targetId', '==', targetId]],
    orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
    limit: 100,
  })
  return documents.map((d) => ({
    id: str(d, '$id'),
    author: str(d, '$ownerId'),
    body: str(d, 'body'),
    createdAt: num(d, '$createdAt'),
  }))
}

/** A merged timeline item: a comment or a state event. */
export type TimelineItem =
  | { readonly kind: 'comment'; readonly at: number; readonly comment: CommentView }
  | { readonly kind: 'event'; readonly at: number; readonly event: Event }

/** Find an issue document by its `number` field, or null. */
async function issueDocByNumber(sdk: EvoSDK, repo: RepoRef, number: number): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.issue,
    where: [['number', '==', number]],
    orderBy: [['number', 'desc']],
    limit: 1,
  })
  return documents[0] ?? null
}

/** Find a patch (PR) document by its `number` field, or null. */
async function patchDocByNumber(sdk: EvoSDK, repo: RepoRef, number: number): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.patch,
    where: [['number', '==', number]],
    orderBy: [['number', 'desc']],
    limit: 1,
  })
  return documents[0] ?? null
}

/** A full issue detail: the folded issue + its merged timeline. */
export interface IssueThread {
  readonly issue: IssueView
  readonly timeline: TimelineItem[]
}

/** Load an issue (folded state) + its comment/event timeline by number. Null if not found. */
export async function loadIssueThread(sdk: EvoSDK, repo: RepoRef, number: number): Promise<IssueThread | null> {
  const doc = await issueDocByNumber(sdk, repo, number)
  if (!doc) return null
  const issue = await readIssue(sdk, repo, doc)
  const timeline = await readThread(sdk, repo, issue.id)
  return { issue, timeline }
}

/** A full PR detail: the folded pull + its merged timeline. */
export interface PullThread {
  readonly pull: PullView
  readonly timeline: TimelineItem[]
}

/** Load a PR (folded state) + its comment/event timeline by number. Null if not found. */
export async function loadPullThread(sdk: EvoSDK, repo: RepoRef, number: number): Promise<PullThread | null> {
  const doc = await patchDocByNumber(sdk, repo, number)
  if (!doc) return null
  const pull = await readPull(sdk, repo, doc)
  const timeline = await readThread(sdk, repo, pull.id)
  return { pull, timeline }
}

/** Read comments + events for a target and merge them into one chronological timeline. */
export async function readThread(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<TimelineItem[]> {
  const [comments, events] = await Promise.all([
    readComments(sdk, repo, targetId),
    readEvents(sdk, repo, targetId),
  ])
  const items: TimelineItem[] = [
    ...comments.map((c) => ({ kind: 'comment' as const, at: c.createdAt, comment: c })),
    ...events.map((e) => ({ kind: 'event' as const, at: e.createdAt, event: e })),
  ]
  items.sort((a, b) => a.at - b.at)
  return items
}
