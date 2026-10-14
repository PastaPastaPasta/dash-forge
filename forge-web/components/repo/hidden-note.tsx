'use client'

import { useAuth } from '@/contexts/auth-context'
import type { RepoHome } from '@/lib/view'
import { plural } from '@/lib/view/format'
import { HIDDEN_REASON_TEXT, totalHidden, type HiddenCounts, type HiddenReason } from '@/lib/repo/private-content'
import { isMaintainer } from '@/lib/repo/private-session'
import type { EventValueCounts } from '@/lib/view/issues-view'
import type { MembersAccess } from '@/lib/view/repo-view'
import { MembersLockedLine, summarizesMembersOnly } from '@/components/repo/audience'

/**
 * A private repo's event values (labels, assignees, milestones) that could not be shown, or
 * that an older client wrote unencrypted (`private-repos.md` §8.1): every reader sees it, since
 * the missing or exposed values are on the page they are reading.
 *
 * A public repo's members-only ones, to a member whose tab can't read them yet (`lane`): the
 * unlock, or how to set up their key. A thread made public by a maintainer's bundle reads
 * public, but its events stay members-only (the bundle opens posts only; forge-core
 * `Collab::readable_events_of` reads them with the members key alone), so after a reload this is
 * the page's only way to them, and to the publication date.
 */
export function EventValuesNote({ counts, lane }: { counts: EventValueCounts; lane?: MembersAccess | undefined }): JSX.Element | null {
  const changes = `${plural(counts.hidden, 'label, assignee or milestone change')} ${counts.hidden === 1 ? 'is' : 'are'}`
  // (only a public repo has `lane`, and a public repo reports no plaintext values)
  if (counts.hidden > 0 && summarizesMembersOnly(lane)) {
    return (
      <div className="mt-2">
        <MembersLockedLine what={`${changes} members-only`} lane={lane} testId="event-values-locked" />
      </div>
    )
  }
  const parts: string[] = []
  if (counts.hidden > 0) parts.push(`${changes} not readable with your keys`)
  if (counts.plaintext > 0) parts.push(`${counts.plaintext} ${counts.plaintext === 1 ? 'was' : 'were'} written by an older client and ${counts.plaintext === 1 ? 'is' : 'are'} not encrypted`)
  if (parts.length === 0) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="event-values-note">
      {parts.join('; ')}.
    </p>
  )
}

/**
 * The line a list or thread shows when it skipped documents (`forge-v2.md` §5). Never silent: a
 * list that quietly shrinks looks like an empty repo.
 *
 * A private repo: only its maintainers see the count, split by why each document is hidden
 * (`ux-dx-spec.md` §9, `private-repos.md` §8.1), with the note that anyone can post into the
 * namespace.
 *
 * A public repo (DESIGN §4.1, §10): encrypted items nobody proved a member wrote are "private
 * messages from people outside this repo" (a member's members-only ones show as placeholders
 * instead, `shown` of them); anything else skipped is not readable in this repo.
 */
export function HiddenNote({
  hidden,
  what,
  many,
  home,
  by,
  shown = 0,
}: {
  hidden: number
  /** What was skipped, one of them ("issue"); `many`: its plural when not just an "s" more. */
  what: string
  many?: string
  home?: RepoHome
  by?: HiddenCounts
  /** How many of the hidden ones the page shows as members-only placeholders. */
  shown?: number
}): JSX.Element | null {
  const { identity } = useAuth()
  if (home?.repo.visibility === 'private') {
    const session = home.private?.access === 'member' ? home.private.session : null
    const maintainer = session !== null && isMaintainer(session, identity)
    if (!maintainer || by === undefined || totalHidden(by) === 0) return null
    const parts = (Object.keys(HIDDEN_REASON_TEXT) as HiddenReason[])
      .filter((r) => by[r] > 0)
      .map((r) => `${by[r]} ${HIDDEN_REASON_TEXT[r]}`)
    return (
      <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="private-hidden">
        {plural(totalHidden(by), 'item')} ignored ({parts.join(', ')}). Only items encrypted with this repo&apos;s key are shown.
      </p>
    )
  }
  const encrypted = by === undefined ? 0 : Math.max(0, by.membersOnly + by.letter + by.unknownVersion + by.notABot + by.wrongKey + by.late + by.lateEdit - shown)
  const other = by === undefined ? Math.max(0, hidden - shown) : by.notEncrypted
  if (encrypted <= 0 && other <= 0) return null
  return (
    <div className="mt-2 space-y-0.5 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="hidden-note">
      {encrypted > 0 ? (
        <p>
          {plural(encrypted, 'private message')} from people outside this repo {encrypted === 1 ? "isn't" : "aren't"} shown.
        </p>
      ) : null}
      {other > 0 ? (
        <p>
          {plural(other, what, many)} {other === 1 ? "isn't" : "aren't"} shown: not readable in this repo.
        </p>
      ) : null}
    </div>
  )
}
