'use client'

import Link from 'next/link'
import { Milestone, Tag } from 'lucide-react'
import { repoHref, type RepoAddress } from '@/hooks/use-query-param'
import { cn } from '@/lib/utils'

/** The Labels | Milestones switch GitHub puts beside the issue search (QW-019). */
export function TriageNav({ addr, current }: { addr: RepoAddress; current?: 'labels' | 'milestones' }): JSX.Element {
  const item = (key: 'labels' | 'milestones', label: string, Icon: typeof Tag): JSX.Element => {
    const on = current === key
    const cls = cn(
      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 whitespace-nowrap coarse:min-h-11',
      on ? 'bg-anvil-100 font-medium text-anvil-900 dark:bg-anvil-800 dark:text-anvil-50' : 'text-anvil-600 hover:text-anvil-900 dark:text-anvil-300 dark:hover:text-anvil-50',
    )
    return (
      <Link href={repoHref(`/repo/${key}`, addr)} className={cls} aria-current={on ? 'page' : undefined} data-testid={`triage-${key}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </Link>
    )
  }
  return (
    <nav aria-label="Labels and milestones" className="flex items-center gap-0.5 rounded-md border border-anvil-200 p-0.5 text-dense dark:border-anvil-800">
      {item('labels', 'Labels', Tag)}
      {item('milestones', 'Milestones', Milestone)}
    </nav>
  )
}
