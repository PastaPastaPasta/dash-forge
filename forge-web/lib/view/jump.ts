/**
 * The header jump box (`ux-dx-spec.md` §5.2, §5.11): `owner/name`, `owner/name#n`, `@name`,
 * `#n` inside a repo (issue or PR n of it), and a bare word, which may be a repo name or a
 * profile, so both are looked up ({@link resolveWord}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { DOC, repoSource, resolveOwner, type RepoRef } from '../repo'
import { queryDocumentsWithProof } from '../sdk'
import { reposNamed, type DiscoveredRepo } from './discovery'

export type Jump =
  | { readonly kind: 'repo'; readonly owner: string; readonly name: string; readonly number?: number }
  | { readonly kind: 'number'; readonly number: number }
  /** `@name` or an identity id: only a profile. */
  | { readonly kind: 'profile'; readonly name: string }
  /** A bare word: a repo name, a DPNS name, or both. */
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'invalid'; readonly message: string }

const NUMBER = /^#(\d{1,10})$/
const REPO = /^@?([^\s/#@]+)\/([^\s/#]+?)(?:#(\d{1,10}))?$/
const PROFILE = /^@([^\s/#@]+)$/
const WORD = /^([^\s/#@]+)$/
/** A base58 identity id (32 bytes): a profile, never a repo name (those are lowercase). */
const IDENTITY = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/

/** Parse what was typed. `inRepo`: the page is a repo page, so `#n` has a repo to mean. */
export function parseJump(input: string, inRepo: boolean): Jump | null {
  const q = input.trim()
  if (q === '') return null
  const n = NUMBER.exec(q)
  if (n) {
    if (!inRepo) return { kind: 'invalid', message: '#n works inside a repo; try owner/name#n' }
    return { kind: 'number', number: Number(n[1]) }
  }
  const r = REPO.exec(q)
  if (r) {
    const owner = r[1] ?? ''
    return r[3] === undefined ? { kind: 'repo', owner, name: r[2] ?? '' } : { kind: 'repo', owner, name: r[2] ?? '', number: Number(r[3]) }
  }
  const p = PROFILE.exec(q)
  if (p) return { kind: 'profile', name: p[1] ?? '' }
  const w = WORD.exec(q)
  if (w) return IDENTITY.test(q) ? { kind: 'profile', name: q } : { kind: 'word', word: w[1] ?? '' }
  return { kind: 'invalid', message: 'type owner/name, @name, or #n inside a repo' }
}

/** What a bare word names: repos called that (any owner) and the profile it resolves to. */
export interface WordMatches {
  readonly repos: readonly DiscoveredRepo[]
  /** The identity the word resolves to as a DPNS name, or null. */
  readonly profile: string | null
}

/** Where a word's matches lead: straight there when there is exactly one, else a choice. */
export type WordTarget =
  | { readonly kind: 'repo'; readonly repo: DiscoveredRepo }
  | { readonly kind: 'profile'; readonly identityId: string }
  | { readonly kind: 'choose'; readonly matches: WordMatches }
  | { readonly kind: 'none' }

/**
 * Look a bare word up both ways, in parallel: repos named it (the `repo.name` index, one
 * composite with their counts and owners' names) and the DPNS name (one `resolveName`). Either
 * failing leaves the other's answer; both failing is an error.
 */
export async function resolveWord(sdk: EvoSDK, word: string, network: Network): Promise<WordMatches> {
  const [repos, profile] = await Promise.allSettled([reposNamed(sdk, word, { network }), resolveOwner(sdk, word)])
  if (repos.status === 'rejected' && profile.status === 'rejected') throw repos.reason
  return {
    repos: repos.status === 'fulfilled' ? repos.value : [],
    profile: profile.status === 'fulfilled' ? profile.value : null,
  }
}

/** Pick where a word goes (pure). */
export function wordTarget(m: WordMatches): WordTarget {
  const total = m.repos.length + (m.profile === null ? 0 : 1)
  if (total === 0) return { kind: 'none' }
  if (total > 1) return { kind: 'choose', matches: m }
  const [repo] = m.repos
  return repo !== undefined ? { kind: 'repo', repo } : { kind: 'profile', identityId: m.profile as string }
}

/** Which of issue n and PR n exist in `repo` (a `(repoId, number)` lookup each). */
export async function numberTargets(sdk: EvoSDK, repo: RepoRef, number: number): Promise<{ issue: boolean; pull: boolean }> {
  const exists = async (type: string): Promise<boolean> => {
    const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(type, { where: [['number', '==', number]], limit: 1 }))
    return documents.length > 0
  }
  const [issue, pull] = await Promise.all([exists(DOC.issue), exists(DOC.patch)])
  return { issue, pull }
}
