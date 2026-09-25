/**
 * The one honest line a forge-v2 repo's write controls carry while the web app only writes to
 * v1 repos: what the button would do exists, and where to do it today.
 */

import { Info } from 'lucide-react'

export function V2WritesNote(): JSX.Element {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[12px] text-anvil-500 dark:text-anvil-400">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        This is a forge-v2 repo. Writing to it from the browser is not available yet; use{' '}
        <span className="font-mono">dg</span> for now.
      </span>
    </p>
  )
}
