/**
 * Maintainer bans (UPDATE-1 `ban`, `forge-v2.md` §3.2): the repo's ban documents, read once per
 * repo for a while and shared by its thread pages, lists and the inbox; a maintainer's ban and lift;
 * and the refusal of a banned identity's writes before signing. The reader rule is
 * `lib/rules/bans.ts` (parity with forge-core `rules::bans`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import { decodeIdentifier } from '../auth/base58'
import { createDocumentIdempotent, deleteDocumentIdempotent, queryAllDocuments, type PlainDocument, type WriteAuth, type WriteResult } from '../sdk'
import { banReasonLabel, standingBans, type Ban } from '../rules/bans'
import type { Membership } from '../rules/v2'
import { asIdentifierString, num, str, type RepoRef } from './contract'
import { readMembershipsCached } from './members'
import { repoSource } from './source'

/** forge-collab's ban type. */
export const DOC_BAN = 'ban'

/** How long a repo's bans read are reused. */
const BANS_TTL_MS = 2 * 60_000

const cache = new Map<string, { readonly at: number; readonly read: Promise<Ban[]> }>()
const keyOf = (repo: RepoRef): string => `${repo.forge.collab}:${repo.repoId}`

/** A `ban` document as a {@link Ban}; null when it names no identity. */
export function banOf(doc: PlainDocument): Ban | null {
  const identity = asIdentifierString(doc['identityId'])
  if (identity === '') return null
  const reason = typeof doc['reason'] === 'number' ? num(doc, 'reason') : null
  return { id: str(doc, '$id'), identity, by: str(doc, '$ownerId'), reason, createdAt: num(doc, '$createdAt') }
}

/**
 * Every ban document of `repo`, as stored (one read per repo every {@link BANS_TTL_MS}). A failed
 * read (or a contract without bans) is none: a reader never fails over it.
 */
export function readBans(sdk: EvoSDK, repo: RepoRef): Promise<Ban[]> {
  const key = keyOf(repo)
  const held = cache.get(key)
  if (held !== undefined && Date.now() - held.at < BANS_TTL_MS) return held.read
  const read = queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC_BAN, { orderBy: [['identityId', 'asc']] }))
    .then((docs) => docs.flatMap((d) => banOf(d) ?? []))
    .catch((): Ban[] => {
      cache.delete(key)
      return []
    })
  cache.set(key, { at: Date.now(), read })
  return read
}

/** Forget `repo`'s bans read (after a ban or a lift here). */
export function invalidateBans(repo: RepoRef): void {
  cache.delete(keyOf(repo))
}

/** The standing ban of each banned identity in `repo`, judged with `members` (its members now). */
export function standingOf(repo: RepoRef, bans: readonly Ban[], members: readonly Membership[]): ReadonlyMap<string, Ban> {
  if (bans.length === 0) return new Map()
  return standingBans(bans, { owner: repo.ownerId, maintainers: members.filter((m) => m.role === 'maintainer').map((m) => m.identity) })
}

/**
 * The standing bans of `repo` (its bans, and its members only when there is one). When the members
 * cannot be read, no ban is applied: judging without them would drop every maintainer's ban.
 */
export async function readStandingBans(sdk: EvoSDK, repo: RepoRef, network: Network, members?: readonly Membership[]): Promise<ReadonlyMap<string, Ban>> {
  return (await readBanState(sdk, repo, network, members)).standing
}

/** A repo's bans as stored, the members they are judged with, and the standing ban per identity. */
export interface BanState {
  readonly raw: readonly Ban[]
  readonly members: readonly Membership[]
  readonly standing: ReadonlyMap<string, Ban>
  /** There are bans, but the members could not be read: none is applied (`standing` empty). */
  readonly membersUnread?: true
}

/** {@link readStandingBans} with what it was judged from (Settings → Bans shows every writer). */
export async function readBanState(sdk: EvoSDK, repo: RepoRef, network: Network, members?: readonly Membership[]): Promise<BanState> {
  const raw = await readBans(sdk, repo)
  if (raw.length === 0) return { raw, members: members ?? [], standing: new Map() }
  const known = members ?? (await readMembershipsCached(sdk, repo, network).catch(() => null))
  if (known === null) return { raw, members: [], standing: new Map(), membersUnread: true }
  return { raw, members: known, standing: standingOf(repo, raw, known) }
}

/** The bans of `identity` whose writers count now (the owner or a current maintainer), oldest first. */
export function countingBansOf(state: BanState, repo: RepoRef, identity: string): Ban[] {
  const mods = new Set([repo.ownerId, ...state.members.filter((m) => m.role === 'maintainer').map((m) => m.identity)])
  return state.raw.filter((b) => b.identity === identity && mods.has(b.by)).sort((a, b) => a.createdAt - b.createdAt)
}

/** A banned identity's write, refused before signing. */
export class BannedError extends Error {
  constructor(readonly ban: Ban) {
    const why = banReasonLabel(ban.reason)
    super(`A maintainer banned you from this repository${why !== null ? ` (${why})` : ''}, so Forge doesn't post your issues, pull requests, comments or reviews here.`)
    this.name = 'BannedError'
  }
}

/**
 * Throw {@link BannedError} when `identity` is banned from `repo` (advisory: a failed read passes).
 * The bans are read fresh, not from the page's two-minute read: a tab must not post for minutes
 * after a ban, or be refused for minutes after a lift. This is the one extra read, made only
 * when something is about to be signed, never on a page load.
 */
export async function refuseIfBanned(sdk: EvoSDK, repo: RepoRef, network: Network, identity: string): Promise<void> {
  invalidateBans(repo)
  const ban = (await readStandingBans(sdk, repo, network)).get(identity)
  if (ban !== undefined) throw new BannedError(ban)
}

/** Ban `identity` from `repo` (maintainers only at consensus), with a reason code (null: none). */
export async function banIdentity(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, identity: string, reason: number | null, intent?: string): Promise<WriteResult> {
  try {
    return await createDocumentIdempotent(sdk, auth, {
      contractId: repo.forge.collab,
      documentType: DOC_BAN,
      data: {
        repoId: decodeIdentifier(repo.repoId),
        identityId: decodeIdentifier(identity),
        ...(reason !== null && reason !== 0 ? { reason } : {}),
      },
      ...(intent !== undefined ? { intent } : {}),
    })
  } finally {
    invalidateBans(repo)
  }
}

/** Lift the signer's ban `banId` (only its writer can delete it). */
export async function liftBan(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, banId: string): Promise<void> {
  try {
    await deleteDocumentIdempotent(sdk, auth, { contractId: repo.forge.collab, documentType: DOC_BAN, documentId: banId })
  } finally {
    invalidateBans(repo)
  }
}

/** Forget every ban read (tests). */
export function resetBans(): void {
  cache.clear()
}
