'use client'

/** The Code / Blame / History links beside a file's or directory's breadcrumb (GitHub's file header). */

import Link from 'next/link'
import { FileText, History, ListTree, type LucideIcon } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'

const LINK =
  'inline-flex h-7 items-center gap-1 rounded-md border border-anvil-300 px-2 text-[12px] text-anvil-700 hover:bg-anvil-100 coarse:h-11 coarse:px-3 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800'

type View = 'code' | 'blame' | 'history'

const VIEWS: Readonly<Record<View, { readonly route: string; readonly label: string; readonly icon: LucideIcon }>> = {
  code: { route: '/repo/blob', label: 'Code', icon: FileText },
  blame: { route: '/repo/blame', label: 'Blame', icon: ListTree },
  history: { route: '/repo/commits', label: 'History', icon: History },
}

/** `show`: the views to link to, in order (the page's own is left out). */
export function PathActions({ addr, path, refParam, show }: { addr: RepoAddress; path: string; refParam: string; show: readonly View[] }): JSX.Element {
  const extra: Record<string, string> = { path, ...(refParam ? { ref: refParam } : {}) }
  return (
    <div className="ml-auto flex gap-2">
      {show.map((view) => {
        const { route, label, icon: Icon } = VIEWS[view]
        return (
          <Link key={view} href={repoHref(route, addr, extra)} className={LINK} data-testid={`${view}-link`}>
            <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
          </Link>
        )
      })}
    </div>
  )
}
