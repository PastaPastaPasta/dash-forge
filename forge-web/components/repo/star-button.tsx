'use client'

/** Star button — toggles a registry `star` for a repo listing (idempotent write, free). */

import { useState } from 'react'
import { Star } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useSdk } from '@/hooks/use-sdk'
import { Button } from '@/components/ui/button'
import { starRepo, unstarRepo } from '@/lib/repo'

export function StarButton({
  listingId,
  count,
}: {
  listingId: string | null
  count: number
}): JSX.Element {
  const { sdk } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)
  const [starred, setStarred] = useState(false)
  const [busy, setBusy] = useState(false)
  const [delta, setDelta] = useState(0)

  const toggle = async (): Promise<void> => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    if (!listingId || !sdk) return
    setBusy(true)
    try {
      if (starred) {
        await unstarRepo(sdk, signer, listingId)
        setStarred(false)
        setDelta((d) => d - 1)
      } else {
        await starRepo(sdk, signer, listingId)
        setStarred(true)
        setDelta((d) => d + 1)
      }
    } catch {
      // Surface nothing loud here — the count simply doesn't move on failure.
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant={starred ? 'subtle' : 'outline'} size="sm" onClick={toggle} loading={busy} disabled={!listingId}>
      <Star className={starred ? 'h-3.5 w-3.5 fill-forge-500 text-forge-500' : 'h-3.5 w-3.5'} aria-hidden />
      {starred ? 'Starred' : 'Star'}
      <span className="ml-1 rounded bg-anvil-100 px-1 font-mono text-[11px] text-anvil-500 dark:bg-anvil-800 dark:text-anvil-400">
        {Math.max(0, count + delta)}
      </span>
    </Button>
  )
}
