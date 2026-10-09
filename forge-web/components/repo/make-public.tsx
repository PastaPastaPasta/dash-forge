'use client'

/**
 * "Make public" for an author's own members-only post (DESIGN §4.6, §10): the button, the
 * confirmation's words, and the quote check over the text being published (§12 item 15), which
 * warns when the post quotes someone else's members-only words this tab has opened.
 */

import { useCallback } from 'react'
import { Globe } from 'lucide-react'

import { quotedMembersPost, type MembersPostKind } from '@/lib/repo/members-texts'
import { useSdk } from '@/hooks/use-sdk'
import { warningName } from '@/components/repo/audience'

/** The "Make public" action beside an author's own members-only post. */
export function MakePublicButton({ onClick, disabled, title }: { onClick: () => void; disabled?: boolean; title?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 text-[12px] text-anvil-500 hover:text-forge-700 disabled:opacity-50 dark:text-anvil-400 dark:hover:text-forge-400 coarse:min-h-11 coarse:px-1"
      data-testid="make-public"
    >
      <Globe className="h-3 w-3" aria-hidden /> Make public
    </button>
  )
}

/** What the confirmation says about one post: the §10 words, and what else to know. */
export interface MakePublicWords {
  readonly title: string
  readonly description: string
  readonly label: string
}

/**
 * The confirmation for making one's own `kind` post public (DESIGN §10). `quoted`: the quote
 * check's finding, from {@link useQuotedMembersPost}. `losesFile`: an inline comment, whose file
 * name can't be made public on this network.
 */
export function makePublicWords(kind: MembersPostKind, quoted: string | null, losesFile = false): MakePublicWords {
  const description =
    kind === 'review'
      ? "It's added as a public comment on your review. This can't be undone."
      : "Everyone will be able to read it as you save it now. Earlier versions stay members-only. This can't be undone."
  const parts = [description]
  if (losesFile) parts.push("Its file name can't be made public, so the comment will show without it.")
  if (quoted !== null) parts.push(quoted)
  return {
    title: kind === 'review' ? "Make your review's text public?" : `Make your ${kind} public?`,
    description: parts.join(' '),
    label: quoted === null ? 'Make public' : 'Make public anyway',
  }
}

/**
 * The quote check of the make-public dialog (DESIGN §4.6, §12 item 15): the warning for `text`,
 * which `author` is making public as a `kind`, when it quotes someone else's members-only post
 * this tab has opened in repo `repoId` ("Your comment quotes @bob's members-only comment.
 * Everyone will be able to read the quoted text."), or null.
 */
export function useQuotedMembersPost(repoId: string): (text: string, author: string, kind: MembersPostKind) => string | null {
  const { network } = useSdk()
  return useCallback(
    (text, author, kind) => {
      const hit = quotedMembersPost(repoId, text, author)
      if (hit === null) return null
      const yours = kind === 'review' ? "Your review's text" : `Your ${kind}`
      return `${yours} quotes @${warningName(network, hit.author)}'s members-only ${hit.kind}. Everyone will be able to read the quoted text.`
    },
    [repoId, network],
  )
}
