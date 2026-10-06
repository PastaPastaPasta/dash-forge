/**
 * Which identities are bots, by mutual claim (`profile.bot`, UPDATE-1): a bot's profile names its
 * operator and the operator's profile lists the bot ({@link botOperator}). Read for a set of
 * identities at once: one `$ownerId in` query for their profiles (100 at a time), then one for the
 * operators they name that were not in the set. Answers are kept per network and contract for
 * the session; a failed read keeps nothing and badges nobody.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryDocuments } from '../sdk'
import type { TimelineItem } from '../view/issues-view'
import { botOperator, type BotClaim } from '../rules/profile'
import { DOC } from './contract'
import { botClaimOf } from './profile'

/** An `in` query names at most this many values. */
const IN_MAX = 100

/** Each identity's claim (null: no profile or no claim), by `community:id`. */
const claims = new Map<string, BotClaim | null>()

async function readClaims(sdk: EvoSDK, community: string, ids: readonly string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !claims.has(`${community}:${id}`))
  for (let i = 0; i < missing.length; i += IN_MAX) {
    const chunk = missing.slice(i, i + IN_MAX)
    const docs = await queryDocuments(sdk, {
      dataContractId: community,
      documentTypeName: DOC.profile,
      where: [['$ownerId', 'in', chunk]],
      orderBy: [['$ownerId', 'asc']],
      limit: chunk.length,
    })
    const found = new Map(docs.map((d) => [String(d['$ownerId']), botClaimOf(d) ?? null]))
    for (const id of chunk) claims.set(`${community}:${id}`, found.get(id) ?? null)
  }
}

/** Record a claim already read with its profile (a profile page), so it is not read again. */
export function noteBotClaim(community: string, id: string, claim: BotClaim | null): void {
  claims.set(`${community}:${id}`, claim)
}

/** The verified operator of each of `ids` that is a bot (others are absent). */
export async function readBotOperators(sdk: EvoSDK, community: string, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const claimOf = (id: string): BotClaim | null => claims.get(`${community}:${id}`) ?? null
  await readClaims(sdk, community, ids)
  const operators = ids.map((id) => claimOf(id)?.operator).filter((o): o is string => typeof o === 'string' && o !== '')
  if (operators.length > 0) await readClaims(sdk, community, operators)
  const out = new Map<string, string>()
  for (const id of ids) {
    const bot = claimOf(id)
    const op = bot?.operator ? botOperator(id, bot, claimOf(bot.operator)) : null
    if (op !== null) out.set(id, op)
  }
  return out
}

/**
 * Everyone a thread shows: its author, then each comment's and review's author and each state
 * change's and event's actor, once each. What a thread's bot badges are read for, in one go.
 */
export function threadAuthorIds(author: string, timeline: readonly TimelineItem[]): string[] {
  const ids = new Set<string>([author])
  for (const it of timeline) {
    if (it.kind === 'comment') ids.add(it.comment.author)
    else if (it.kind === 'review') {
      ids.add(it.review.reviewer)
      for (const c of it.comments) ids.add(c.author)
    } else if (it.kind === 'transition') ids.add(it.transition.actor)
    else if (it.kind === 'event') ids.add(it.event.actor)
  }
  ids.delete('')
  return [...ids].sort()
}

/** Forget every claim read (tests; a profile edit of one's own). */
export function resetBotClaims(): void {
  claims.clear()
}
