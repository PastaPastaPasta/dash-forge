'use client'

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'

import { useAuth } from '@/contexts/auth-context'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { orgNetworkName, orgsEnabled } from '@/lib/org/gate'
import { waitingForViewer } from '@/lib/org/requests'
import { loadOrg, membershipRecords, orgPortFor, type OrgView } from '@/lib/org/service'
import type { OrgPort } from '@/lib/org/transport'
import { connectedOrgs, lockAll, saveOrg, subscribeOrgs, subscribeUnlock, unlockGeneration, unlockedFor, type OrgRecord, type Unlocked } from '@/lib/org/store'
import { ensureSdk } from '@/lib/sdk'
import { POLL_MS } from '@/lib/view/inbox'
import { errorMessage } from '@/lib/utils'

interface OrgsState {
  readonly views: Readonly<Record<string, OrgView>>
  readonly errors: Readonly<Record<string, string>>
  readonly polling: boolean
  readonly nudge: number
}

export const useOrgsStore = create<OrgsState>(() => ({ views: {}, errors: {}, polling: false, nudge: 0 }))

export const ORGS_ON = orgsEnabled(DEFAULT_NETWORK)
const NETWORK = orgNetworkName()
const NONE: readonly OrgRecord[] = []

/**
 * The organizations remembered here, one per organization, for whoever is signed in: records
 * another identity connected are left out, and this identity's record wins over an older one.
 */
export function recordsFor(records: readonly OrgRecord[], identity: string | null): readonly OrgRecord[] {
  const byOrg = new Map<string, OrgRecord>()
  for (const r of records) {
    if (identity !== null && r.identityId !== undefined && r.identityId !== identity) continue
    const held = byOrg.get(r.orgId)
    if (!held || (held.identityId === undefined && r.identityId !== undefined)) byOrg.set(r.orgId, r)
  }
  return byOrg.size === records.length ? records : [...byOrg.values()]
}

export function useOrgRecords(): readonly OrgRecord[] {
  const { identity } = useAuth()
  const all = useSyncExternalStore(
    subscribeOrgs,
    () => (ORGS_ON ? connectedOrgs(NETWORK) : NONE),
    () => NONE,
  )
  return useMemo(() => recordsFor(all, identity), [all, identity])
}

export function useUnlocked(authPub: string | undefined): Unlocked | null {
  useSyncExternalStore(subscribeUnlock, unlockGeneration, () => 0)
  return authPub ? unlockedFor(authPub) : null
}

export function refreshOrgs(): void {
  useOrgsStore.setState((s) => ({ nudge: s.nudge + 1 }))
}

export function setOrgView(view: OrgView): void {
  useOrgsStore.setState((s) => ({ views: { ...s.views, [view.record.orgId]: view } }))
}

export function waitingCount(views: Readonly<Record<string, OrgView>>, records: readonly OrgRecord[]): number {
  return waitingRequests(views, records).length
}

export function useWaitingCount(): number {
  const records = useOrgRecords()
  const views = useOrgsStore((s) => s.views)
  return waitingCount(views, records)
}

export function useOrgPoller(): void {
  const records = useOrgRecords()
  const { identity } = useAuth()
  const forge = NETWORKS[DEFAULT_NETWORK].v2
  const signedIn = useRef(identity !== null)

  useEffect(() => {
    if (signedIn.current && identity === null) lockAll()
    signedIn.current = identity !== null
    useOrgsStore.setState({ views: {}, errors: {} })
  }, [identity])

  useEffect(() => {
    if (!ORGS_ON || forge === null || (records.length === 0 && identity === null)) {
      useOrgsStore.setState({ views: {}, errors: {}, polling: false })
      return
    }
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async (fresh = false): Promise<void> => {
      if (cancelled || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      useOrgsStore.setState({ polling: true })
      try {
        const sdk = await ensureSdk(DEFAULT_NETWORK)
        const port = orgPortFor(sdk, forge)
        const known = new Set(records.map((r) => r.orgId))
        const joined = identity === null ? [] : (await joinedOrgs(port, identity, fresh)).filter((r) => !known.has(r.orgId))
        for (const record of [...records, ...joined]) {
          try {
            const view = await loadOrg(sdk, record, { network: DEFAULT_NETWORK, forge, port })
            if (cancelled) return
            if (!known.has(record.orgId)) saveOrg(view.record)
            useOrgsStore.setState((s) => {
              const errors = { ...s.errors }
              delete errors[record.orgId]
              return { views: { ...s.views, [record.orgId]: view }, errors }
            })
          } catch (e) {
            if (!cancelled) useOrgsStore.setState((s) => ({ errors: { ...s.errors, [record.orgId]: errorMessage(e) } }))
          }
        }
      } catch (e) {
        if (!cancelled) useOrgsStore.setState({ errors: Object.fromEntries(records.map((r) => [r.orgId, errorMessage(e)])) })
      } finally {
        inFlight = false
        if (!cancelled) useOrgsStore.setState({ polling: false })
      }
    }
    const schedule = (): void => {
      timer = setTimeout(() => {
        void run().finally(() => {
          if (!cancelled) schedule()
        })
      }, POLL_MS)
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void run()
    }
    const off = useOrgsStore.subscribe((s, prev) => {
      if (s.nudge !== prev.nudge) void run(true)
    })
    void run()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      off()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [records, forge, identity])
}

const MEMBERSHIPS_MS = 10 * 60_000
let memberships: { readonly identity: string; readonly at: number; readonly records: readonly OrgRecord[] } | null = null

/** The signed-in identity's organizations from its `orgMember` documents, read again every few minutes or when asked. */
async function joinedOrgs(port: OrgPort, identity: string, fresh: boolean): Promise<readonly OrgRecord[]> {
  if (!fresh && memberships?.identity === identity && Date.now() - memberships.at < MEMBERSHIPS_MS) return memberships.records
  try {
    const records = await membershipRecords(port, identity, NETWORK)
    memberships = { identity, at: Date.now(), records }
    return records
  } catch {
    return memberships?.identity === identity ? memberships.records : []
  }
}

export function OrgPoller(): null {
  useOrgPoller()
  return null
}

export function useOrgView(orgId: string): { view: OrgView | null; error: string | null; polling: boolean; reload: () => void } {
  const view = useOrgsStore((s) => s.views[orgId] ?? null)
  const error = useOrgsStore((s) => s.errors[orgId] ?? null)
  const polling = useOrgsStore((s) => s.polling)
  const reload = useCallback(() => refreshOrgs(), [])
  return { view, error, polling, reload }
}

export interface WaitingRequest {
  readonly view: OrgView
  readonly request: OrgView['requests'][number]
}

export function waitingRequests(views: Readonly<Record<string, OrgView>>, records: readonly OrgRecord[]): WaitingRequest[] {
  const out: WaitingRequest[] = []
  for (const r of records) {
    const view = views[r.orgId]
    if (!view || view.reconnect) continue
    for (const request of view.requests) if (waitingForViewer(request.status, request.viewerSigned, request.viewerDeclined)) out.push({ view, request })
  }
  return out
}

export function useWaitingRequests(): WaitingRequest[] {
  const records = useOrgRecords()
  const views = useOrgsStore((s) => s.views)
  return waitingRequests(views, records)
}
