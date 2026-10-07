/**
 * The pull request an issue close names as its cause (`transition.closedByPr`), read by number
 * when the issue page's backlinks do not already hold it with its merge (only the newest merged
 * linking PRs are read there): one patch read and one transition read, made only for a close
 * that names a PR. Public repos only (a private repo's closes are never judged by it).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryDocuments } from '../sdk'
import { mergeTransition, type ClosingPr } from '../rules/transition'
import { DOC, str, type RepoRef } from './contract'
import { repoSource } from './source'
import { readTransitions } from './transitions'

/** A PR a close names: what the shared `closedByPr` rule reads, and its title for the link. */
export interface NamedPull extends ClosingPr {
  readonly title: string
}

/** PR `number` as the shared `closedByPr` rule reads it, or null when there is no such PR. */
export async function readClosingPr(sdk: EvoSDK, repo: RepoRef, number: number): Promise<NamedPull | null> {
  const docs = await queryDocuments(sdk, repoSource(repo).repoQuery(DOC.patch, { where: [['number', '==', number]], limit: 1 }))
  const doc = docs[0]
  if (doc === undefined) return null
  const merge = mergeTransition(await readTransitions(sdk, repo, str(doc, '$id')))
  return {
    number,
    merged: merge !== null,
    mergedAt: merge?.createdAt ?? null,
    body: str(doc, 'body'),
    imported: doc['imported'] != null,
    title: str(doc, 'title'),
  }
}
