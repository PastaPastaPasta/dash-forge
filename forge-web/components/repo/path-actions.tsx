'use client'

/** The Code / Blame / History links beside a file's or directory's breadcrumb (GitHub's file header). */

import Link from 'next/link'
import { FileText, History, ListTree } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const LINK =
  'inline-flex h-7 items-center gap-1 rounded-md border border-anvil-300 px-2 text-[12px] text-anvil-700 hover:bg-anvil-100 coarse:h-11 coarse:px-3 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800'

/** `show`: the views to link to (the page's own is left out). */
export function PathActions({
  addr,
  path,
  refParam,
  show,
}: {
  addr: RepoAddress
  path: string
  refParam: string
  show: readonly ('code' | 'blame' | 'history')[]
}): JSX.Element {
  const extra: Record<string, string> = { path, ...(refParam ? { ref: refParam } : {}) }
  return (
    <div className="ml-auto flex gap-2">
      {show.includes('code') ? (
        <Link href={repoHref('/repo/blob', addr, extra)} className={LINK} data-testid="code-link">
          <FileText className="h-3.5 w-3.5" aria-hidden /> Code
        </Link>
      ) : null}
      {show.includes('blame') ? (
        <Link href={repoHref('/repo/blame', addr, extra)} className={LINK} data-testid="blame-link">
          <ListTree className="h-3.5 w-3.5" aria-hidden /> Blame
        </Link>
      ) : null}
      {show.includes('history') ? (
        <Link href={repoHref('/repo/commits', addr, extra)} className={LINK} data-testid="history-link">
          <History className="h-3.5 w-3.5" aria-hidden /> History
        </Link>
      ) : null}
    </div>
  )
}
