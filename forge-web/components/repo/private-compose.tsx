'use client'

/**
 * Whether this browser can write sealed content (an issue, comment, PR or review) to a private
 * repo, and what to say when it cannot (`docs/security/private-repos.md` §5.3, §9): only a
 * member holding the current key, while the epoch is writable (not burned, no non-member
 * holding it). The seal itself happens in `lib/repo/private-writes.ts` on every write.
 */

import type { RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { SEALED_FIELDS_OF, SEALED_TEXT_LIMIT, sealedTextUse, writeBlockReason, type SealedKind } from '@/lib/repo/private-writes'
import { previewCreate, previewCredits, type CostPreview } from '@/lib/sdk'
import { estimateBytesCredits } from '@/lib/sdk/cost'

/** For a public repo: always null. For a private one: null when sealed writes can go ahead, else why not. */
export function privateComposeBlock(home: RepoHome): string | null {
  return privateWriteBlock(home.repo, home.private)
}

/** {@link privateComposeBlock} from a repo and its private access (components without a home). */
export function privateWriteBlock(repo: RepoRef, access: RepoHome['private']): string | null {
  if (repo.visibility !== 'private') return null
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
 * What a new document costs: on a private repo its text is stored sealed (`enc`: the text, 3
 * bytes of framing per field, and a 29-byte frame), priced as such; public ones as they are.
 */
export function composeCost(repo: RepoRef, kind: SealedKind, data: Readonly<Record<string, unknown>>): CostPreview {
  if (repo.visibility !== 'private') return previewCreate(kind, data)
  const { used, fields } = sealedTextUse(kind, data)
  const sealed = new Set<string>(SEALED_FIELDS_OF[kind])
  const bind = Object.fromEntries(Object.entries(data).filter(([k]) => !sealed.has(k)))
  return previewCredits(estimateBytesCredits(kind, used + 3 * fields + 29, bind))
}

/**
 * The composer line §4.3 asks for on a private repo: the combined size limit of the sealed text,
 * and how much of it is used. Null on a public repo.
 */
export function SealedLimit({ repo, kind, text }: { repo: RepoRef; kind: SealedKind; text: string }): JSX.Element | null {
  if (repo.visibility !== 'private') return null
  const used = new TextEncoder().encode(text).length
  const limit = SEALED_TEXT_LIMIT[kind]
  return (
    <p className={`mt-1 text-[11px] ${used > limit ? 'text-danger-700 dark:text-danger-400' : 'text-anvil-500 dark:text-anvil-400'}`} data-testid="sealed-limit">
      {kind === 'patch' ? 'Title, text and branch names' : kind === 'issue' ? 'Title and text' : kind === 'comment' ? 'Text and file path' : 'Text'} {used} / {limit} bytes
      (encrypted to this repo&apos;s members).
    </p>
  )
}
