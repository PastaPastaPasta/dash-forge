'use client'

/**
 * useRepoTrust — the Verification card's report for a repo page, from what this session actually
 * checked: the SDK connection's proof mode, the quorum-key cross-check, the folded state of the
 * attested ref, and the browse plane's content-check ledger (which updates live as the page
 * reads objects). The repo frame derives it once: the rail's card renders it, and the page leads
 * with any Failed row (QW-004).
 */

import { useLayoutEffect, useSyncExternalStore } from 'react'

import {
  beginView,
  contentChecks,
  deriveTrust,
  NO_CONTENT_CHECKS,
  readGatewaysFor,
  subscribeContentChecks,
  type RepoHome,
  type SelectedRef,
  type TrustReport,
} from '@/lib/view'
import { repoContractIds, repoKey } from '@/lib/repo'
import { useSdk } from '@/hooks/use-sdk'
import { useQuorumCheck } from '@/hooks/use-quorum-check'
import { useTrustView } from '@/hooks/use-trust-view'

export function useRepoTrust(home: RepoHome, selected: SelectedRef): TrustReport {
  const { connection, network } = useSdk(repoContractIds(home.repo))
  // Not while Platform is unreachable: a comparison run then only reports that it could not run.
  const quorum = useQuorumCheck(network, connection === 'trusted')
  const key = repoKey(home.repo)
  // Each page (a route and its query: another file, ref or tab) is a new view: the summary names
  // the places that served ITS objects (L-18). A layout effect, so it runs before the page's own
  // effects start reading (its reads start the view themselves too, if they come first).
  const view = useTrustView()
  useLayoutEffect(() => beginView(key, view), [key, view])
  const checks = useSyncExternalStore(
    subscribeContentChecks,
    () => contentChecks(key),
    () => NO_CONTENT_CHECKS,
  )
  return deriveTrust({
    network,
    connection,
    quorum,
    refName: selected.name,
    tip: selected.pinned ? { pinned: selected.pinned } : selected.ref?.state ?? 'missing',
    checks,
    configuredBackend: home.backend.label,
    configuredUris: home.backend.uris,
    gateways: readGatewaysFor(key),
  })
}
