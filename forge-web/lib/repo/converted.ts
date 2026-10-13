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
 * Every make-public bundle (kind 7) of public `repo` recorded by one of `uploaders` (base58; by
 * default the repo's owner alone, whose 0x06 entries {@link withPublishedKeys} reads), each copy's
 * bytes checked against its `packHash` as any stored artifact's are, with its uploader as the
 * bundle's author. A maintainer's bundle of documents (`made-public.ts`) passes the current
 * maintainers and the owner: anyone else's is never downloaded. A bundle no copy of which can be
 * read is left out: it publishes nothing.
 */
export async function readMakePublicBundles(sdk: EvoSDK, repo: RepoRef, uploaders: ReadonlySet<string> = new Set([repo.ownerId])): Promise<PublishedBundle[]> {
  if (repo.visibility !== 'public') return []
  const manifests = (await readManifestsOfKind(sdk, repo, PACK_KIND.MAKE_PUBLIC)).filter((m) => uploaders.has(m.uploader))
  if (manifests.length === 0) return []
  // One bundle per (author, bytes): the same bytes recorded by two maintainers are two bundles.
  const byAuthorHash = new Map<string, PackManifest[]>()
  for (const m of manifests) {
    const k = `${m.uploader}:${m.packHash.toLowerCase()}`
    byAuthorHash.set(k, [...(byAuthorHash.get(k) ?? []), m])
  }
  // Loaded on demand: the browse plane reads through the session module this one feeds.
  const { loadStoredArtifactBytes } = await import('../view/browse-source')
  const plain = withoutSessions(repo)
  const out: PublishedBundle[] = []
  // In forge-core's order (by uploader, then by hash), so where two maintainers' entries name one
  // revision both stacks credit the same one.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const order = [...byAuthorHash.values()].sort((a, b) => cmp(a[0]!.uploader, b[0]!.uploader) || cmp(a[0]!.packHash.toLowerCase(), b[0]!.packHash.toLowerCase()))
  for (const copies of order) {
    const first = copies[0] as PackManifest
    try {
      out.push({ owner: decodeIdentifier(first.uploader), bytes: await loadStoredArtifactBytes(sdk, plain, { ...first, copies }) })
    } catch {
      // unreadable: it publishes nothing
    }
  }
  return out
}
