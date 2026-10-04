/**
 * Who may have signed a repository's commits (P1-7, signed-commit badges): its owner and its
 * current members of every role, each with the signing keys their `profile.pubkeys` lists. A
 * commit's verdict (`lib/rules/signature.ts`) names one of them, or nobody.
 *
 * Reads: the repository's memberships (cached per repo, shared with the commit page's check
 * runs) and one proved `profile` query for up to {@link IN_MAX} identities. Pages read it only
 * once they show a signed commit, so an unsigned history costs nothing. Cached per repo for a
 * few minutes, like the memberships. Parity: `forge_core::rules::signature` with dg's
 * `verify-commit`, which reads the same candidates.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { Signer } from '../rules/signature'
import { queryDocuments } from '../sdk'
import { DOC, repoKey, type RepoRef } from './contract'
import { readMembershipsCached } from './members'
import { profileFromDoc } from './profile'

/** Platform's `in` bound: at most this many identities per profile query. */
const IN_MAX = 100
/** How long a repo's signers are believed (keys change rarely; a profile edit shows on reload). */
const SIGNERS_TTL_MS = 5 * 60_000

const cache = new Map<string, { at: number; promise: Promise<Signer[]> }>()

/** The repo's owner and members, and `extra` (a pull request's author). */
async function candidates(sdk: EvoSDK, repo: RepoRef, network: Network, extra: readonly string[]): Promise<string[]> {
  const members = await readMembershipsCached(sdk, repo, network)
  return [...new Set([repo.ownerId, ...members.map((m) => m.identity), ...extra])]
}

/** The signing keys `identities` list in their profiles (identities with none are left out). */
export async function readSigningKeys(sdk: EvoSDK, community: string, identities: readonly string[]): Promise<Signer[]> {
  const sorted = [...new Set(identities)].sort()
  const out: Signer[] = []
  for (let i = 0; i < sorted.length; i += IN_MAX) {
    const docs = await queryDocuments(sdk, {
      dataContractId: community,
      documentTypeName: DOC.profile,
      where: [['$ownerId', 'in', sorted.slice(i, i + IN_MAX)]],
      orderBy: [['$ownerId', 'asc']],
      limit: IN_MAX,
    })
    for (const d of docs) {
      const p = profileFromDoc(d)
      if (p.pubkeys.length > 0) out.push({ identity: p.owner, pubkeys: p.pubkeys })
    }
  }
  return out
}

/**
 * The repo's candidate signers with their keys, and `extra`'s (a pull request's commits may be its
 * author's, who need not be a member); cached per repo and extras. A failed read is not cached.
 */
export function readRepoSigners(sdk: EvoSDK, repo: RepoRef, network: Network = DEFAULT_NETWORK, extra: readonly string[] = []): Promise<Signer[]> {
  const key = `${network}:${repoKey(repo)}:${[...extra].sort().join(',')}`
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < SIGNERS_TTL_MS) return hit.promise
  const promise = candidates(sdk, repo, network, extra).then((ids) => readSigningKeys(sdk, repo.forge.community, ids))
  const entry = { at: Date.now(), promise }
  cache.set(key, entry)
  promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return promise
}

/** Forget a repo's cached signers (this browser just changed its own keys). */
export function forgetRepoSigners(): void {
  cache.clear()
}
