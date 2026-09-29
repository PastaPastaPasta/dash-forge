/**
 * The header jump box (`ux-dx-spec.md` §5.2, §5.11): `owner/name`, `owner/name#n`, `@name`,
 * `#n` inside a repo (issue or PR n of it), and a bare word, which may be a repo name or a
 * profile, so both are looked up ({@link resolveWord}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { asIdentifierString, DOC, repoSource, resolveOwner, type RepoRef } from '../repo'
import { queryDocumentsWithProof } from '../sdk'
import { reposNamed, type DiscoveredRepo } from './discovery'
import { importedUrlOf, type ForgeRepo } from './ref-targets'
import { isIdentityId } from '../utils'

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
  if (w) return isIdentityId(q) ? { kind: 'profile', name: q } : { kind: 'word', word: w[1] ?? '' }
  return { kind: 'invalid', message: 'type owner/name, @name, or #n inside a repo' }
}

/** What a bare word names: repos called that (any owner) and the profile it resolves to. */
export interface WordMatches {
  readonly repos: readonly DiscoveredRepo[]
  /** More owners use the name than were read (`NAMED_MAX`). */
  readonly moreRepos: boolean
  /** The identity the word resolves to as a DPNS name, or null. */
  readonly profile: string | null
  /** A side whose lookup failed: its "nothing found" is not an answer. */
  readonly reposFailed: boolean
  readonly profileFailed: boolean
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
 * failing leaves the other's answer, flagged; both failing is an error.
 */
export async function resolveWord(sdk: EvoSDK, word: string, network: Network): Promise<WordMatches> {
  const [repos, profile] = await Promise.allSettled([reposNamed(sdk, word, { network }), resolveOwner(sdk, word)])
  if (repos.status === 'rejected' && profile.status === 'rejected') throw repos.reason
  return {
    repos: repos.status === 'fulfilled' ? repos.value.repos : [],
    moreRepos: repos.status === 'fulfilled' && repos.value.more,
    profile: profile.status === 'fulfilled' ? profile.value : null,
    reposFailed: repos.status === 'rejected',
    profileFailed: profile.status === 'rejected',
  }
}

/**
 * Pick where a word goes (pure). Straight there only when both lookups answered and exactly
 * one thing matched; a failed side, or more owners than were read, always shows the choice.
 */
export function wordTarget(m: WordMatches): WordTarget {
  const total = m.repos.length + (m.profile === null ? 0 : 1)
  const certain = !m.reposFailed && !m.profileFailed && !m.moreRepos
  if (total === 0 && certain) return { kind: 'none' }
  if (total !== 1 || !certain) return { kind: 'choose', matches: m }
  const [repo] = m.repos
  if (repo !== undefined) return { kind: 'repo', repo }
  return m.profile !== null ? { kind: 'profile', identityId: m.profile } : { kind: 'none' }
}

/** Which of issue n and PR n exist in `repo` (a `(repoId, number)` lookup each). */
export async function numberTargets(sdk: EvoSDK, repo: RepoRef, number: number): Promise<{ issue: boolean; pull: boolean }> {
  const found = await numberRows(sdk, repo, number)
  return { issue: found.issue !== null, pull: found.pull !== null }
}

/** An issue or PR row found at a number: its `imported.url` ('' when written here) and author. */
export interface NumberRow {
  readonly importedUrl: string
  readonly owner: string
}

/** Issue n and PR n of `repo`, when they exist (a `(repoId, number)` lookup each). */
export async function numberRows(sdk: EvoSDK, repo: RepoRef, number: number): Promise<{ issue: NumberRow | null; pull: NumberRow | null }> {
  const row = async (type: string): Promise<NumberRow | null> => {
    const { documents } = await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(type, { where: [['number', '==', number]], limit: 1 }))
    const doc = documents[0]
    return doc === undefined ? null : { importedUrl: importedUrlOf(doc['imported']), owner: asIdentifierString(doc['$ownerId']) }
  }
  const [issue, pull] = await Promise.all([row(DOC.issue), row(DOC.patch)])
  return { issue, pull }
}

/**
 * Whether `row` is the one a mirror's import wrote for upstream item `n` of `source`: its
 * `imported.url` is that item (`https://github.com/o/r/issues/n`, `…/pull/n`,
 * `…/-/merge_requests/n`) and its author is one the repo trusts to number items (the owner or a
 * maintainer, `forge-v2.md` §6). Anyone may write an `imported` record, so a squatter at `n`
 * claiming to be it is not; nor is a native issue there, or an upstream item moved elsewhere.
 */
export function isUpstreamItem(row: NumberRow, n: number, source: ForgeRepo, trusted: ReadonlySet<string>): boolean {
  if (!trusted.has(row.owner)) return false
  const prefix = `https://${source.host}/${source.path}/`
  if (!row.importedUrl.toLowerCase().startsWith(prefix.toLowerCase())) return false
  const m = /^(?:-\/)?(?:issues|pull|merge_requests)\/(\d+)\/?(?:[?#].*)?$/.exec(row.importedUrl.slice(prefix.length))
  return m !== null && Number(m[1]) === n
}
