/**
 * The commits a PR adds (review-parity P2, R5 "applied in", R14 "pushed n commits"): every
 * commit reachable from the head and not from the base it is compared with
 * (`git log base..head`), newest first, and the suggestions they applied (`Forge-Suggestion:`
 * trailers, review-parity §4.5). Parity: `dg pr commits` and `dg pr suggestion apply`'s
 * `applied_ids`.
 */

import { newCommits, WalkLimitError, WALK_COMMIT_CAP } from '../merge/objects'
import { parseCommit, type CommitObject } from './git-objects'
import { commitSubject, type ObjectReader } from './tree-nav'

/** Commits the list shows before "and n more" (the spec's cap). */
export const PR_COMMITS_CAP = 250

export interface PrCommit {
  readonly oid: string
  readonly subject: string
  readonly commit: CommitObject
}

export interface PrCommits {
  /** Newest first (by committer time), at most {@link PR_COMMITS_CAP}. */
  readonly commits: readonly PrCommit[]
  /**
   * How many the PR adds, or null when the walk stopped at its limit before counting them all
   * (then more than {@link WALK_COMMIT_CAP}: the count is unknown, never the few listed).
   */
  readonly total: number | null
  /** Not every commit is listed: past {@link PR_COMMITS_CAP}, or the walk hit its limit. */
  readonly truncated: boolean
}

/**
 * The commits reachable from `headOid` and from none of `have` (`git log ^have… head`): the base
 * branch's tip and the merge base, so a base merged into the PR branch is not listed. An empty
 * `have` lists the head's whole history.
 */
export async function prCommits(reader: ObjectReader, have: readonly string[], headOid: string, walkCap = WALK_COMMIT_CAP): Promise<PrCommits> {
  let oids: string[]
  let walkStopped = false
  // A "have" commit this reader cannot read (a base tip only the base repo holds, not loaded) is
  // left out rather than failing the whole list.
  const readable = (
    await Promise.all(
      [...new Set(have.filter((h) => h !== ''))].map(async (h) => {
        try {
          await reader.readObject(h)
          return h
        } catch {
          return null
        }
      }),
    )
  ).filter((h): h is string => h !== null)
  try {
    oids = await newCommits(reader, headOid, readable, walkCap)
  } catch (e) {
    if (!(e instanceof WalkLimitError)) throw e
    oids = [headOid]
    walkStopped = true
  }
  const shown = oids.slice(0, PR_COMMITS_CAP)
  const commits = await Promise.all(
    shown.map(async (oid) => {
      const commit = parseCommit((await reader.readObject(oid)).bytes)
      return { oid, subject: commitSubject(commit.message), commit }
    }),
  )
  return { commits, total: walkStopped ? null : oids.length, truncated: walkStopped || oids.length > PR_COMMITS_CAP }
}

/**
 * What the commit walk stops at, from the comparison: the base branch's tip and the merge base.
 * When the comparison fell back (no merge base: it compared with the head's first parent) or the PR is merged (the tip now contains the head), only the base
 * the diff was made against: walking from the tip would run to the history cap.
 */
export function prHaveSet(c: { readonly baseTipOid: string; readonly comparedBaseOid: string; readonly fellBack: boolean; readonly merged: boolean }): string[] {
  const out = c.fellBack || c.merged ? [c.comparedBaseOid] : [c.baseTipOid, c.comparedBaseOid]
  return [...new Set(out.filter((o) => o !== ''))]
}

/** The trailer naming an applied suggestion's comment. */
export const SUGGESTION_TRAILER = 'Forge-Suggestion'

/**
 * The comment ids `Forge-Suggestion:` trailers name, mapped to the commit that applied them
 * (the oldest one, when several did). Parity: `dg`'s `branch::applied_ids`.
 */
export function appliedSuggestions(commits: readonly PrCommit[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of [...commits].reverse()) {
    for (const line of c.commit.message.split('\n')) {
      const t = line.trim()
      if (!t.startsWith(`${SUGGESTION_TRAILER}:`)) continue
      const id = t.slice(SUGGESTION_TRAILER.length + 1).trim()
      if (id !== '' && !out.has(id)) out.set(id, c.oid)
    }
  }
  return out
}
