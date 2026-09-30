/**
 * A fork's parent repository, for reads that reuse what the parent published (QW-023: a fork's
 * browse and history index). `forkOf` is immutable, and so are a repo's owner and name, so an
 * answer is kept for the session; a failed read is not. The repo chrome read seeds `forkOf`
 * ({@link noteForkOf}), so a repo opened through its home costs no extra query to learn it is
 * not a fork.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import type { RepoRef } from './contract'
import { readRepoById, repoRefOf } from './resolveRepo'

/** `forkOf` by repo (`core:repoId`), as a chrome read or a lookup found it. */
const forkOfs = new Map<string, string | null>()
/** The parent by repo, read or being read. */
const parents = new Map<string, Promise<RepoRef | null>>()

const keyOf = (forge: ForgeIds, repoId: string): string => `${forge.core}:${repoId}`

/** Record a repo's `forkOf` (null: not a fork), read with its `repo` document. */
export function noteForkOf(forge: ForgeIds, repoId: string, forkOf: string | null): void {
  forkOfs.set(keyOf(forge, repoId), forkOf)
}

/**
 * The public repository `repo` was forked from, or null when it is not a fork (or its parent is
 * gone, or not public: only public repos fork, so a private "parent" is never read through).
 */
export function readForkParent(sdk: EvoSDK, repo: RepoRef): Promise<RepoRef | null> {
  const key = keyOf(repo.forge, repo.repoId)
  const held = parents.get(key)
  if (held !== undefined) return held
  const promise = (async (): Promise<RepoRef | null> => {
    let forkOf = forkOfs.get(key)
    if (forkOf === undefined) {
      forkOf = (await readRepoById(sdk, repo.forge, repo.repoId))?.forkOf ?? null
      forkOfs.set(key, forkOf)
    }
    if (forkOf === null || forkOf === repo.repoId) return null
    const parent = await readRepoById(sdk, repo.forge, forkOf)
    return parent === null || parent.visibility !== 'public' ? null : repoRefOf(repo.forge, parent)
  })()
  parents.set(key, promise)
  promise.catch(() => {
    if (parents.get(key) === promise) parents.delete(key)
  })
  return promise
}

/** Test hook: forget every parent and `forkOf` held. */
export function resetForkParents(): void {
  forkOfs.clear()
  parents.clear()
}
