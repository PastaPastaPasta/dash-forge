'use client'

import { ORGS_ON, useWaitingRequests } from '@/hooks/use-orgs'
import { RequestCard } from './request-card'

export function NeedsSignature(): JSX.Element | null {
  const waiting = useWaitingRequests()
  if (!ORGS_ON || waiting.length === 0) return null
  return (
    <section className="space-y-3" aria-label="Needs your signature" data-testid="needs-signature">
      <h2 className="text-prose">Needs your signature</h2>
      {waiting.map(({ view, request }) => (
        <div key={`${view.record.orgId}:${request.request.id}`}>
          <p className="mb-1 text-[12px] text-anvil-500 dark:text-anvil-400">{view.record.label}</p>
          <RequestCard view={view} request={request} />
        </div>
      ))}
    </section>
  )
}
