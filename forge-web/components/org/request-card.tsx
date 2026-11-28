'use client'

import { Check, Link2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useCopy } from '@/hooks/use-copy'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useAuth } from '@/contexts/auth-context'
import { useOrgsStore, useUnlocked, setOrgView } from '@/hooks/use-orgs'
import { useWriteGuard } from '@/hooks/use-write-guard'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { orgWritesCost } from '@/lib/org/cost'
import { orgWriteScope } from '@/lib/org/transport'
import { declinedText, refusedText } from '@/lib/org/requests'
import { declineRequest, finishRequest, loadOrg, requestLink, signRequest, type OrgView, type RequestView } from '@/lib/org/service'
import { dismissRequest } from '@/lib/org/store'
import { ensureSdk, type CostPreview } from '@/lib/sdk'
import { timeAgo } from '@/lib/view/format'
import { EMPTY_PHRASE, PhraseField, unlockFrom, type PhraseState } from './phrase-field'

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

const ACTION: Readonly<Record<Pending, { title: string; confirm: string; done: string }>> = {
  sign: { title: 'Sign this request?', confirm: 'Sign', done: 'Signed' },
  decline: { title: 'Decline this request?', confirm: 'Decline', done: 'Declined' },
  finish: { title: 'Finish this request?', confirm: 'Finish', done: 'Finished' },
}

function actionCost(what: Pending, request: RequestView, firstWrite: boolean): CostPreview {
  const open = request.proposals.filter((p) => !p.done).length
  if (what === 'decline') return orgWritesCost({ approvals: open, member: firstWrite })
  if (what === 'finish') return orgWritesCost({ broadcasts: open, member: firstWrite })
  const completes = request.collected + 1 >= request.needed
  return orgWritesCost({ approvals: open, broadcasts: completes ? open : 0, member: firstWrite })
}

export function RequestCard({ view, request, highlight = false }: { view: OrgView; request: RequestView; highlight?: boolean }): JSX.Element {
  const { record } = view
  const unlocked = useUnlocked(record.authPub)
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const [asking, setAsking] = useState<Pending | null>(null)
  const [phrase, setPhrase] = useState<PhraseState>(EMPTY_PHRASE)
  const forge = NETWORKS[DEFAULT_NETWORK].v2
  const card = request.card
  const firstWrite = signer !== null && !view.members.some((m) => m.ownerId === signer.identityId)

  const act = async (what: Pending, intent: string): Promise<void> => {
    if (forge === null || signer === null) throw new Error('sign in to Forge first')
    const u = unlocked ?? (await unlockFrom(phrase, [record.authPub], record.label))
    setPhrase(EMPTY_PHRASE)
    const sdk = await ensureSdk(DEFAULT_NETWORK)
    const opts = { network: DEFAULT_NETWORK, forge, auth: signer, intent }
    try {
      const fresh = useOrgsStore.getState().views[record.orgId] ?? view
      const current = fresh.requests.find((r) => r.request.id === request.request.id) ?? request
      if (what !== 'decline' && proposalIds(current) !== proposalIds(request)) {
        throw new Error('this request changed while you were reading it; review it again before signing')
      }
      if (what === 'sign') await signRequest(sdk, fresh, current, u, opts)
      else if (what === 'finish') await finishRequest(sdk, fresh, current, u, opts)
      else await declineRequest(sdk, fresh, current, u, opts)
    } finally {
      await loadOrg(sdk, record, opts).then(setOrgView, () => undefined)
    }
  }

  const start = (what: Pending): void => {
    if (!guard.check(actionCost(what, request, firstWrite), orgWriteScope(forge), ACTION[what].confirm.toLowerCase())) return
    setAsking(what)
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
            <Button variant="primary" onClick={() => start('sign')} data-testid="org-sign">
              Sign ({card.collected} of {card.needed} collected)
            </Button>
            {!request.viewerDeclined ? (
              <button type="button" className="text-dense text-anvil-600 underline hover:text-anvil-800 dark:text-anvil-300" onClick={() => start('decline')} data-testid="org-decline">
                Decline
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
          <Button variant="primary" onClick={() => start('finish')} data-testid="org-finish">
            Finish
          </Button>
        ) : null}
        {card.kind === 'done' ? (
          <span className="inline-flex items-center gap-1 text-dense text-anvil-700 dark:text-anvil-200" data-testid="org-done">
            <Check className="h-4 w-4" aria-hidden /> {request.proposals.some((p) => p.gone) ? 'Done (no longer on Platform)' : 'Done'}
          </span>
        ) : null}
        {card.kind === 'expired' ? <span className="text-dense text-anvil-600 dark:text-anvil-300">Expired: the organization made another change first. Ask again if it is still needed.</span> : null}
        {card.kind === 'declined' ? <span className="text-dense text-anvil-600 dark:text-anvil-300">{declinedText(card.needed, card.size)}</span> : null}
        {card.kind === 'invalid' ? (
          <>
            <span className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="org-refused">
              {refusedText(card.reasons)}
            </span>
            <Button size="sm" variant="outline" onClick={() => dismissRequest(record.network, record.orgId, request.request.id)} data-testid="org-dismiss">
              Dismiss
            </Button>
          </>
        ) : null}
      </div>

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

      <ConfirmDialog
        open={asking !== null}
        onClose={() => {
          setAsking(null)
          setPhrase(EMPTY_PHRASE)
        }}
        title={asking ? ACTION[asking].title : ''}
        description={asking === 'decline' ? 'Declining does not block it; it ends once too many members decline.' : asking === 'finish' ? `The organization pays for its writes; this posts the result for ${record.label}.` : `Your signature counts toward ${request.needed} of ${record.members.length}. Once enough members sign, Forge sends it.`}
        cost={asking ? actionCost(asking, request, firstWrite) : null}
        confirmLabel={asking ? ACTION[asking].confirm : 'Confirm'}
        successNote={asking ? ACTION[asking].done : undefined}
        request
        onConfirm={(intent) => (asking ? act(asking, intent) : Promise.resolve())}
      >
        {unlocked ? null : <PhraseField value={phrase} onChange={setPhrase} autoFocus />}
      </ConfirmDialog>
    </article>
  )
}
