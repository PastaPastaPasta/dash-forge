'use client'

/**
 * Star button — toggles the viewer's star on a repo: a forge-collab `star` (indexOnly; unstar
 * is an index-only delete that returns its storage). The starred/unstarred state is read from
 * the viewer's own star before the button offers an action, and a failed read or write is
 * shown rather than swallowed. The price shows beside the button before the click (`ux-dx-spec.md`
 * §4 rule 1): the star's cost, or the unstar's refund (D-011); a refused write opens its fix.
 */

import { useState } from 'react'
import { Star } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useFirstWrite } from '@/hooks/use-first-write'
import { useRelationToggle } from '@/hooks/use-relation-toggle'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { starFirsts, starRelation, type RepoRef } from '@/lib/repo'
import { previewCreate, previewDelete } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

export function StarButton({
  repo,
  count,
}: {
  repo: RepoRef
  /** The public star count; `null` when it could not be read. */
  count: number | null
}): JSX.Element {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()

  const star = useRelationToggle({
    enabled: ready && sdk !== null && identity !== null,
    key: `${network}:${identity ?? ''}:${repo.repoId}`,
    ...starRelation(sdk!, signer, identity ?? '', repo),
    onError: guard.failed,
  })

  const starred = star.on === true
  // Read which subtrees a star would create only once the viewer points at the button: a page
  // view costs no reads, and the price is an upper bound until then.
  const [interested, setInterested] = useState(false)
  const first = useFirstWrite(
    () => starFirsts(sdk!, repo, identity!, count),
    [repo.repoId, identity ?? '', count],
    interested && ready && sdk !== null && identity !== null && !starred,
  )
  const cost = previewCreate('star', {}, first)
  const refund = previewDelete('star')
  const onClick = (): void => {
    if (!starred && !guard.check(cost, 'collab')) return
    if (!identity || !signer) return
    void star.toggle()
  }

  const signedIn = identity !== null && signer !== null
  // Signed in but the current state is not known yet (or could not be read): no action to offer.
  const unknown = signedIn && star.on === null
  const price = starred ? `Unstar · refunds at least ${creditsAsDash(-refund.credits)} DASH` : `Star · ~${creditsAsDash(cost.credits)} DASH`

  return (
    <span className="inline-flex items-center gap-2">
      {star.error ? (
        <span role="alert" className="max-w-[16rem] truncate text-[12px] text-danger-700 dark:text-danger-400" title={star.error}>
          {star.error}
        </span>
      ) : null}
      <Button
        variant={starred ? 'subtle' : 'outline'}
        size="sm"
        onClick={onClick}
        onPointerEnter={() => setInterested(true)}
        onFocus={() => setInterested(true)}
        loading={star.busy || (unknown && star.error === null)}
        disabled={(unknown && star.error !== null) || (!starred && guard.disabledReason !== null)}
        title={price}
        aria-label={`${starred ? 'Starred' : 'Star'} (${price})`}
        data-testid="star-button"
      >
        <Star className={starred ? 'h-3.5 w-3.5 fill-forge-500 text-forge-500' : 'h-3.5 w-3.5'} aria-hidden />
        {starred ? 'Starred' : 'Star'}
        <span className="ml-1 rounded bg-anvil-100 px-1 font-mono text-[11px] text-anvil-500 dark:bg-anvil-800 dark:text-anvil-400">
          {count === null ? '–' : Math.max(0, count + star.delta)}
        </span>
      </Button>
      {/* The price in view before the one-click write (D-098, style guide rule 2), as Follow shows it. */}
      {signedIn && star.on !== null ? (
        <span className="font-mono text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="star-cost">
          {starred ? `+${creditsAsDash(-refund.credits)}` : `~${creditsAsDash(cost.credits)}`} DASH
        </span>
      ) : null}
    </span>
  )
}
