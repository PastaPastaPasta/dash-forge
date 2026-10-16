/**
 * The inbox's "made this repo public" items (mixed-visibility DESIGN §4.10 step 6: members are
 * told when a private repo they belong to is made public). Each private repo I belong to (any
 * role but owner: the owner made it public) is checked once it is public: its config timeline says
 * whether it was made public (`converted.ts`). One that never was private never can be, so its
 * answer is kept for good, as is the item once made; nothing is read for it again.
 *
 * - When: the conversion marker's `$createdAt` (the first public config, step 4), else the repo
 *   document's `$updatedAt` (the flip replaced it), else the seal-off rotation's.
 * - "Everything" (owner bundles with entries publishing the repo's epoch keys, step 7, the last
 *   step) is its own item, from the repo's make-public feed (`./inbox-made-public`): "made
 *   everything written while private public" ({@link everythingItem}) at the bundle's time. The
 *   two items have their own ids, so whichever feed is read first, neither hides the other.
 *
 * Former members and authors whose words Everything made public are not told yet: they have no
 * subscription to the repo, and their thread subscriptions don't say which repo was made public.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { DOC, asIdentifierString, type RepoRef } from '../repo/contract'
import { createdAtOf, markerAtOf, positiveAt } from '../repo/conversion-status'
import { repoConversion } from '../repo/converted'
import { contractOf, readAllRows } from '../repo/source'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import type { InboxItem } from './inbox'
import type { RepoLite } from './mine'

/** What the check of one repo concluded: `never` made public (and never will be), `done` (said, or nothing to say). */
export type RepoPublicVerdict = 'never' | 'done'

/** The words of the item. */
export const REPO_PUBLIC_WHAT = 'made this repo public'

/** The words of the item when the owner publishes everything written while private. */
export const EVERYTHING_PUBLIC_WHAT = 'made everything written while private public'

/** The item's id: one per repo for making it public, another for Everything (each said once, neither hiding the other). */
export function repoPublicItemId(repoId: string, everything: boolean): string {
  return everything ? `repoPublic:${repoId}:everything` : `repoPublic:${repoId}`
}

/** "@owner made this repo public" at `at` (pure). */
export function repoPublicItem(repo: RepoLite, at: number): InboxItem {
  return { id: repoPublicItemId(repo.id, false), kind: 'repoPublic', repo, what: REPO_PUBLIC_WHAT, actor: repo.ownerId, at, read: false }
}

/** "@owner made everything written while private public" at `at`, when Everything follows the flip (pure). */
export function everythingItem(repo: RepoLite, at: number): InboxItem {
  return { id: repoPublicItemId(repo.id, true), kind: 'repoPublic', repo, what: EVERYTHING_PUBLIC_WHAT, actor: repo.ownerId, at, read: false }
}

/** The repo of a feed as the readers take it. */
export function repoRefOf(forge: ForgeIds, repo: RepoLite): RepoRef {
  return { forge, repoId: repo.id, ownerId: repo.ownerId, name: repo.name, visibility: repo.private ? 'private' : 'public' }
}

/**
 * When `repo` (public now, with its config timeline `configs`) was made public: its marker's
 * `$createdAt`, else `repoUpdatedAt` (the flip's), else its newest private config's (the seal-off
 * rotation's). Null when it was never made public.
 */
export function conversionAt(repo: RepoRef, configs: readonly PlainDocument[], repoUpdatedAt: number | null): number | null {
  const conversion = repoConversion(repo, configs)
  if (conversion === null) return null
  const at = markerAtOf(configs, conversion)
  if (at !== null) return at
  if (repoUpdatedAt !== null) return repoUpdatedAt
  return configs.filter((c) => c['vis'] === 'private').reduce((m, c) => Math.max(m, createdAtOf(c) ?? 0), 0)
}

/** The repo document's `$updatedAt`, or null when it can't be read. */
async function repoUpdatedAt(sdk: EvoSDK, repo: RepoRef): Promise<number | null> {
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractOf(repo.forge, DOC.repo), documentTypeName: DOC.repo, where: [['$id', '==', repo.repoId]], limit: 1 })
  return positiveAt(documents.find((x) => asIdentifierString(x['$id']) === repo.repoId)?.['$updatedAt'])
}

/**
 * The check of public `repo` for `me` (module docs): its item, if it was made public, and the
 * verdict to keep. A private repo is not checked yet (null verdict: ask again once it is public).
 * A read that fails throws: the repo is checked again next round.
 */
export async function repoPublicItems(sdk: EvoSDK, forge: ForgeIds, repo: RepoLite, me: string): Promise<{ readonly items: InboxItem[]; readonly verdict: RepoPublicVerdict | null }> {
  if (repo.private) return { items: [], verdict: null }
  const ref = repoRefOf(forge, repo)
  const configs = await readAllRows(sdk, ref, DOC.config)
  const conversion = repoConversion(ref, configs)
  if (conversion === null) return { items: [], verdict: 'never' }
  // The owner made it public: their own action never notifies them.
  if (me === repo.ownerId) return { items: [], verdict: 'done' }
  const at = conversionAt(ref, configs, conversion.markerHeight === null ? await repoUpdatedAt(sdk, ref) : null)
  if (at === null) return { items: [], verdict: 'never' }
  return { items: [repoPublicItem(repo, at)], verdict: 'done' }
}
