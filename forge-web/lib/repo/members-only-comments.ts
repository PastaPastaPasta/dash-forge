/**
 * How many of each listed thread's comments are members-only, for the labelled count on an issue
 * or PR row: "3 comments (2 members-only)" (DESIGN §4.1 "Client rules", §10).
 *
 * A row's comment count is a proved count of the `comment` documents of the thread, and it
 * includes the members-only ones, because their existence is public. No index separates them
 * (the contract has none on `enc` or `asMember`), so the share is read from the comments
 * themselves, and only for a public repo that has members-only content turned on: every other
 * repo's list costs nothing more than before. The answer is the same for every reader (it counts
 * sealed documents, it opens none), and it is remembered for the count it was read at, so a
 * thread that gained a comment is read again and the rest are not.
 *
 * What counts is what the thread page shows as a members-only placeholder (DESIGN D14): a
 * well-formed sealed comment that carries `asMember`. Sealed text without it is hidden and
 * counted there as "from people outside this repo", and a specific-people letter is not
 * members-only, so neither is in the label.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryAllDocuments } from '../sdk'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { onRepoInvalidated } from './issues'
import { repoHasMembersKey } from './members-writes'
import { defaultGate, placeholderShown } from './private-content'
import { repoSource } from './source'

/** Threads one read covers (an `in` clause holds at most this many values). */
const IN_MAX = 100
/** Pages of comments (100 each) one read goes through; threads the read did not reach have no label. */
const MAX_PAGES = 3
/** Counts remembered across pages; the oldest go first. */
const MAX_REMEMBERED = 2000

/** What is known per `repoId:targetId:comments`: the members-only share at that count. */
const known = new Map<string, number>()
onRepoInvalidated((repo) => {
  for (const k of known.keys()) if (k.startsWith(`${repo.repoId}:`)) known.delete(k)
})

const keyOf = (repo: Pick<RepoRef, 'repoId'>, id: string, comments: number): string => `${repo.repoId}:${id}:${comments}`

/** A thread to count: its id and the proved number of comments it has. */
export interface CommentedThread {
  readonly id: string
  readonly comments: number | null
}

/**
 * The members-only comments of each of `threads` that has any, by thread id. Threads without
 * comments are never read, and none are for a repo without members-only content. A read that
 * fails answers nothing (the rows keep their plain count); more threads than one read covers
 * are left out.
 */
export async function membersOnlyCommentCounts(sdk: EvoSDK, repo: RepoRef, threads: readonly CommentedThread[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  // A private repo's comments are all for its members: nothing to label.
  if (repo.visibility === 'private') return out
  const wanted = new Map(threads.filter((t) => t.id !== '' && (t.comments ?? 0) > 0).map((t) => [t.id, t.comments as number]))
  if (wanted.size === 0 || !(await repoHasMembersKey(sdk, repo))) return out
  const unread: string[] = []
  for (const [id, comments] of wanted) {
    const hit = known.get(keyOf(repo, id, comments))
    if (hit === undefined) unread.push(id)
    else if (hit > 0) out.set(id, hit)
  }
  if (unread.length === 0 || unread.length > IN_MAX) return out
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.comment, { where: [['targetId', 'in', [...unread].sort()]], orderBy: [['targetId', 'asc']] }),
    { maxPages: MAX_PAGES },
  )
  // Per thread: the comments read, and how many of them are members-only.
  const read = new Map<string, { all: number; sealed: number }>()
  const gate = defaultGate(repo)
  for (const d of docs) {
    const target = asIdentifierString(d['targetId'])
    const t = read.get(target) ?? { all: 0, sealed: 0 }
    t.all += 1
    const admitted = await gate.admit('comment', d)
    if (!admitted.ok && admitted.placeholder !== undefined && admitted.placeholder.audience === 'members' && placeholderShown(admitted.placeholder)) t.sealed += 1
    read.set(target, t)
  }
  for (const id of unread) {
    const t = read.get(id)
    const comments = wanted.get(id)!
    // Only a thread read to the count its row proves is answered: a node behind, or a read cut at
    // its page limit, leaves the row with its plain count, and the next load reads it again.
    if (t === undefined || t.all !== comments) continue
    if (known.size >= MAX_REMEMBERED) known.delete(known.keys().next().value as string)
    known.set(keyOf(repo, id, comments), t.sealed)
    if (t.sealed > 0) out.set(id, t.sealed)
  }
  return out
}
