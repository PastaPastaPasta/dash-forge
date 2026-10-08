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
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { queryAllDocuments } from '../sdk'
import { DOC, str, type RepoRef } from './contract'
import { onRepoInvalidated } from './issues'
import { repoHasMembersKey } from './members-writes'
import { docAudience } from './private-content'
import { repoSource } from './source'

/** Threads one read covers (an `in` clause holds at most this many values). */
const IN_MAX = 100
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
  )
  const sealed = new Map<string, number>()
  for (const d of docs) {
    if (docAudience(d) !== 'members') continue
    const target = str(d, 'targetId')
    sealed.set(target, (sealed.get(target) ?? 0) + 1)
  }
  for (const id of unread) {
    const n = sealed.get(id) ?? 0
    if (known.size >= MAX_REMEMBERED) known.delete(known.keys().next().value as string)
    known.set(keyOf(repo, id, wanted.get(id)!), n)
    if (n > 0) out.set(id, n)
  }
  return out
}
