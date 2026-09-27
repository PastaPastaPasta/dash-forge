'use client'

/**
 * "Dash Forge was updated in another tab — reload": this tab let go of the browser's storage so
 * the newer tab could upgrade it (`lib/idb.ts`), and its own reads and writes of that storage
 * now wait for a reload.
 */

import { RefreshCw } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { onStorageSuperseded, storageSuperseded } from '@/lib/idb'

export function StorageUpdated(): JSX.Element | null {
  const superseded = useSyncExternalStore(onStorageSuperseded, storageSuperseded, () => false)
  if (!superseded) return null
  return (
    <div
      role="alert"
      data-testid="storage-updated"
      className="fixed inset-x-0 top-0 z-[70] flex flex-wrap items-center justify-center gap-3 border-b border-caution/40 bg-caution/10 px-4 py-2 text-dense text-anvil-800 backdrop-blur dark:text-anvil-100"
    >
      <span>Dash Forge was updated in another tab. Reload this tab to keep signing in and writing.</span>
      <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload
      </Button>
    </div>
  )
}
