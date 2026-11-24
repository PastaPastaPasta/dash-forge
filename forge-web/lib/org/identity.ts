import type { EvoSDK } from '@dashevo/evo-sdk'

import { publicKeyHash } from '../auth/identity-lookup'
import type { ForgeIds } from '../deployments'
import { readProfile } from '../repo/profile'
import { authSdk, type WasmIdentity, type WasmKey } from '../sdk/facade'
import { parseDeclaredOrg } from './gate'
import type { Ceremony, CeremonyResult, RoomState } from './state'

export const KEY_TYPE_BLS = 1
const PURPOSE_AUTHENTICATION = 0
const LEVEL_HIGH = 2

export interface OrgIdentity {
  readonly orgId: string
  readonly ceremony: Ceremony
  readonly keyId: number
  readonly slot: string
  readonly groupPublicKey: string
}

export function highSlot(result: CeremonyResult): { slot: string; keyId: number; groupPublicKey: string } | null {
  const k = Object.values(result.keys).find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH')
  return k ? { slot: k.slot, keyId: k.keyId, groupPublicKey: k.groupPublicKey } : null
}

export function groupKeyEnabled(identity: Pick<WasmIdentity, 'publicKeys'>, keyId: number, groupPublicKey: string): boolean {
  const key = identity.publicKeys.find((k) => k.keyId === keyId)
  return (
    key !== undefined &&
    key.keyTypeNumber === KEY_TYPE_BLS &&
    key.purposeNumber === PURPOSE_AUTHENTICATION &&
    key.securityLevelNumber === LEVEL_HIGH &&
    key.disabledAt === undefined &&
    (key.data ?? '').toLowerCase() === groupPublicKey.toLowerCase()
  )
}

export async function findOrgIdentity(sdk: EvoSDK, state: RoomState): Promise<OrgIdentity | null> {
  const complete = Object.values(state.ceremonies)
    .filter((c) => c.status === 'complete' && c.result !== null)
    .sort((a, b) => b.configAt.localeCompare(a.configAt) || b.cid.localeCompare(a.cid))
  for (const c of complete) {
    const slot = highSlot(c.result as CeremonyResult)
    if (slot === null) continue
    const identity = await authSdk(sdk).identities.byPublicKeyHash(publicKeyHash(slot.groupPublicKey))
    if (!identity) continue
    try {
      if (groupKeyEnabled(identity, slot.keyId, slot.groupPublicKey)) {
        return { orgId: identity.id.toBase58(), ceremony: c, keyId: slot.keyId, slot: slot.slot, groupPublicKey: slot.groupPublicKey }
      }
    } finally {
      ;(identity as { free?: () => void }).free?.()
    }
  }
  return null
}

export function allBlsAuthKeys(keys: readonly Pick<WasmKey, 'purposeNumber' | 'disabledAt' | 'keyTypeNumber'>[]): boolean {
  const live = keys.filter((k) => k.purposeNumber === PURPOSE_AUTHENTICATION && k.disabledAt === undefined)
  return live.length > 0 && live.every((k) => k.keyTypeNumber === KEY_TYPE_BLS)
}

export type OwnerKind =
  | { readonly kind: 'person' }
  | { readonly kind: 'org'; readonly threshold: number; readonly size: number }
  | { readonly kind: 'multisig' }

export async function detectOwnerKind(sdk: EvoSDK, forge: ForgeIds, identityId: string, network: string): Promise<OwnerKind> {
  const identity = await authSdk(sdk).identities.fetch(identityId)
  if (identity === undefined || !allBlsAuthKeys(identity.publicKeys)) return { kind: 'person' }
  const profile = await readProfile(sdk, forge, identityId).catch(() => null)
  for (const link of profile?.fields.links ?? []) {
    const declared = parseDeclaredOrg(link, network)
    if (declared) return { kind: 'org', ...declared }
  }
  return { kind: 'multisig' }
}
