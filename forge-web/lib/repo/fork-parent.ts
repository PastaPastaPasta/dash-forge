/**
 * A fork's parent repository, for reads that reuse what the parent published (QW-023: a fork's
 * browse and history index). `forkOf` is immutable, and so are a repo's owner and name, so an
 * answer read from a document is kept for the session. A read that found no document (a node
 * behind the one that confirmed it) or failed is not kept. The repo chrome read seeds `forkOf`
 * ({@link noteForkOf}), so a repo opened through its home costs no extra query to learn it is
 * not a fork.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import type { RepoRef } from './contract'
import { readRepoById, repoRefOf } from './resolveRepo'

/** Repos whose answers are kept (the oldest dropped first); each entry is a few ids. */
const KEPT = 500

/** `forkOf` by repo (`core:repoId`), as a chrome read or a lookup found it. */
const forkOfs = new Map<string, string | null>()
/** The parent by repo, read or being read. */
const parents = new Map<string, Promise<RepoRef | null>>()

const keyOf = (forge: ForgeIds, repoId: string): string => `${forge.core}:${repoId}`

function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  for (const k of map.keys()) {
    if (map.size <= KEPT) break
    map.delete(k)
  }
}

/** Record a repo's `forkOf` (null: not a fork), read with its `repo` document. */
export function noteForkOf(forge: ForgeIds, repoId: string, forkOf: string | null): void {
  keep(forkOfs, keyOf(forge, repoId), forkOf)
}

/** Thrown inside a lookup whose answer must not be kept: a document that should exist was not found. */
class NotFound extends Error {}

/**
 * The public repository `repo` was forked from, or null when it is not a fork (or its parent is
 * not public: only public repos fork, so a private "parent" is never read through).
 */
export function readForkParent(sdk: EvoSDK, repo: RepoRef): Promise<RepoRef | null> {
  const key = keyOf(repo.forge, repo.repoId)
  const held = parents.get(key)
  if (held !== undefined) return held
  const read = (async (): Promise<RepoRef | null> => {
    let forkOf = forkOfs.get(key)
    if (forkOf === undefined) {
      const doc = await readRepoById(sdk, repo.forge, repo.repoId)
      if (doc === null) throw new NotFound()
      forkOf = doc.forkOf
      noteForkOf(repo.forge, repo.repoId, forkOf)
    }
    if (forkOf === null || forkOf === repo.repoId) return null
    const parent = await readRepoById(sdk, repo.forge, forkOf)
    if (parent === null) throw new NotFound()
    return parent.visibility !== 'public' ? null : repoRefOf(repo.forge, parent)
  })()
  // A document not found answers "no parent" now, and is asked again next time.
  const promise = read.catch((e: unknown) => {
    if (e instanceof NotFound) return null
    throw e
  })
  keep(parents, key, promise)
  read.catch(() => {
    if (parents.get(key) === promise) parents.delete(key)
  })
  return promise
}

/** Test hook: forget every parent and `forkOf` held. */
export function resetForkParents(): void {
  forkOfs.clear()
  parents.clear()
}
