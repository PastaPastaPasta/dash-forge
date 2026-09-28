'use client'

/**
 * Watch button — the viewer's forge-collab `watch` on a repo (indexOnly, C-1): "watching" is
 * kept on chain, so every device's inbox follows the same repos. Unwatch is the values-carrying
 * indexOnly delete, refunded. The price shows before the click, as the star's does.
 */

import { Eye } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { useRelationToggle } from '@/hooks/use-relation-toggle'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { Button } from '@/components/ui/button'
import { watchRelation, type RepoRef } from '@/lib/repo'
import { previewCreate, previewDelete } from '@/lib/sdk'
import { creditsAsDash } from '@/lib/view/format'

export function WatchButton({ repo }: { repo: RepoRef }): JSX.Element | null {
  const { sdk, ready, network } = useSdk()
  const { identity, signer } = useAuth()
  const guard = useWriteGuard()
  const watch = useRelationToggle({
    enabled: ready && sdk !== null && identity !== null,
    key: `${network}:${identity ?? ''}:watch:${repo.repoId}`,
    ...watchRelation(sdk!, signer, identity ?? '', repo),
    onError: guard.failed,
  })
  if (identity === null || signer === null) return null
  const watching = watch.on === true
  const cost = previewCreate('watch', {})
  const refund = previewDelete('watch')
  const price = watching ? `Unwatch · refunds at least ${creditsAsDash(-refund.credits)} DASH` : `Watch · ~${creditsAsDash(cost.credits)} DASH`
  return (
    <span className="inline-flex items-center gap-2">
      {watch.error ? (
        <span role="alert" className="max-w-[16rem] truncate text-[12px] text-danger-700 dark:text-danger-400" title={watch.error}>
          {watch.error}
        </span>
      ) : null}
      <Button
        variant={watching ? 'subtle' : 'outline'}
        size="sm"
        onClick={() => {
          if (!watching && !guard.check(cost, 'collab')) return
          void watch.toggle()
        }}
        loading={watch.busy || (watch.on === null && watch.error === null)}
        disabled={(watch.on === null && watch.error !== null) || (!watching && guard.disabledReason !== null)}
        title={price}
        aria-label={`${watching ? 'Watching' : 'Watch'} (${price})`}
        data-testid="watch-button"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        {watching ? 'Watching' : 'Watch'}
      </Button>
    </span>
  )
}
