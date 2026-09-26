'use client'

/**
 * Star button — toggles the viewer's star on a repo: a forge-v2 `star` (indexOnly; unstar is
 * an index-only delete that returns its storage) or a v1 registry `star` on the listing. The
 * starred/unstarred state is read from the viewer's own star before the button offers an
 * action, and a failed read or write is shown rather than swallowed.
 */

import { Star } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useRegistryToggle } from '@/hooks/use-registry-toggle'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { hasStarred, hasStarredV2, starRepo, starRepoV2, unstarRepo, unstarRepoV2, type RepoRef } from '@/lib/repo'
import { previewCreate } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

export function StarButton({
  repo,
  listingId,
  count,
}: {
  repo: RepoRef
  /** v1: the registry listing (null = no listing, cannot be starred). */
  listingId: string | null
  /** The public star count; `null` when it could not be read. */
  count: number | null
}): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const v2 = repo.kind === 'v2' ? repo : null
  const target = v2?.repoId ?? listingId

  const star = useRegistryToggle({
    enabled: ready && sdk !== null && identity !== null && target !== null,
    key: `${network}:${identity ?? ''}:${target ?? ''}`,
    read: () => (v2 ? hasStarredV2(sdk!, v2, identity!) : hasStarred(sdk!, network, identity!, listingId!)),
    add: async () => (v2 ? await starRepoV2(sdk!, signer!, v2) : await starRepo(sdk!, signer!, listingId!)).confirmed,
    remove: async () => (v2 ? await unstarRepoV2(sdk!, signer!, v2) : await unstarRepo(sdk!, signer!, listingId!)).deleted,
  })

  const starred = star.on === true
  const cost = previewCreate('star')
  const onClick = (): void => {
    if (!starred && !guard.check(cost.credits)) return
    if (!identity || !signer) return
    void star.toggle()
  }

  const signedIn = identity !== null && signer !== null
  // Signed in but the current state is not known yet (or could not be read): no action to offer.
  const unknown = signedIn && target !== null && star.on === null

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
        disabled={!target || (unknown && star.error !== null) || (!starred && guard.disabledReason !== null)}
        title={
          !target
            ? 'This repo has no registry listing, so it cannot be starred.'
            : starred
              ? 'Unstar (returns the star’s storage)'
              : `Star · ~${creditsAsDash(cost.credits)} DASH`
        }
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
