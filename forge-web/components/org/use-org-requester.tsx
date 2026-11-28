'use client'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { useContext, useRef, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { ORGS_ON, refreshOrgs, useOrgRecords, useOrgView } from '@/hooks/use-orgs'
import { newRequestCost } from '@/lib/org/cost'
import { orgWriteScope } from '@/lib/org/transport'
import { useWriteGuard } from '@/hooks/use-write-guard'
import type { CostPreview } from '@/lib/sdk'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { createRequest, requestLink, type CreateRequestInput } from '@/lib/org/service'
import { unlockedFor, type OrgRecord, type Unlocked } from '@/lib/org/store'
import { ensureSdk } from '@/lib/sdk'
import { UnlockDialog } from './unlock-dialog'

export class UnlockCancelled extends Error {
  constructor() {
    super('Unlock cancelled; nothing was sent.')
    this.name = 'UnlockCancelled'
  }
}

export interface OrgRequester {
  readonly record: OrgRecord | null
  readonly dialog: JSX.Element | null
  /** What posting a request of `parts` writes costs the signed-in member. */
  cost(parts: number): CostPreview
  submit(build: (sdk: EvoSDK) => Promise<CreateRequestInput | null>, intent?: string): Promise<boolean>
}

export function useOrgRequester(ownerId: string | null): OrgRequester {
  const router = useContext(AppRouterContext)
  const records = useOrgRecords()
  const record = ORGS_ON && ownerId ? (records.find((r) => r.orgId === ownerId) ?? null) : null
  const { signer } = useAuth()
  const guard = useWriteGuard()
  const { view } = useOrgView(ownerId ?? '')
  const needsMember = signer !== null && view !== null && !view.members.some((m) => m.ownerId === signer.identityId)
  const [asking, setAsking] = useState(false)
  const waiter = useRef<{ resolve: (u: Unlocked) => void; reject: (e: Error) => void } | null>(null)

  const unlock = (r: OrgRecord): Promise<Unlocked> => {
    const known = unlockedFor(r.authPub)
    if (known) return Promise.resolve(known)
    return new Promise<Unlocked>((resolve, reject) => {
      waiter.current = { resolve, reject }
      setAsking(true)
    })
  }

  const submit = async (build: (sdk: EvoSDK) => Promise<CreateRequestInput | null>, intent?: string): Promise<boolean> => {
    const forge = NETWORKS[DEFAULT_NETWORK].v2
    if (record === null || forge === null) throw new Error('connect the organization first')
    if (!guard.check(newRequestCost(1, needsMember), orgWriteScope(forge), 'ask the co-signers') || signer === null) {
      throw new Error('Sign in to Forge first: requests are posted with your own identity.')
    }
    const sdk = await ensureSdk(DEFAULT_NETWORK)
    const input = await build(sdk)
    if (input === null) return false
    const u = await unlock(record)
    const id = await createRequest(sdk, record, u, input, { network: DEFAULT_NETWORK, forge, auth: signer, ...(intent ? { intent } : {}) })
    refreshOrgs()
    const href = `${requestLink(record.orgId, id)}&sent=1`
    if (router) router.push(href)
    else window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH || ''}${href}`)
    return true
  }

  const dialog =
    record === null ? null : (
      <UnlockDialog
        open={asking}
        record={record}
        onClose={() => {
          setAsking(false)
          waiter.current?.reject(new UnlockCancelled())
          waiter.current = null
        }}
        onUnlocked={(u) => {
          setAsking(false)
          waiter.current?.resolve(u)
          waiter.current = null
        }}
      />
    )
  return { record, dialog, submit, cost: (parts) => newRequestCost(parts, needsMember) }
}
