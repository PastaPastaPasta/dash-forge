'use client'

import Link from 'next/link'
import { useSyncExternalStore } from 'react'

import { ConnectFlow, NewOrganizationSteps } from '@/components/org/connect-flow'
import { CopyRequestLink, RequestCard } from '@/components/org/request-card'
import { OwnerChip } from '@/components/org/owner-chip'
import { PublishOrg } from '@/components/org/publish-org'
import { RepoCard } from '@/components/repo-card'
import { ErrorState, LoadingBlock } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { ORGS_ON, useOrgRecords, useOrgView } from '@/hooks/use-orgs'
import { useParam } from '@/hooks/use-query-param'
import { useSdk } from '@/hooks/use-sdk'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { findRequest, waitingForViewer } from '@/lib/org/requests'
import type { RequestView } from '@/lib/org/service'
import { dismissedRequests, subscribeDismissed, type OrgRecord } from '@/lib/org/store'
import { orgNetworkName } from '@/lib/org/gate'
import { listReposByOwner } from '@/lib/view'

export const NOT_ON_MAINNET = 'Organizations are not available on mainnet yet.'

export function OrgClient(): JSX.Element {
  if (!ORGS_ON) return <p className="mx-auto max-w-3xl text-dense" data-testid="org-off">{NOT_ON_MAINNET}</p>
  return <OrgRoute />
}

function OrgRoute(): JSX.Element {
  const id = useParam('id')
  const invite = useParam('invite')
  return id === '' ? <OrgHub invite={invite} /> : <OrgPage orgId={id} />
}

function OrgHub({ invite }: { invite: string }): JSX.Element {
  const records = useOrgRecords()
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl">Organizations</h1>
      {records.length > 0 ? (
        <ul className="divide-y divide-anvil-200 rounded-lg border border-anvil-200 dark:divide-anvil-800 dark:border-anvil-800" data-testid="org-list">
          {records.map((r) => (
            <OrgRow key={r.orgId} record={r} />
          ))}
        </ul>
      ) : null}
      <ConnectFlow initial={invite} />
      <NewOrganizationSteps />
    </div>
  )
}

const NONE_DISMISSED: ReadonlySet<string> = new Set()

function useDismissed(orgId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeDismissed,
    () => dismissedRequests(orgNetworkName(), orgId),
    () => NONE_DISMISSED,
  )
}

function OrgRow({ record: stored }: { record: OrgRecord }): JSX.Element {
  const { view } = useOrgView(stored.orgId)
  const record = view?.record ?? stored
  const waiting = view && !view.reconnect ? view.requests.filter((r) => waitingForViewer(r.status, r.viewerSigned, r.viewerDeclined)).length : 0
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <Link href={`/org/?id=${encodeURIComponent(record.orgId)}`} className="font-medium hover:underline">
        {record.label}
      </Link>
      <span className="text-[12px] text-anvil-500 dark:text-anvil-400">
        {view?.reconnect ? 'Connect again · ' : waiting > 0 ? `${waiting} waiting for your signature · ` : ''}
        {record.threshold} of {record.members.length}
      </span>
    </li>
  )
}

function OrgPage({ orgId }: { orgId: string }): JSX.Element {
  const records = useOrgRecords()
  const record = records.find((r) => r.orgId === orgId) ?? null
  const requestId = useParam('request')
  const sent = useParam('sent') === '1'
  const { view, error, reload } = useOrgView(orgId)
  const dismissed = useDismissed(orgId)

  if (record === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="flex flex-wrap items-center gap-2 text-xl">
          Organization <OwnerChip ownerId={orgId} />
        </h1>
        <p className="text-dense text-anvil-600 dark:text-anvil-300">If you are one of its members, connect it here to see and sign its requests.</p>
        <ConnectFlow />
        <OrgRepos orgId={orgId} />
      </div>
    )
  }

  const shownRecord = view?.record ?? record
  const visible = view?.requests.filter((r) => !dismissed.has(r.request.id)) ?? []
  const isOpen = (r: RequestView): boolean => r.status === 'collecting' || r.status === 'ready' || r.status === 'invalid'
  const open = visible.filter(isOpen)
  const earlier = visible.filter((r) => !isOpen(r))
  const focused = view && requestId !== '' ? findRequest(view.requests, requestId) : null
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-xl" data-testid="org-title">
        {shownRecord.label} · Organization · {shownRecord.threshold} of {shownRecord.members.length}
      </h1>

      {view?.reconnect ? (
        <div className="space-y-3" data-testid="org-reconnect">
          <p className="text-dense">The organization changed its keys, and none of yours is in its current roster. Connect it again with the new invite.</p>
          <ConnectFlow />
        </div>
      ) : null}

      {sent && requestId !== '' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-forge-500 p-4" data-testid="org-send">
          <p className="text-dense">Send this to your co-signers. They sign it from this page.</p>
          <CopyRequestLink orgId={orgId} requestId={focused?.request.id ?? requestId} />
        </div>
      ) : null}

      {view !== null ? <PublishOrg view={view} /> : null}

      <section className="space-y-3" aria-label="Open requests">
        <h2 className="text-prose">Open requests</h2>
        {view === null && error === null ? <LoadingBlock label="Reading the organization's requests" /> : null}
        {error !== null && view === null ? <ErrorState message={error} onRetry={reload} /> : null}
        {view !== null && view.unreadLogs > 0 ? (
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="org-unread-logs">
            {view.unreadLogs === 1 ? "One member's messages" : `${view.unreadLogs} members' messages`} could not be read just now, so some signatures may be missing. Forge tries again shortly.
          </p>
        ) : null}
        {view !== null && open.length === 0 && focused === null ? <p className="text-dense text-anvil-500 dark:text-anvil-400">Nothing waiting.</p> : null}
        {view !== null && focused !== null && !open.includes(focused) ? <RequestCard view={view} request={focused} highlight /> : null}
        {view !== null ? open.map((r) => <RequestCard key={r.request.id} view={view} request={r} highlight={r.request.id === requestId} />) : null}
        {view !== null && earlier.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-dense text-anvil-600 dark:text-anvil-300">Earlier requests ({earlier.length})</summary>
            <div className="mt-3 space-y-3">
              {earlier.map((r) => (
                <RequestCard key={r.request.id} view={view} request={r} />
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <OrgRepos orgId={orgId} canCreate />

      <details className="rounded-lg border border-anvil-200 p-4 dark:border-anvil-800">
        <summary className="cursor-pointer text-prose">Members ({shownRecord.members.length})</summary>
        <ul className="mt-2 space-y-1 text-dense">
          {shownRecord.members.map((m) => (
            <li key={m.authPub}>
              {m.name || `Member ${m.index}`}
              {m.authPub === shownRecord.authPub ? <span className="text-anvil-500 dark:text-anvil-400"> (you)</span> : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400">Members and the threshold change in multisig.dashhq.org.</p>
      </details>
    </div>
  )
}

function OrgRepos({ orgId, canCreate = false }: { orgId: string; canCreate?: boolean }): JSX.Element {
  const { sdk, ready } = useSdk()
  const repos = useAsync(() => listReposByOwner(sdk!, orgId, { network: DEFAULT_NETWORK, counts: true }), [orgId, ready], { enabled: ready && sdk !== null })
  return (
    <section className="space-y-3" aria-label="Repositories">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-prose">Repositories</h2>
        {canCreate ? (
          <Link href={`/new/?owner=${encodeURIComponent(orgId)}`} className="text-dense text-forge-700 underline dark:text-forge-400">
            New repository
          </Link>
        ) : null}
      </div>
      {repos.error ? <ErrorState message={repos.error} onRetry={repos.reload} /> : null}
      {repos.data === null && !repos.error ? <LoadingBlock /> : null}
      {repos.data !== null && repos.data.owned.length === 0 ? <p className="text-dense text-anvil-500 dark:text-anvil-400">No repositories yet.</p> : null}
      {repos.data !== null && repos.data.owned.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {repos.data.owned.map((r) => (
            <RepoCard key={r.key} repo={r} showOwner={false} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
