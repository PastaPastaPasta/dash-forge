/**
 * The inbox's "made this repo public" items (mixed-visibility DESIGN §4.10 step 6: members are
 * told when a private repo they belong to is made public). Each private repo I belong to (any
 * role but owner: the owner made it public) is checked once it is public: its config timeline says
 * whether it was made public (`converted.ts`). One that never was private never can be, so its
 * answer is kept for good, as is the item once made; nothing is read for it again.
 *
 * - When: the conversion marker's `$createdAt` (the first public config, step 4), else the repo
 *   document's `$updatedAt` (the flip replaced it), else the seal-off rotation's.
 * - With "Everything" (owner bundles with entries publishing the repo's epoch keys, step 7, the
 *   last step) by then: "made this repo public, with everything written while private". When that
 *   step lands later, the repo's make-public feed (`./inbox-made-public`) adds "made everything
 *   written while private public" ({@link everythingItem}); one id per repo, so either way it is
 *   said once.
 *
 * Former members and authors whose words Everything made public are not told yet: they have no
 * subscription to the repo, and their thread subscriptions don't say which repo was made public.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { ENTRY_EPOCH_KEY, bytesEqual, parseBundle } from '../private'
import { DOC, asIdentifierString, type RepoRef } from '../repo/contract'
import { readMakePublicBundles, repoConversion } from '../repo/converted'
import { blockHeightOf } from '../repo/private-content'
import { contractOf, repoSource } from '../repo/source'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import type { InboxItem } from './inbox'
import type { RepoLite } from './mine'

/** What the check of one repo concluded: `never` made public (and never will be), `done` (said, or nothing to say). */
export type RepoPublicVerdict = 'never' | 'done'

/** The words of the item: "made this repo public", with Everything "…, with everything written while private". */
export function repoPublicWhat(everything: boolean): string {
  return everything ? 'made this repo public, with everything written while private' : 'made this repo public'
}

/** The words of the item when Everything lands after the repo was made public. */
export const EVERYTHING_PUBLIC_WHAT = 'made everything written while private public'

/** The item's id: one per repo for making it public, one for Everything (so neither is said twice). */
export function repoPublicItemId(repoId: string, everything: boolean): string {
  return everything ? `repoPublic:${repoId}:everything` : `repoPublic:${repoId}`
}

/** "@owner made this repo public" at `at` (pure). */
export function repoPublicItem(repo: RepoLite, at: number, everything: boolean): InboxItem {
  return { id: repoPublicItemId(repo.id, everything), kind: 'repoPublic', repo, what: repoPublicWhat(everything), actor: repo.ownerId, at, read: false }
}

/** "@owner made everything written while private public" at `at`, when Everything follows the flip (pure). */
export function everythingItem(repo: RepoLite, at: number): InboxItem {
  return { id: repoPublicItemId(repo.id, true), kind: 'repoPublic', repo, what: EVERYTHING_PUBLIC_WHAT, actor: repo.ownerId, at, read: false }
}

/** The repo of a feed as the readers take it. */
export function repoRefOf(forge: ForgeIds, repo: RepoLite): RepoRef {
  return { forge, repoId: repo.id, ownerId: repo.ownerId, name: repo.name, visibility: repo.private ? 'private' : 'public' }
}

const createdAt = (d: PlainDocument): number | null => (typeof d['$createdAt'] === 'number' && d['$createdAt'] > 0 ? d['$createdAt'] : null)

/**
 * When `repo` (public now, with its config timeline `configs`) was made public: its marker's
 * `$createdAt`, else `repoUpdatedAt` (the flip's), else its newest private config's (the seal-off
 * rotation's). Null when it was never made public.
 */
export function conversionAt(repo: RepoRef, configs: readonly PlainDocument[], repoUpdatedAt: number | null): number | null {
  const conversion = repoConversion(repo, configs)
  if (conversion === null) return null
  const marker = conversion.markerHeight === null ? undefined : configs.find((c) => c['vis'] !== 'private' && blockHeightOf(c) === conversion.markerHeight)
  const at = marker === undefined ? null : createdAt(marker)
  if (at !== null) return at
  if (repoUpdatedAt !== null) return repoUpdatedAt
  return configs.filter((c) => c['vis'] === 'private').reduce((m, c) => Math.max(m, createdAt(c) ?? 0), 0)
}

/** Whether `bundles` (an owner's make-public bundles' bytes) publish epoch keys of `repoId`: "Everything". One that does not parse publishes nothing. */
export function publishesHistory(repoId: string, bundles: readonly Uint8Array[]): boolean {
  const id = decodeIdentifier(repoId)
  return bundles.some((bytes) => {
    try {
      return parseBundle(bytes).entries.some((e) => e.kind === ENTRY_EPOCH_KEY && bytesEqual(e.target, id))
    } catch {
      return false
    }
  })
}

/** Every config of `repo` (its whole timeline). */
export function readConfigs(sdk: EvoSDK, repo: RepoRef): Promise<PlainDocument[]> {
  return queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.config, { orderBy: [['$createdAt', 'asc']] }))
}

/** The repo document's `$updatedAt`, or null when it can't be read. */
async function repoUpdatedAt(sdk: EvoSDK, repo: RepoRef): Promise<number | null> {
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractOf(repo.forge, DOC.repo), documentTypeName: DOC.repo, where: [['$id', '==', repo.repoId]], limit: 1 })
  const d = documents.find((x) => asIdentifierString(x['$id']) === repo.repoId)
  const u = d?.['$updatedAt']
  return typeof u === 'number' && u > 0 ? u : null
}

/**
 * The check of public `repo` for `me` (module docs): its item, if it was made public, and the
 * verdict to keep. A private repo is not checked yet (null verdict: ask again once it is public).
 * A read that fails throws: the repo is checked again next round.
 */
export async function repoPublicItems(sdk: EvoSDK, forge: ForgeIds, repo: RepoLite, me: string): Promise<{ readonly items: InboxItem[]; readonly verdict: RepoPublicVerdict | null }> {
  if (repo.private) return { items: [], verdict: null }
  const ref = repoRefOf(forge, repo)
  const configs = await readConfigs(sdk, ref)
  if (repoConversion(ref, configs) === null) return { items: [], verdict: 'never' }
  // The owner made it public: their own action never notifies them.
  if (me === repo.ownerId) return { items: [], verdict: 'done' }
  const hasMarker = repoConversion(ref, configs)?.markerHeight != null
  const at = conversionAt(ref, configs, hasMarker ? null : await repoUpdatedAt(sdk, ref))
  if (at === null) return { items: [], verdict: 'never' }
  const bundles = await readMakePublicBundles(sdk, ref)
  return { items: [repoPublicItem(repo, at, publishesHistory(repo.id, bundles.map((b) => b.bytes)))], verdict: 'done' }
}
