'use client'

/**
 * Star button — toggles the viewer's registry `star` on a repo listing (a paid document write,
 * or a delete that refunds it). The starred/unstarred state is read from the viewer's own star
 * documents before the button offers an action, and a failed read or write is shown rather
 * than swallowed.
 */

import { Star } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useUiStore } from '@/hooks/use-ui-store'
import { useSdk } from '@/hooks/use-sdk'
import { useRegistryToggle } from '@/hooks/use-registry-toggle'
import { Button } from '@/components/ui/button'
import { hasStarred, starRepo, unstarRepo } from '@/lib/repo'

export function StarButton({
  listingId,
  count,
}: {
  listingId: string | null
  /** The public star count; `null` when it could not be read. */
  count: number | null
}): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const openLogin = useUiStore((s) => s.openLogin)

  const star = useRegistryToggle({
    enabled: ready && sdk !== null && identity !== null && listingId !== null,
    key: `${network}:${identity ?? ''}:${listingId ?? ''}`,
    read: () => hasStarred(sdk!, network, identity!, listingId!),
    add: async () => (await starRepo(sdk!, signer!, listingId!)).confirmed,
    remove: async () => (await unstarRepo(sdk!, signer!, listingId!)).deleted,
  })

  const onClick = (): void => {
    if (!identity || !signer) {
      openLogin()
      return
    }
    void star.toggle()
  }

  const signedIn = identity !== null && signer !== null
  const starred = star.on === true
  // Signed in but the current state is not known yet (or could not be read): no action to offer.
  const unknown = signedIn && listingId !== null && star.on === null

  return (
    <span className="inline-flex items-center gap-2">
      {star.error ? (
        <span role="alert" className="max-w-[16rem] truncate text-[12px] text-danger" title={star.error}>
          {star.error}
        </span>
      ) : null}
      <Button
        variant={starred ? 'subtle' : 'outline'}
        size="sm"
        onClick={onClick}
        loading={star.busy || (unknown && star.error === null)}
        disabled={!listingId || (unknown && star.error !== null)}
        title={listingId ? undefined : 'This repo has no registry listing, so it cannot be starred.'}
      >
        <Star className={starred ? 'h-3.5 w-3.5 fill-forge-500 text-forge-500' : 'h-3.5 w-3.5'} aria-hidden />
        {starred ? 'Starred' : 'Star'}
        <span className="ml-1 rounded bg-anvil-100 px-1 font-mono text-[11px] text-anvil-500 dark:bg-anvil-800 dark:text-anvil-400">
          {count === null ? '–' : Math.max(0, count + star.delta)}
        </span>
      </Button>
    </span>
  )
}
