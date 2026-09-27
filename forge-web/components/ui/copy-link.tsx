'use client'

/** Copy a short URL (`ux-dx-spec.md` §5.2): the app copies short links everywhere. */

import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { shortRepoUrl, type ShortTarget } from '@/lib/short-url'
import { cn } from '@/lib/utils'

export function CopyLinkButton({
  repo,
  target,
  className,
}: {
  repo: { readonly owner: string; readonly name: string }
  target?: ShortTarget
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shortRepoUrl(repo, target))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* insecure context: nothing to copy to */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      data-testid="copy-link"
      data-href={shortRepoUrl(repo, target)}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border border-anvil-300 px-2 text-[12px] text-anvil-700 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800',
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-verify-700 dark:text-verify-400" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}
