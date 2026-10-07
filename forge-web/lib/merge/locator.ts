/**
 * The browse-index fragment for a pack a browser merge just recorded — the port of forge-core
 * `RepoService::publish_push_locator` (fragment path) and `plan_push_index`:
 *
 *  - the pack's `packRef` is its position in the repo's kind-0 pack list (`v2_pack_list`),
 *    read AFTER its manifest landed, so it is the position every reader derives;
 *  - nothing is published when a live fragment was built over a different pack list (a
 *    repack landed concurrently) or when the list is past the 16-bit `packRef`;
 *  - at 16 live fragments the CLI folds them into one locator. Folding needs every fragment's
 *    bytes, so the browser leaves it to the next CLI push or `dg repack` and publishes nothing:
 *    the repo then browses by the in-browser clone, which is always correct.
 *
 * A failure here is not a failed merge (the CLI treats it the same way): the pack, its
 * manifest and the ref are what make the merge; the index only makes it browse faster.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { PACK_KIND } from '../constants'
import { plannedSuperseded, readRepoPackManifests, packsOfKind, type PackManifest, type RepoRef } from '../repo'
import { writePackManifest } from '../repo/push'
import type { WriteAuth } from '../sdk'
import type { UploadPack } from './runner'

/** Live fragments at which the CLI folds instead of adding one (forge-core `MAX_LOCATOR_FRAGMENTS`). */
export const MAX_LOCATOR_FRAGMENTS = 16

export type FragmentPlan = { readonly kind: 'publish'; readonly packRef: number } | { readonly kind: 'skip'; readonly reason: string; readonly retry: boolean }

/** Where the fragment for `packHash` goes, from the repo's manifests (forge-core `plan_push_index`). */
export function planFragment(manifests: readonly PackManifest[], packHash: string): FragmentPlan {
  const space = packsOfKind(manifests, PACK_KIND.GIT_PACK)
  const idx = space.findIndex((p) => p.packHash.toLowerCase() === packHash.toLowerCase())
  if (idx < 0) return { kind: 'skip', reason: 'the merge pack is not in the pack list yet', retry: true }
  if (idx > 0xffff) return { kind: 'skip', reason: `the pack list has ${space.length} packs, past the index's 16-bit packRef; run \`dg repack\``, retry: false }
  // Live as forge-core `live_locator_manifests` counts them: a fragment is retired only by a
  // current maintainer's or writer's fragment naming it (the pack list's `superseded` needs
  // verified bytes, which a plan never reads).
  const superseded = plannedSuperseded(manifests, PACK_KIND.OBJECT_LOCATOR)
  const live = packsOfKind(manifests, PACK_KIND.OBJECT_LOCATOR).filter((p) => !superseded.has(p.packHash.toLowerCase()))
  for (const f of live) {
    const asOf = packsOfKind(manifests, PACK_KIND.GIT_PACK, { createdAt: f.createdAt, id: f.documentId })
    if (asOf.length > space.length || asOf.some((p, i) => p.packHash !== space[i]?.packHash)) {
      return { kind: 'skip', reason: 'a published index fragment no longer matches the pack list; run `dg repack` to rebuild it', retry: false }
    }
  }
  if (live.length >= MAX_LOCATOR_FRAGMENTS) {
    return { kind: 'skip', reason: `${live.length} index fragments are live; the next CLI push or \`dg repack\` merges them`, retry: false }
  }
  return { kind: 'publish', packRef: idx }
}

/** The objectLocator fragment of one pack at `packRef` (fanout + rows, every row by the per-base walk). */
export async function buildFragment(pack: Uint8Array, packRef: number): Promise<{ bytes: Uint8Array; objectCount: number }> {
  const { indexPacks, serializeLocator } = await import('../browse/indexer')
  const rows = (await indexPacks([pack])).map((r) => ({ ...r, packRef }))
  return { bytes: serializeLocator(rows), objectCount: rows.length }
}

/** What publishing the fragment did. */
export type IndexOutcome = { readonly kind: 'published'; readonly manifestId: string; readonly packRef: number } | { readonly kind: 'skipped'; readonly reason: string }

/**
 * Build, store (through `upload`, the same storage policy as the pack) and record the
 * fragment for a pack whose manifest has landed. Retries the pack-list read briefly: a node
 * one block behind may not list the new manifest yet.
 */
export async function publishMergeIndex(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  pack: Uint8Array,
  packHash: string,
  upload: UploadPack,
  intent: string,
): Promise<IndexOutcome> {
  let plan: FragmentPlan = { kind: 'skip', reason: 'not read', retry: true }
  for (let attempt = 0; attempt < 8; attempt++) {
    plan = planFragment(await readRepoPackManifests(sdk, repo), packHash)
    if (plan.kind === 'publish' || !plan.retry) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (plan.kind === 'skip') return { kind: 'skipped', reason: plan.reason }
  const { IndexTooLargeError } = await import('../browse/indexer')
  let fragment: Awaited<ReturnType<typeof buildFragment>>
  try {
    fragment = await buildFragment(pack, plan.packRef)
  } catch (e) {
    if (e instanceof IndexTooLargeError) {
      return { kind: 'skipped', reason: 'the pack is too large to index in the browser; the next CLI push or `dg repack` indexes it' }
    }
    throw e
  }
  const fragmentHash = bytesToHex(sha256(fragment.bytes))
  const stored = await upload(fragment.bytes, { packHash: fragmentHash, objectCount: fragment.objectCount })
  const w = await writePackManifest(
    sdk,
    auth,
    repo,
    { packHash: fragmentHash, kind: PACK_KIND.OBJECT_LOCATOR, sizeBytes: fragment.bytes.length, objectCount: fragment.objectCount, ...stored },
    intent,
  )
  return { kind: 'published', manifestId: w.documentId, packRef: plan.packRef }
}
