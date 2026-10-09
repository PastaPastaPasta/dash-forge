'use client'

/**
 * Copy a short URL (`ux-dx-spec.md` §5.2): the app copies short links everywhere, with the owner
 * written by DPNS name once read, as the address bar shows it (no extra request: the repo header
 * has read it). The name is read for the identity the owner names, whether the route wrote the
 * owner as its id, its name or its label in any case.
 *
 * With a gateway (`lib/gateway.ts`) it copies the share link with a preview card instead
 * ({@link cardRepoUrl}, #454) for a public repo: the same short URL under the gateway's `/og`,
 * which unfurls in Slack, Discord and forums and opens this page. A private repo's link stays the
 * plain one (its card would be generic, and its path is nothing to send a third party).
 */

import { Check, Link2 } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { useOwnerDpnsName } from '@/hooks/use-dpns-name'
import { GATEWAY } from '@/lib/gateway'
import { cardRepoUrl, shortRepoUrl, type ShortTarget } from '@/lib/short-url'
import { cn } from '@/lib/utils'

export function CopyLinkButton({
  repo,
  target,
  visibility,
  className,
}: {
  repo: { readonly owner: string; readonly name: string; readonly repoId?: string }
  target?: ShortTarget
  /** The repo's visibility: only a public repo's link is a gateway share link. */
  visibility: 'public' | 'private'
  className?: string
}): JSX.Element {
  const ownerName = useOwnerDpnsName(repo.owner)
  const gateway = visibility === 'public' ? GATEWAY : null
  const card = gateway !== null ? cardRepoUrl(gateway.url, repo, target, ownerName) : null
  const href = card ?? shortRepoUrl(repo, target, ownerName)
  const [copied, copy] = useCopy(href)
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-link"
      data-href={href}
      title={card !== null && gateway !== null ? `Copies a link that shows a preview card when shared (via ${gateway.label}) and opens this page` : undefined}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border coarse:h-11 coarse:px-3 border-anvil-300 px-2 text-[12px] text-anvil-700 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800',
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}
