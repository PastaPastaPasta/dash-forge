'use client'

import { Check, Link2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useCopy } from '@/hooks/use-copy'
import { useOrgsStore, useUnlocked, setOrgView } from '@/hooks/use-orgs'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { declineRequest, finishRequest, loadOrg, requestLink, signRequest, type OrgView, type RequestView } from '@/lib/org/service'
import type { Unlocked } from '@/lib/org/store'
import { ensureSdk } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'
import { timeAgo } from '@/lib/view/format'
import { UnlockDialog } from './unlock-dialog'

export function absoluteRequestLink(orgId: string, requestId: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${process.env.NEXT_PUBLIC_BASE_PATH || ''}${requestLink(orgId, requestId)}`
}

export function CopyRequestLink({ orgId, requestId, label = 'Copy link' }: { orgId: string; requestId: string; label?: string }): JSX.Element {
  const [copied, copy] = useCopy(absoluteRequestLink(orgId, requestId))
  return (
    <Button size="sm" variant="outline" onClick={() => void copy()} data-testid="org-copy-link">
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function Sentences({ request }: { request: RequestView }): JSX.Element {
  const lines = request.proposals.map((p) => p.sentence)
  if (lines.length === 1) return <p className="text-prose font-medium">{lines[0]}</p>
  return (
    <div>
      <p className="text-prose font-medium">{lines[0]}</p>
      <ul className="mt-1 list-disc pl-5 text-dense text-anvil-600 dark:text-anvil-300">
        {lines.slice(1).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  )
}

type Pending = 'sign' | 'decline' | 'finish'

const proposalIds = (r: RequestView): string => r.request.proposals.map((p) => p.id).join(',')

export function RequestCard({ view, request, highlight = false }: { view: OrgView; request: RequestView; highlight?: boolean }): JSX.Element {
  const { record } = view
  const unlocked = useUnlocked(record.authPub)
  const [asking, setAsking] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<Pending | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const forge = NETWORKS[DEFAULT_NETWORK].v2
  const card = request.card

  const act = async (what: Pending, u: Unlocked): Promise<void> => {
    if (forge === null) return
    setBusy(what)
    setProblem(null)
    try {
      const sdk = await ensureSdk(DEFAULT_NETWORK)
      const opts = { network: DEFAULT_NETWORK, forge }
      const fresh = useOrgsStore.getState().views[record.orgId] ?? view
      const current = fresh.requests.find((r) => r.request.id === request.request.id) ?? request
      if (what !== 'decline' && proposalIds(current) !== proposalIds(request)) {
        throw new Error('this request changed while you were reading it; review it again before signing')
      }
      if (what === 'sign') await signRequest(sdk, fresh, current, u, opts)
      else if (what === 'finish') await finishRequest(sdk, fresh, current, u, opts)
      else await declineRequest(fresh, current, u)
      setOrgView(await loadOrg(sdk, record, opts))
    } catch (e) {
      setProblem(errorMessage(e, 'that did not go through; try again'))
      try {
        const sdk = await ensureSdk(DEFAULT_NETWORK)
        setOrgView(await loadOrg(sdk, record, { network: DEFAULT_NETWORK, forge }))
      } catch {
        /* the poller retries */
      }
    } finally {
      setBusy(null)
    }
  }

  const start = (what: Pending): void => {
    if (unlocked) void act(what, unlocked)
    else setAsking(what)
  }

  const at = Date.parse(request.request.at)
  return (
    <article
      id={`request-${request.request.id}`}
      data-testid="org-request"
      data-state={card.kind}
      className={`rounded-lg border p-4 ${highlight ? 'border-forge-500' : 'border-anvil-200 dark:border-anvil-800'}`}
    >
      <Sentences request={request} />
      <p className="mt-1 text-[12px] text-anvil-500 dark:text-anvil-400">
        Asked by {request.proposer}
        {Number.isFinite(at) ? ` · ${timeAgo(at)}` : ''}
        {!request.request.forge ? ' · made outside Forge' : ''}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {card.kind === 'sign' ? (
          <>
            <Button variant="primary" loading={busy === 'sign'} onClick={() => start('sign')} data-testid="org-sign">
              Sign ({card.collected} of {card.needed} collected)
            </Button>
            {!request.viewerDeclined ? (
              <button type="button" className="text-dense text-anvil-600 underline hover:text-anvil-800 dark:text-anvil-300" disabled={busy !== null} onClick={() => start('decline')} data-testid="org-decline">
                {busy === 'decline' ? 'Declining…' : 'Decline'}
              </button>
            ) : (
              <span className="text-dense text-anvil-500 dark:text-anvil-400">You declined</span>
            )}
          </>
        ) : null}
        {card.kind === 'signed' ? (
          <>
            <span className="text-dense" data-testid="org-signed">
              You signed · waiting for {card.missing} more
            </span>
            <CopyRequestLink orgId={record.orgId} requestId={request.request.id} />
          </>
        ) : null}
        {card.kind === 'finish' ? (
          <Button variant="primary" loading={busy === 'finish'} onClick={() => start('finish')} data-testid="org-finish">
            Finish
          </Button>
        ) : null}
        {card.kind === 'done' ? (
          <span className="inline-flex items-center gap-1 text-dense text-anvil-700 dark:text-anvil-200" data-testid="org-done">
            <Check className="h-4 w-4" aria-hidden /> Done
          </span>
        ) : null}
        {card.kind === 'expired' ? <span className="text-dense text-anvil-600 dark:text-anvil-300">Expired: the organization made another change first. Ask again if it is still needed.</span> : null}
        {card.kind === 'invalid' ? <span className="text-dense text-anvil-600 dark:text-anvil-300">Forge won&apos;t sign this: {card.reason || 'it is not an action Forge recognises'}.</span> : null}
      </div>
      {problem ? (
        <p role="alert" className="mt-2 text-dense text-danger-700 dark:text-danger-400">
          {problem}
        </p>
      ) : null}

      <details className="mt-3 text-dense">
        <summary className="cursor-pointer text-anvil-600 dark:text-anvil-300">Details</summary>
        <dl className="mt-2 space-y-1 text-[12px] text-anvil-600 dark:text-anvil-300">
          <div>
            <dt className="inline font-medium">Signed by: </dt>
            <dd className="inline">{request.signers.length ? request.signers.join(', ') : 'nobody yet'}</dd>
          </div>
          {request.decliners.length ? (
            <div>
              <dt className="inline font-medium">Declined by: </dt>
              <dd className="inline">{request.decliners.join(', ')}</dd>
            </div>
          ) : null}
          <div>
            <dt className="inline font-medium">Request: </dt>
            <dd className="inline font-mono">{request.request.id}</dd>
          </div>
          {request.proposals.map((p, i) => (
            <div key={p.id} className="rounded border border-anvil-200 p-2 dark:border-anvil-800">
              <div>
                Step {i + 1}: <span className="font-mono">{p.id}</span>
                {p.done ? ' · written' : ''}
              </div>
              {p.decoded ? (
                <div>
                  {p.decoded.action} {p.decoded.documentType} · nonce {p.decoded.nonce.toString()} · id <span className="font-mono">{p.decoded.documentId}</span>
                </div>
              ) : null}
              {p.problems.length ? <div>Review: {p.problems.join('; ')}</div> : null}
              <div className="mt-1 break-all font-mono text-[11px] text-anvil-500 dark:text-anvil-400">{request.request.proposals[i]?.body.unsigned}</div>
            </div>
          ))}
        </dl>
      </details>

      <UnlockDialog
        open={asking !== null}
        record={record}
        onClose={() => setAsking(null)}
        onUnlocked={(u) => {
          const what = asking
          setAsking(null)
          if (what) void act(what, u)
        }}
      />
    </article>
  )
}
