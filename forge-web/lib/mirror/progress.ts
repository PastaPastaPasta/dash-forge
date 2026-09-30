/**
 * The `/mirror` wizard is resumable (`ux-dx-spec.md` §1(b)): what each step settled is kept in
 * IndexedDB per network and identity, so a closed tab (or a trip to GitHub's settings) picks up
 * where it stopped. Only public facts are kept: names, ids, the chosen storage profile's name,
 * and the runner key's id and limits. Never a private key: the runner key is shown once.
 */

import { idbDelete, idbGet, idbPut } from '../idb'
import type { ResolvedRef } from '../repo/refs'
import type { GithubRepo } from './wizard'

/** A runner key the wizard registered: everything but its private key. */
export interface RunnerKeyRecord {
  /** Negative: the person added a runner key of their own (made with `dg`). */
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
  /**
   * The repository's refs ({@link refsFingerprint}) when the workflow step opened, before the
   * workflow could run: the first run is the first change from these. Null until read.
   */
  readonly refsBefore: string | null
  /** The person has added the workflow file on GitHub. */
  readonly workflowAdded: boolean
  /** When the wizard was first opened (ms): the start of the "under 10 minutes" clock. */
  readonly startedAt: number
  /** When this page first saw the mirror's first push on Platform (ms), or null. */
  readonly mirroredAt: number | null
}

export const EMPTY_PROGRESS: MirrorProgress = {
  github: null,
  repo: null,
  storage: null,
  runnerKey: null,
  refsBefore: null,
  workflowAdded: false,
  startedAt: 0,
  mirroredAt: null,
}

/** What an earlier answer invalidates: the workflow names it, and the wait watches for it. */
const DOWNSTREAM = { refsBefore: null, workflowAdded: false, mirroredAt: null } as const

const sameGithub = (a: GithubRepo | null, b: GithubRepo | null): boolean => a?.owner === b?.owner && a?.name === b?.name

/**
 * `p` with the answer `patch`. A different GitHub repository also clears the Forge repository;
 * a different GitHub repository, Forge repository, storage or runner key clears the workflow
 * and the wait, which were made for the old answer.
 */
export function withAnswer(p: MirrorProgress, patch: Partial<MirrorProgress>): MirrorProgress {
  const next = { ...p, ...patch }
  if ('github' in patch && !sameGithub(p.github, next.github)) return { ...next, repo: null, ...DOWNSTREAM }
  const changed =
    ('repo' in patch && next.repo?.repoId !== p.repo?.repoId) ||
    ('storage' in patch && next.storage !== p.storage) ||
    ('runnerKey' in patch && next.runnerKey?.keyId !== p.runnerKey?.keyId)
  // A patch that states the baseline itself (a repository just created has no refs) keeps it.
  return changed ? { ...next, ...DOWNSTREAM, ...('refsBefore' in patch ? { refsBefore: next.refsBefore } : {}) } : next
}

/**
 * The progress to show once this identity's `saved` record has loaded. Nothing saved: a fresh
 * start that keeps only the GitHub repository checked before signing in (never another
 * identity's answers). A repository checked before signing in wins over a saved one.
 */
export function resumed(now: MirrorProgress, saved: MirrorProgress | null, openedAt: number): MirrorProgress {
  if (saved === null) return { ...EMPTY_PROGRESS, github: now.github, startedAt: now.github !== null && now.startedAt ? now.startedAt : openedAt }
  return now.github !== null ? withAnswer(saved, { github: now.github }) : saved
}

/**
 * A repository's resolved branches and tags, as one comparable string. Unborn or diverged refs
 * are left out: a node that has not caught up could show one differently from the next read.
 */
export function refsFingerprint(refs: readonly ResolvedRef[]): string {
  return refs
    .flatMap((r) => (r.state.state === 'resolved' ? [`${r.refName} ${r.state.oid}`] : []))
    .sort()
    .join('\n')
}

/** `networkKey`: `devnet-bonsia`, not `devnet`, so a devnet reset does not resume old progress. */
const key = (networkKey: string, identityId: string): string => `mirror-wizard:${networkKey}:${identityId}`

/** The saved progress, or null. A record from an older shape is filled in with the defaults. */
export async function loadMirrorProgress(networkKey: string, identityId: string): Promise<MirrorProgress | null> {
  const v = await idbGet<MirrorProgress>('journal', key(networkKey, identityId))
  return v && typeof v === 'object' && 'startedAt' in v ? { ...EMPTY_PROGRESS, ...v } : null
}

export function saveMirrorProgress(networkKey: string, identityId: string, progress: MirrorProgress): Promise<void> {
  return idbPut('journal', key(networkKey, identityId), progress)
}

export function clearMirrorProgress(networkKey: string, identityId: string): Promise<void> {
  return idbDelete('journal', key(networkKey, identityId))
}
