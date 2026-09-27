'use client'

/**
 * Whether this browser can write sealed content (an issue, comment, PR or review) to a private
 * repo, and what to say when it cannot (`docs/security/private-repos.md` §5.3, §9): only a
 * member holding the current key, while the epoch is writable (not burned, no non-member
 * holding it). The seal itself happens in `lib/repo/private-writes.ts` on every write.
 */

import type { RepoHome } from '@/lib/view'
import { SEALED_TEXT_LIMIT, writeBlockReason } from '@/lib/repo/private-writes'

/** For a public repo: always null. For a private one: null when sealed writes can go ahead, else why not. */
export function privateComposeBlock(home: RepoHome): string | null {
  if (home.repo.visibility !== 'private') return null
  const access = home.private
  if (access?.access === 'no-key') return 'Add your encryption key to this browser (Settings → Keys) to write to this private repo.'
  if (access?.access !== 'member') return 'Only members can write to a private repo.'
  return writeBlockReason(access.session.resolution)
}

/** The note shown in place of a composer on a private repo that cannot be written to. */
export function PrivateComposeNote({ reason }: { reason: string }): JSX.Element {
  return (
    <p className="text-dense text-anvil-500 dark:text-anvil-400" data-testid="private-compose-note">
      {reason}
    </p>
  )
}

/**
 * The composer line §4.3 asks for on a private repo: the combined size limit of the sealed text,
 * and how much of it is used. Null on a public repo.
 */
export function SealedLimit({ home, kind, text }: { home: RepoHome; kind: 'issue' | 'patch' | 'comment' | 'review'; text: string }): JSX.Element | null {
  if (home.repo.visibility !== 'private') return null
  const used = new TextEncoder().encode(text).length
  const limit = SEALED_TEXT_LIMIT[kind] as number
  return (
    <p className={`mt-1 text-[11px] ${used > limit ? 'text-danger' : 'text-anvil-500 dark:text-anvil-400'}`} data-testid="sealed-limit">
      {kind === 'issue' || kind === 'patch' ? 'Title and text' : 'Text'} {used} / {limit} bytes (encrypted to this repo&apos;s members).
    </p>
  )
}
