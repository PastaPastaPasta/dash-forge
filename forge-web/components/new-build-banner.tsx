'use client'

/**
 * "A new version is available" (INC-14, `lib/new-build.ts`): a strip under the header once the
 * site serves a newer build than this tab runs. A tab opened before an emergency fix would
 * otherwise keep running the old code until someone happens to reload. The reload button is the
 * user's: nothing reloads by itself, so an unsent draft is never lost to it.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { siteRoot } from '@/lib/build-check'
import { isImmutableCopy, watchForNewBuild } from '@/lib/new-build'

export function NewBuildBanner(): JSX.Element | null {
  const [newer, setNewer] = useState(false)
  useEffect(() => {
    if (isImmutableCopy(location)) return undefined
    return watchForNewBuild({ root: siteRoot(document, location), onNewer: () => setNewer(true) })
  }, [])
  if (!newer) return null
  return (
    <div role="status" data-testid="new-build-banner" className="border-b border-forge-500/40 bg-forge-500/10">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-dense sm:px-6">
        <p className="min-w-0 flex-1 text-anvil-800 dark:text-anvil-100">
          <span className="font-medium">A new version is available.</span> Reload to use it; this page is running an older build.
        </p>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload
        </Button>
      </div>
    </div>
  )
}
