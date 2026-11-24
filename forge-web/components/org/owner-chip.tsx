'use client'

import Link from 'next/link'
import { Users } from 'lucide-react'

import { useAsync } from '@/hooks/use-async'
import { ORGS_ON, useOrgRecords } from '@/hooks/use-orgs'
import { useSdk } from '@/hooks/use-sdk'
import { DEFAULT_NETWORK, NETWORKS } from '@/lib/constants'
import { orgNetworkName } from '@/lib/org/gate'
import { detectOwnerKind, type OwnerKind } from '@/lib/org/identity'
import type { EvoSDK } from '@dashevo/evo-sdk'

const kinds = new Map<string, Promise<OwnerKind>>()

function ownerKind(sdk: EvoSDK, ownerId: string): Promise<OwnerKind> {
  let k = kinds.get(ownerId)
  const forge = NETWORKS[DEFAULT_NETWORK].v2
  if (k === undefined) {
    k = forge === null ? Promise.resolve({ kind: 'person' } as const) : detectOwnerKind(sdk, forge, ownerId, orgNetworkName())
    kinds.set(ownerId, k)
    k.catch(() => kinds.delete(ownerId))
  }
  return k
}

export function ownerChipText(kind: OwnerKind | null, connected: { threshold: number; size: number } | null): string | null {
  if (connected) return `Organization · ${connected.threshold} of ${connected.size}`
  if (kind?.kind === 'org') return `Organization · ${kind.threshold} of ${kind.size}`
  if (kind?.kind === 'multisig') return 'Multisig'
  return null
}

export function useOwnerKind(ownerId: string): { text: string | null; connected: boolean; isOrg: boolean } {
  const records = useOrgRecords()
  const record = records.find((r) => r.orgId === ownerId) ?? null
  const { sdk, ready } = useSdk()
  const kind = useAsync(() => ownerKind(sdk!, ownerId), [ownerId, ready], { enabled: ORGS_ON && ready && sdk !== null && record === null })
  if (!ORGS_ON) return { text: null, connected: false, isOrg: false }
  const text = ownerChipText(kind.data, record ? { threshold: record.threshold, size: record.members.length } : null)
  return { text, connected: record !== null, isOrg: text !== null }
}

export function OwnerChip({ ownerId }: { ownerId: string }): JSX.Element | null {
  const { text } = useOwnerKind(ownerId)
  if (text === null) return null
  return (
    <Link
      href={`/org/?id=${encodeURIComponent(ownerId)}`}
      data-testid="owner-chip"
      className="inline-flex items-center gap-1 rounded-full border border-anvil-300 px-2 py-0.5 text-[12px] text-anvil-700 hover:bg-anvil-100 dark:border-anvil-700 dark:text-anvil-200 dark:hover:bg-anvil-800"
    >
      <Users className="h-3 w-3" aria-hidden /> {text}
    </Link>
  )
}

export function OrgConnectNote({ ownerId }: { ownerId: string }): JSX.Element | null {
  const { isOrg, connected } = useOwnerKind(ownerId)
  if (!isOrg || connected) return null
  return (
    <p className="mt-2 text-[12px] text-anvil-500 dark:text-anvil-400" data-testid="org-connect-note">
      An organization owns this repository.{' '}
      <Link href={`/org/?id=${encodeURIComponent(ownerId)}`} className="underline">
        Member? Connect it
      </Link>{' '}
      to sign its requests.
    </p>
  )
}

export function OrgManagesAccess({ what = 'access' }: { what?: 'access' | 'details' }): JSX.Element {
  return (
    <p className="text-dense text-anvil-600 dark:text-anvil-300" data-testid="org-manages-access">
      {what === 'access' ? "The organization's members manage access to this repository." : "The organization's members edit these details."}
    </p>
  )
}
