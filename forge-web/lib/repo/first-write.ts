/**
 * Which index subtrees a write would create (`lib/sdk/cost.ts` {@link FirstWrite}): a repo's
 * first issue, a thread's first comment, an author's first star. Each answer is one proved
 * `limit: 1` read (or a count) on an index the write itself fills, so a preview can drop the
 * surcharges that do not apply. A read that fails leaves its field unknown, which the cost
 * model counts as a first write: the preview stays an upper bound, it is only less tight
 * (D-011).
 *
 * The identity's first write to a contract (its identity-contract nonce) is read from the
 * nonce: 0 means no write yet. Once an identity has written, it stays so, so that answer is
 * kept for the session.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { STEADY, previewCreate, sumPreviews, type CostPreview, type FirstWrite } from '../sdk/cost'
import { countDocuments, queryDocumentsWithProof, type DocumentQuery } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { contractOf, repoSource, type QueryShape } from './source'

/** A read's answer, or `undefined` (unknown) when the read fails. */
async function orUnknown(read: () => Promise<boolean>): Promise<boolean | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** Whether a query returns nothing: `true` (a first), `false`, or `undefined` when unknown. */
function empty(sdk: EvoSDK, q: DocumentQuery): Promise<boolean | undefined> {
  return orUnknown(async () => (await queryDocumentsWithProof(sdk, { ...q, limit: 1 })).documents.length === 0)
}

/** Whether a countable index holds nothing (an indexOnly type: `star`, `follow`). */
function none(sdk: EvoSDK, q: DocumentQuery): Promise<boolean | undefined> {
  return orUnknown(async () => (await countDocuments(sdk, q)) === 0)
}

/** The `targetId` index query of a thread: what a thread's first comment or event fills. */
function threadQuery(targetId: string): QueryShape {
  return {
    where: [['targetId', '==', targetId]],
    orderBy: [
      ['targetId', 'asc'],
      ['$createdAt', 'asc'],
    ],
  }
}

interface NonceFacade {
  identities: { contractNonce(identityId: string, contractId: string): Promise<bigint | undefined> }
}

/** `identity:contract` pairs known to have written (a nonce above 0): never a first again. */
const wrote = new Set<string>()

/** Whether `identityId` has never written to `contractId` (no identity-contract nonce yet). */
export async function contractFirst(sdk: EvoSDK, identityId: string, contractId: string): Promise<boolean | undefined> {
  const key = `${identityId}:${contractId}`
  if (wrote.has(key)) return false
  try {
    const n = await (sdk as unknown as NonceFacade).identities.contractNonce(identityId, contractId)
    const first = n === undefined || n === 0n
    if (!first) wrote.add(key)
    return first
  } catch {
    return undefined
  }
}

type Answers = Partial<Record<keyof FirstWrite, boolean | undefined>>

/**
 * The known answers: an unknown one is left out (counted as a first); a field the write does
 * not touch is `false`.
 */
function known(fields: Answers): FirstWrite {
  const out: Partial<Record<keyof FirstWrite, boolean>> = { ...STEADY }
  for (const [k, v] of Object.entries(fields) as [keyof FirstWrite, boolean | undefined][]) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

/** A new issue in `repo` by `author`. */
export async function issueFirsts(sdk: EvoSDK, repo: RepoRef, author: string): Promise<FirstWrite> {
  const src = repoSource(repo)
  const byAuthor = (where: DocumentQuery['where']): DocumentQuery => ({
    dataContractId: repo.forge.collab,
    documentTypeName: DOC.issue,
    where,
    orderBy: [
      ['repoId', 'asc'],
      ['number', 'asc'],
    ],
  })
  const [repoFirst, authorInRepo, authorAny, contract] = await Promise.all([
    empty(sdk, src.repoQuery(DOC.issue, { orderBy: [['number', 'asc']] })),
    empty(sdk, byAuthor([['$ownerId', '==', author], ['repoId', '==', repo.repoId]])),
    empty(sdk, byAuthor([['$ownerId', '==', author]])),
    contractFirst(sdk, author, repo.forge.collab),
  ])
  return known({ repo: repoFirst, authorInRepo, author: authorAny, contract })
}

/**
 * A new comment on the thread `targetId` by `author`. `threadHasComments`: what the page
 * already read (saves a query).
 */
export async function commentFirsts(
  sdk: EvoSDK,
  repo: RepoRef,
  targetId: string,
  author: string,
  threadHasComments?: boolean,
): Promise<FirstWrite> {
  const [target, authorAny, contract] = await Promise.all([
    threadHasComments !== undefined
      ? Promise.resolve(!threadHasComments)
      : empty(sdk, repoSource(repo).targetQuery(DOC.comment, threadQuery(targetId))),
    empty(sdk, { dataContractId: repo.forge.collab, documentTypeName: DOC.comment, where: [['$ownerId', '==', author]], orderBy: [['$createdAt', 'desc']] }),
    contractFirst(sdk, author, repo.forge.collab),
  ])
  return known({ target, author: authorAny, contract })
}

/** A new `event`, `authorEvent` or `transition` on the thread `targetId`, signed by `signer`. */
export async function eventFirsts(
  sdk: EvoSDK,
  repo: RepoRef,
  type: 'event' | 'authorEvent' | 'transition',
  targetId: string,
  signer: string,
): Promise<FirstWrite> {
  const src = repoSource(repo)
  // `transition` indexes a target by `perTarget (targetId)` alone.
  const onTarget = type === 'transition' ? { where: [['targetId', '==', targetId]] as const, orderBy: [['targetId', 'asc']] as const } : threadQuery(targetId)
  const [target, feed, contract] = await Promise.all([
    empty(sdk, src.targetQuery(type, onTarget)),
    empty(sdk, src.repoQuery(type, { orderBy: [['$createdAt', 'desc']] })),
    contractFirst(sdk, signer, contractOf(repo.forge, type)),
  ])
  return known({ target, repo: feed, contract })
}

/** A new star on `repo` by `viewer`. `starCount`: the count the page already shows. */
export async function starFirsts(sdk: EvoSDK, repo: RepoRef, viewer: string, starCount?: number | null): Promise<FirstWrite> {
  const [repoFirst, author, contract] = await Promise.all([
    typeof starCount === 'number'
      ? Promise.resolve(starCount === 0)
      : none(sdk, { dataContractId: repo.forge.community, documentTypeName: DOC.star, where: [['repoId', '==', repo.repoId]] }),
    // The starrer's first star builds their `byOwner` value tree.
    none(sdk, { dataContractId: repo.forge.community, documentTypeName: DOC.star, where: [['$ownerId', '==', viewer]] }),
    contractFirst(sdk, viewer, repo.forge.community),
  ])
  return known({ repo: repoFirst, author, contract })
}

/** The viewer's trending beat (`starBeat`): their first builds their `byOwner` value tree. */
export async function starBeatFirsts(sdk: EvoSDK, repo: RepoRef, viewer: string): Promise<FirstWrite> {
  return known({ author: await none(sdk, { dataContractId: repo.forge.community, documentTypeName: DOC.starBeat, where: [['$ownerId', '==', viewer]] }) })
}

/**
 * A new follow by `viewer` of `target`: the author subtree of the `byOwner` index, and the target's
 * of `byTarget` (its first follower). `followers`: the target's count the page already read.
 */
export async function followFirsts(sdk: EvoSDK, community: string, viewer: string, target: string, followers?: number | null): Promise<FirstWrite> {
  const [author, targetFirst, contract] = await Promise.all([
    none(sdk, { dataContractId: community, documentTypeName: DOC.follow, where: [['$ownerId', '==', viewer]] }),
    typeof followers === 'number'
      ? Promise.resolve(followers === 0)
      : none(sdk, { dataContractId: community, documentTypeName: DOC.follow, where: [['identityId', '==', target]] }),
    contractFirst(sdk, viewer, community),
  ])
  return known({ author, target: targetFirst, contract })
}

/** A new review on a PR. `prHasReviews`: what the page already read. */
export async function reviewFirsts(sdk: EvoSDK, repo: RepoRef, reviewer: string, prHasReviews: boolean): Promise<FirstWrite> {
  return known({ target: !prHasReviews, contract: await contractFirst(sdk, reviewer, repo.forge.collab) })
}

/** A repository creation's documents, previewed (`firsts`: {@link repoCreationFirsts}). */
export interface RepoCreationFirsts {
  readonly first: FirstWrite
  readonly rest: FirstWrite
}

/**
 * The price of creating a repository: public, three documents (`repo`, the owner's
 * `maintainer`, the first `config`); private, four (plus the owner's epoch-0 `repoKey`, and a
 * sealed `config`).
 */
export function previewRepoCreate(
  i: { readonly name: string; readonly description?: string; readonly defaultBranch?: string; readonly visibility?: 'public' | 'private' },
  firsts: RepoCreationFirsts,
): CostPreview {
  if (i.visibility === 'private') {
    return sumPreviews([
      previewCreate('repo', { name: i.name, visibility: 'private', ...(i.description ? { description: i.description } : {}) }, firsts.first),
      previewCreate('maintainer', {}, firsts.rest),
      previewCreate('repoKey'),
      previewCreate('config', { enc: new Uint8Array(80), epoch: 0, backend: { mode: 0 } }, { ...firsts.rest, repo: true }),
    ])
  }
  return sumPreviews([
    previewCreate('repo', { ...i, visibility: 'public' }, firsts.first),
    previewCreate('maintainer', {}, firsts.rest),
    // A new repo's first config builds its config subtree (QW3-037).
    previewCreate('config', { defaultBranch: i.defaultBranch ?? 'main' }, { ...firsts.rest, repo: true }),
  ])
}

/**
 * A new repo (repo + maintainer + config) by `owner`, per document: the first one pays the
 * contract nonce, the owner's first repo also the owner's subtrees. An owner who has written
 * to forge-core has created a repo (every forge-core write is into a repo they own or
 * maintain), so the nonce answers both.
 */
export async function repoCreationFirsts(sdk: EvoSDK, owner: string, core: string): Promise<RepoCreationFirsts> {
  const contract = await contractFirst(sdk, owner, core)
  if (contract === undefined) return { first: {}, rest: { contract: false } }
  const first = known({ contract, author: contract, member: contract })
  return { first, rest: { ...first, contract: false } }
}
