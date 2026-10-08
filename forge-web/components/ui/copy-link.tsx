'use client'

/**
 * Copy a short URL (`ux-dx-spec.md` §5.2): the app copies short links everywhere, with the owner
 * written by DPNS name once read, as the address bar shows it (no extra request: the repo header
 * has read it). The name is read for the identity the owner names, whether the route wrote the
 * owner as its id, its name or its label in any case.
 */

import { Check, Link2 } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { useOwnerDpnsName } from '@/hooks/use-dpns-name'
import { shortRepoUrl, type ShortTarget } from '@/lib/short-url'
import { cn } from '@/lib/utils'

export function CopyLinkButton({
  repo,
  target,
  className,
}: {
  repo: { readonly owner: string; readonly name: string; readonly repoId?: string }
  target?: ShortTarget
  className?: string
}): JSX.Element {
  const href = shortRepoUrl(repo, target, useOwnerDpnsName(repo.owner))
  const [copied, copy] = useCopy(href)
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-link"
      data-href={href}
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
