/**
 * The `/mirror` wizard is resumable (`ux-dx-spec.md` §1(b)): what each step settled is kept in
 * IndexedDB per network and identity, so a closed tab (or a trip to GitHub's settings) picks up
 * where it stopped. Only public facts are kept: names, ids, the chosen storage profile's name,
 * and the runner key's id and limits. Never a private key: the runner key is shown once.
 */

import { idbDelete, idbGet, idbPut } from '../idb'
import type { Network } from '../constants'
import type { GithubRepo } from './wizard'

/** A runner key the wizard registered: everything but its private key. */
export interface RunnerKeyRecord {
  readonly keyId: number
  readonly budgetCredits: string
  readonly expiresAt: number
  /** The person ticked "I added it to GitHub" (the page advances only then). */
  readonly saved: boolean
}

export interface MirrorProgress {
  readonly github: GithubRepo | null
  /** The Forge repository the mirror writes to, once it exists (created here or picked). */
  readonly repo: { readonly repoId: string; readonly name: string } | null
  /** The storage profile's name, or `platform`. */
  readonly storage: string | null
  readonly runnerKey: RunnerKeyRecord | null
  /** The person has added the workflow file on GitHub. */
  readonly workflowAdded: boolean
  /** When the wizard was first opened (ms): the start of the "under 10 minutes" clock. */
  readonly startedAt: number
  /** When this page first saw the mirror's refs on Platform (ms), or null. */
  readonly mirroredAt: number | null
}

export const EMPTY_PROGRESS: MirrorProgress = { github: null, repo: null, storage: null, runnerKey: null, workflowAdded: false, startedAt: 0, mirroredAt: null }

const key = (network: Network, identityId: string): string => `mirror-wizard:${network}:${identityId}`

/** The saved progress, or null. A record from an older shape is ignored. */
export async function loadMirrorProgress(network: Network, identityId: string): Promise<MirrorProgress | null> {
  const v = await idbGet<MirrorProgress>('journal', key(network, identityId))
  return v && typeof v === 'object' && 'startedAt' in v ? { ...EMPTY_PROGRESS, ...v } : null
}

export function saveMirrorProgress(network: Network, identityId: string, progress: MirrorProgress): Promise<void> {
  return idbPut('journal', key(network, identityId), progress)
}

export function clearMirrorProgress(network: Network, identityId: string): Promise<void> {
  return idbDelete('journal', key(network, identityId))
}
