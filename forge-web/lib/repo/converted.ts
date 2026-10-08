/**
 * A repository made public (`docs/security/private-repos.md` §18; DESIGN §4.10), as the web
 * reads it (forge-core `Keyring::resolve_conversion`, `RepoService::make_public_bundles`):
 *
 * - its conversion facts, from its config timeline alone: public now, with a config stamped
 *   `vis: "private"` (`conversionOf`). The page's own config read records them here
 *   ({@link recordConversion}), so the content gate and the browse plane know without a read;
 * - the epoch keys its owner published in make-public bundles (`packManifest` kind 7, written by
 *   the repo owner), each checked against its epoch's anchor and added to a reader's keys
 *   ({@link withPublishedKeys}). Members and everyone else get them alike; a bundle that cannot be
 *   read publishes nothing and never fails a page.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { PACK_KIND } from '../constants'
import { addPublished, conversionOf, publishedKeys, type ConfigStamp, type Conversion, type EpochResolution, type PublishedBundle } from '../private'
import type { PlainDocument } from '../sdk'
import { withoutSessions, type RepoRef } from './contract'
import { readManifestsOfKind, type PackManifest } from './packs'
import { blockHeightOf, idField } from './private-content'

/** Every `config` document as the conversion facts take it (forge-core `config_stamps`); one without an id is left out. */
export function configStamps(rows: readonly PlainDocument[]): ConfigStamp[] {
  return rows.flatMap((d) => {
    const id = idField(d, '$id')
    if (id === undefined) return []
    const epoch = d['epoch']
    return [{ id, epoch: typeof epoch === 'number' ? epoch : null, private: d['vis'] === 'private', height: blockHeightOf(d) ?? 0 }]
  })
}

/**
 * The conversion facts of `repo` from its config timeline (`rows`), null for a repo never made
 * public. `existing` says which epochs exist; by default every one (the marker needs none, and
 * the keys are checked against the anchors anyway).
 */
export function repoConversion(repo: RepoRef, rows: readonly PlainDocument[], existing: (epoch: number) => boolean = () => true): Conversion | null {
  return conversionOf(repo.visibility === 'public', configStamps(rows), existing)
}

/** What each public repo's config timeline said, by repo id: its conversion facts, or null. */
const conversions = new Map<string, Conversion | null>()

/** Record what a public repo's complete config timeline says about its conversion. */
export function recordConversion(repo: RepoRef, rows: readonly PlainDocument[]): void {
  conversions.set(repo.repoId, repoConversion(repo, rows))
}

/** The conversion facts the page's config read recorded: null (never private), undefined (not read yet). */
export function knownConversion(repoId: string): Conversion | null | undefined {
  return conversions.get(repoId)
}

/**
 * `resolution` with the epoch keys `repo`'s owner published in `bundles` (checked against its
 * anchors, below the seal-off epoch) and the chains they reach, plus any mismatch alert. Unchanged
 * when nothing may be published.
 */
export async function withPublishedKeys(
  resolution: EpochResolution,
  repoId: Uint8Array,
  repo: RepoRef,
  conversion: Conversion,
  bundles: readonly PublishedBundle[],
): Promise<EpochResolution> {
  if (conversion.sealOffEpoch === null || bundles.length === 0) return resolution
  const { keys, alerts } = await publishedKeys(repoId, decodeIdentifier(repo.ownerId), conversion, resolution.anchors, bundles)
  return addPublished(resolution, repoId, keys, alerts)
}

/**
 * Every make-public bundle (kind 7) the owner of public `repo` recorded, each copy's bytes checked
 * against its `packHash` as any stored artifact's are. A bundle no copy of which can be read is
 * left out: it publishes nothing.
 */
export async function readMakePublicBundles(sdk: EvoSDK, repo: RepoRef): Promise<PublishedBundle[]> {
  if (repo.visibility !== 'public') return []
  const manifests = (await readManifestsOfKind(sdk, repo, PACK_KIND.MAKE_PUBLIC)).filter((m) => m.uploader === repo.ownerId)
  if (manifests.length === 0) return []
  const byHash = new Map<string, PackManifest[]>()
  for (const m of manifests) {
    const h = m.packHash.toLowerCase()
    byHash.set(h, [...(byHash.get(h) ?? []), m])
  }
  // Loaded on demand: the browse plane reads through the session module this one feeds.
  const { loadStoredArtifactBytes } = await import('../view/browse-source')
  const plain = withoutSessions(repo)
  const owner = decodeIdentifier(repo.ownerId)
  const out: PublishedBundle[] = []
  for (const copies of byHash.values()) {
    const first = copies[0] as PackManifest
    try {
      out.push({ owner, bytes: await loadStoredArtifactBytes(sdk, plain, { ...first, copies }) })
    } catch {
      // unreadable: it publishes nothing
    }
  }
  return out
}
