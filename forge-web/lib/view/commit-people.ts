/**
 * Who made a commit, for its page's byline (L-26): the author, the committer when that is someone
 * else or another time, and the co-authors its `Co-authored-by:` trailers name (GitHub's
 * convention: trailers in the message's last paragraph, `Name <email>`).
 */

import type { CommitObject, GitIdent } from './git-objects'

export interface Person {
  readonly name: string
  readonly email: string
}

export interface CommitPeople {
  readonly author: GitIdent
  /** The committer, when not the author at the author's time (a rebase, a cherry-pick, a merge by someone else). */
  readonly committer: GitIdent | null
  /** Whether the committer is the author (only the time differs). */
  readonly committerIsAuthor: boolean
  /** Co-authors other than the author, in trailer order, each once. */
  readonly coAuthors: readonly Person[]
}

const CO_AUTHOR = /^co-authored-by:\s*(.*?)\s*<([^<>]*)>\s*$/i

/** The `Co-authored-by:` trailers of the message's last paragraph. */
export function coAuthorsOf(message: string): Person[] {
  const paragraphs = message.trim().split(/\n\s*\n/)
  const last = paragraphs.length > 1 ? (paragraphs[paragraphs.length - 1] as string) : ''
  const out: Person[] = []
  for (const line of last.split('\n')) {
    const m = CO_AUTHOR.exec(line.trim())
    if (m !== null) out.push({ name: (m[1] as string) || (m[2] as string), email: m[2] as string })
  }
  return out
}

const samePerson = (a: Person, b: Person): boolean => a.name === b.name && a.email.toLowerCase() === b.email.toLowerCase()

export function commitPeople(commit: CommitObject): CommitPeople {
  const { author, committer } = commit
  const committerIsAuthor = samePerson(author, committer)
  const seen: Person[] = [author]
  const coAuthors = coAuthorsOf(commit.message).filter((p) => {
    if (seen.some((q) => q.email.toLowerCase() === p.email.toLowerCase())) return false
    seen.push(p)
    return true
  })
  return {
    author,
    committer: committerIsAuthor && committer.when === author.when ? null : committer,
    committerIsAuthor,
    coAuthors,
  }
}
