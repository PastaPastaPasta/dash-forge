/**
 * One ref's update history and the config timeline it is judged by: the input of a release's
 * provenance (`lib/rules/releaseProvenance.ts`) and of a branch's or tag's Activity page
 * (`lib/rules/refHistory.ts`). A public repo's history comes from the repo chrome store when this
 * tab holds it (usually no request at all), else from one equality read per ref-update type and
 * the config timeline; a private repo's from the member's session.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'

import { bytesToBase64 } from '../sdk'
import type { ConfigDoc, RefUpdate } from '../rules'
import { repoChromeTimelines } from './chrome'
import { configBundleOf, readConfigBundle } from './config'
import type { RepoRef } from './contract'
import { refNameHash } from './push'
import { readRefUpdates, refUpdatesFromRows } from './refs'

/** A ref's update history and the config timeline it is judged by. */
export interface RefHistory {
  /** `sha256(refName)`, hex. */
  readonly refNameHash: string
  readonly updates: readonly RefUpdate[]
  readonly configs: readonly ConfigDoc[]
}

/** The history of `refName` (`refs/heads/main`, `refs/tags/v1.0`). */
export async function readRefHistory(sdk: EvoSDK, repo: RepoRef, refName: string): Promise<RefHistory> {
  const hash = refNameHash(refName)
  const b64 = bytesToBase64(hash)
  const stored = repo.visibility === 'public' ? await repoChromeTimelines(sdk, repo) : null
  if (stored !== null) {
    const [rows, config] = await Promise.all([stored.ref(b64), stored.config()])
    return {
      refNameHash: bytesToHex(hash),
      updates: refUpdatesFromRows(repo, rows.refUpdate, rows.protectedRefUpdate, b64),
      configs: configBundleOf(repo, config).history,
    }
  }
  const [updates, bundle] = await Promise.all([readRefUpdates(sdk, repo, b64), readConfigBundle(sdk, repo)])
  return { refNameHash: bytesToHex(hash), updates, configs: bundle.history }
}
