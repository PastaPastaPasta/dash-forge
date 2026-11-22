import { Pin } from 'lucide-react'

import { cn } from '@/lib/utils'

/** The Pinned mark on a pinned issue: its page's rail and the pinned cards over the list. */
export function PinnedBadge({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border border-forge-600/40 bg-forge-600/10 px-1.5 py-px text-[11px] font-medium text-forge-800 dark:border-forge-400/40 dark:bg-forge-400/10 dark:text-forge-300', className)}
      data-testid="pinned-badge"
    >
      <Pin className="h-3 w-3" aria-hidden /> Pinned
    </span>
  )
}
