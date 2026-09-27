'use client'

import { useAuth } from '@/contexts/auth-context'
import type { RepoHome } from '@/lib/view'
import { HIDDEN_REASON_TEXT, totalHidden, type HiddenCounts, type HiddenReason } from '@/lib/repo/private-content'

/**
 * The line a list shows when it skipped documents: not well-formed for the repo (plaintext in
 * a private repo, ciphertext in a public one) or a stranger's ciphertext in a private repo
 * (`forge-v2.md` §5). Never silent — a list that quietly shrinks looks like an empty repo.
 *
 * A private repo: only its maintainers see the count, split by why each document is hidden
 * (`ux-dx-spec.md` §9, `private-repos.md` §8.1), with the note that anyone can post into the
 * namespace.
 */
export function HiddenNote({
  hidden,
  what,
  home,
  by,
}: {
  hidden: number
  what: string
  home?: RepoHome
  by?: HiddenCounts
}): JSX.Element | null {
  const { identity } = useAuth()
  if (home?.repo.visibility === 'private') {
    const session = home.private?.access === 'member' ? home.private.session : null
    const maintainer = session?.members.some((m) => m.identity === identity && m.role === 'maintainer') ?? false
    if (!maintainer || by === undefined || totalHidden(by) === 0) return null
    const parts = (Object.keys(HIDDEN_REASON_TEXT) as HiddenReason[])
      .filter((r) => by[r] > 0)
      .map((r) => `${by[r]} ${HIDDEN_REASON_TEXT[r]}`)
    return (
      <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="private-hidden">
        {totalHidden(by)} documents ignored ({parts.join(', ')}). Anyone can post into a repo&apos;s namespace; only documents
        that decrypt with this repo&apos;s key are shown.
      </p>
    )
  }
  if (hidden <= 0) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">
      {hidden} newer {what}
      {hidden === 1 ? ' was' : ' were'} hidden: not readable in this repo (malformed, or encrypted
      by someone who is not a member).
    </p>
  )
}
