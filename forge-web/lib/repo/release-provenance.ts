/**
 * The inputs of a release's provenance (`lib/rules/releaseProvenance.ts`, epic E5): its tag's
 * update history and the config timeline, and the release's revisions. A public repo's history
 * comes from the repo chrome store when this tab holds it (usually no request at all), else
 * from one equality read per ref-update type and the config timeline; a private repo's from the
 * member's session.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { bytesToBase64 } from '../sdk'
import { provenanceAltered, releaseProvenance, type ConfigDoc, type ProvenanceRevision, type RefUpdate, type ReleaseProvenance } from '../rules'
import { repoChromeTimelines } from './chrome'
import { configBundleOf, readConfigBundle } from './config'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { readAllRefUpdates, readRefUpdates, refUpdatesFromRows } from './refs'
import type { ReleaseList, ReleaseView } from './releases'

/** A tag's update history and the config timeline it is judged by. */
export interface TagHistory {
  readonly refNameHash: string
  readonly updates: readonly RefUpdate[]
  readonly configs: readonly ConfigDoc[]
}

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The history of `refs/tags/<tag>`. */
export async function readTagHistory(sdk: EvoSDK, repo: RepoRef, tag: string): Promise<TagHistory> {
  const hash = refNameHash(`refs/tags/${tag}`)
  const b64 = bytesToBase64(hash)
  const stored = repo.visibility === 'public' ? await repoChromeTimelines(sdk, repo) : null
  if (stored !== null) {
    const [rows, config] = await Promise.all([stored.ref(b64), stored.config()])
    return {
      refNameHash: toHex(hash),
      updates: refUpdatesFromRows(repo, rows.refUpdate, rows.protectedRefUpdate, b64),
      configs: configBundleOf(repo, config).history,
    }
  }
  const [updates, bundle] = await Promise.all([readRefUpdates(sdk, repo, b64), readConfigBundle(sdk, repo)])
  return { refNameHash: toHex(hash), updates, configs: bundle.history }
}

const byKey = (a: ReleaseView, b: ReleaseView): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Every revision of `tag`'s release in `list`. A sealed revision lists its assets in its
 * encrypted manifest, not here, so its assets are left out (no change is claimed for them); the
 * target its first published revision records is the pin.
 */
export function tagRevisions(list: ReleaseList, tag: string): { revisions: ProvenanceRevision[]; pin: string | null } {
  const all = [...list.current, ...list.previous].filter((r) => r.tagName === tag)
  const unpublishes = (r: ReleaseView): boolean => r.delta < 0 || r.sealed?.fields.unpublished === true
  const revisions = all.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    delta: unpublishes(r) ? -1 : r.delta,
    publisher: r.publisher,
    assets: r.sealed ? [] : r.assets.map((a) => ({ name: a.name, sha256: a.sha256 })),
  }))
  const first = all.filter((r) => !unpublishes(r)).sort(byKey)[0]
  return { revisions, pin: first?.sealed?.fields.targetOid ?? null }
}

/** The provenance of `tag`'s release. */
export async function readReleaseProvenance(sdk: EvoSDK, repo: RepoRef, list: ReleaseList, tag: string): Promise<ReleaseProvenance> {
  const history = await readTagHistory(sdk, repo, tag)
  const { revisions, pin } = tagRevisions(list, tag)
  return releaseProvenance({ ...history, revisions, pin })
}

/**
 * The tags of `list`'s live releases whose provenance is altered (the tag moved, was deleted or
 * races, or the assets changed): the list marks them. One read of every ref's history, which a
 * releases page holds already (its tag tips came from it).
 */
export async function readAlteredReleaseTags(sdk: EvoSDK, repo: RepoRef, list: ReleaseList): Promise<ReadonlySet<string>> {
  const tags = [...new Set(list.current.map((r) => r.tagName))]
  if (tags.length === 0) return new Set()
  const stored = repo.visibility === 'public' ? await repoChromeTimelines(sdk, repo) : null
  let historyOf: (hash: Uint8Array) => readonly RefUpdate[]
  let configs: readonly ConfigDoc[]
  if (stored !== null) {
    const [rows, config] = await Promise.all([stored.refs(), stored.config()])
    historyOf = (hash) => refUpdatesFromRows(repo, rows.refUpdate, rows.protectedRefUpdate, bytesToBase64(hash))
    configs = configBundleOf(repo, config).history
  } else {
    const [all, bundle] = await Promise.all([readAllRefUpdates(sdk, repo), readConfigBundle(sdk, repo)])
    historyOf = (hash) => all.get(toHex(hash)) ?? []
    configs = bundle.history
  }
  const altered = new Set<string>()
  for (const tag of tags) {
    const hash = refNameHash(`refs/tags/${tag}`)
    const { revisions, pin } = tagRevisions(list, tag)
    const p = releaseProvenance({ refNameHash: toHex(hash), updates: historyOf(hash), configs, revisions, pin })
    if (provenanceAltered(p)) altered.add(tag)
  }
  return altered
}
