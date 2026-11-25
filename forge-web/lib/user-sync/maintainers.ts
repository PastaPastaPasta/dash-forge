/**
 * Maintainers use the owner's storage (docs/design/identity-synced-state.md §5): the owner writes
 * the repo's `share` (the profiles its storage policy names, under the repo storage key) and one
 * `grant` per current maintainer with a forge-user key (that key, wrapped to them). A removal moves
 * to the next epoch, re-encrypts the share, rewrites the remaining grants, and deletes the removed
 * member's. A maintainer reads its grant, accepts it only from the repo's owner, and uses the
 * profiles for pushes to that repo alone.
 */

import { decodeIdentifier } from '../auth/base58'
import { PLATFORM_PROFILE, policySchema, type StoragePolicy, type StorageProfile } from '../storage/profiles'
import { policyForRepo, type StorageConfig } from '../storage/store'
import { canonicalJson, openShare, repoStorageKey, sealShare, unwrapGrant, wrapGrant, type GrantParams } from './crypto'
import type { GrantFields, Stored, UserSyncPort } from './platform'
import { profileOf } from './storage-slot'

export const SHARE_FORMAT = 'forge-user/share'

export interface SharePlain {
  readonly format: typeof SHARE_FORMAT
  readonly version: 1
  readonly profiles: Readonly<Record<string, { readonly settings: unknown; readonly secrets: unknown }>>
  readonly policy: StoragePolicy
}

/** What the owner shares for `repoId`: the profiles its policy names, or null when it names only Platform. */
export function sharePlain(config: StorageConfig, repoId: string): SharePlain | null {
  const policy = policyForRepo(config, repoId)
  if (policy === null) return null
  const named = policy.targets.map((t) => config.profiles.find((p) => p.name === t)).filter((p): p is StorageProfile => p !== undefined)
  if (!named.some((p) => p.settings.kind !== 'platform')) return null
  return { format: SHARE_FORMAT, version: 1, profiles: Object.fromEntries(named.map((p) => [p.name, { settings: p.settings, secrets: p.secrets }])), policy }
}

export interface OwnerContext {
  readonly port: UserSyncPort
  readonly networkKey: string
  readonly ownerId: string
  readonly keyId: number
  /** The owner's forge-user key; the caller wipes it. */
  readonly E: Uint8Array
}

export interface Reconciled {
  /** Maintainers holding a current grant. */
  readonly granted: readonly string[]
  /** Maintainers with no forge-user key yet: they get access after signing in with a wallet once. */
  readonly waiting: readonly string[]
  /** Whether a share exists (so a removed maintainer may have seen its credentials). */
  readonly shared: boolean
  readonly epoch: number | null
}

/**
 * Bring `repoId`'s share and grants in line with the owner's effective storage config and the
 * repo's current maintainers. A grant to anyone else (`removed`, or found stale) moves to the next
 * epoch first. Writes only what differs.
 */
export async function reconcileRepoShare(ctx: OwnerContext, p: { readonly repoId: string; readonly config: StorageConfig; readonly maintainers: readonly string[]; readonly removed?: readonly string[] }): Promise<Reconciled> {
  const network = ctx.networkKey
  const repo = decodeIdentifier(p.repoId)
  const members = [...new Set(p.maintainers)].filter((m) => m !== ctx.ownerId).sort()
  const grants = await ctx.port.grantsOf(ctx.ownerId, p.repoId)
  const stale = grants.filter((g) => g.ownerId === ctx.ownerId && !members.includes(g.fields.memberId))
  const existing = await ctx.port.readShare(ctx.ownerId, p.repoId)
  const plain = sharePlain(p.config, p.repoId)
  if (plain === null) {
    // Nothing of the owner's to share now: grants to former maintainers still go.
    for (const g of stale) await ctx.port.deleteGrant(g)
    return { granted: [], waiting: [], shared: existing !== null, epoch: existing?.fields.epoch ?? null }
  }
  const bump = existing !== null && (stale.length > 0 || (p.removed ?? []).length > 0)
  const epoch = existing === null ? 0 : existing.fields.epoch + (bump ? 1 : 0)
  if (epoch > 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
  const rsk = await repoStorageKey(ctx.E, repo, network, epoch)
  try {
    let same = false
    if (existing !== null && !bump && existing.fields.keyId === ctx.keyId) {
      const current = await openShare(rsk, { network, repoId: repo }, existing.fields).catch(() => null)
      same = current !== null && canonicalJson(current) === canonicalJson(plain)
    }
    if (!same) await ctx.port.writeShare(p.repoId, await sealShare(rsk, { network, repoId: repo, epoch, keyId: ctx.keyId }, plain), existing)
    const granted: string[] = []
    const waiting: string[] = []
    for (const member of members) {
      const key = await ctx.port.syncKey(member)
      if (key === null) {
        waiting.push(member)
        continue
      }
      const own = grants.find((g) => g.fields.memberId === member) ?? null
      if (own !== null && own.fields.epoch === epoch && own.fields.senderKeyId === ctx.keyId && own.fields.recipientKeyId === key.keyId) {
        granted.push(member)
        continue
      }
      const params: GrantParams = { network, ownerId: decodeIdentifier(ctx.ownerId), repoId: repo, memberId: decodeIdentifier(member), epoch, senderKeyId: ctx.keyId, recipientKeyId: key.keyId }
      const fields: GrantFields = { repoId: p.repoId, memberId: member, epoch, senderKeyId: ctx.keyId, recipientKeyId: key.keyId, wrapped: await wrapGrant(ctx.E, key.pub, params, rsk) }
      await ctx.port.writeGrant(fields, own)
      granted.push(member)
    }
    for (const g of stale) await ctx.port.deleteGrant(g)
    return { granted, waiting, shared: true, epoch }
  } finally {
    rsk.fill(0)
  }
}

export interface MemberContext {
  readonly port: UserSyncPort
  readonly networkKey: string
  readonly memberId: string
  readonly keyId: number
  /** The maintainer's forge-user key; the caller wipes it. */
  readonly E: Uint8Array
}

export interface GrantedStorage {
  readonly profiles: readonly StorageProfile[]
  readonly policy: StoragePolicy
  readonly epoch: number
}

/**
 * The owner's storage granted to this maintainer for `repoId`, or null (no grant to this key, or
 * nothing that opens). Only a grant and share whose `$ownerId` is the repo's owner count; the
 * caller has checked that the member is a current maintainer.
 */
export async function readGrantedStorage(ctx: MemberContext, p: { readonly repoId: string; readonly repoOwnerId: string }): Promise<GrantedStorage | null> {
  const network = ctx.networkKey
  const repo = decodeIdentifier(p.repoId)
  const grants: Stored<GrantFields>[] = (await ctx.port.grantsFor(ctx.memberId, p.repoId)).filter(
    (g) => g.ownerId === p.repoOwnerId && g.fields.memberId === ctx.memberId && g.fields.repoId === p.repoId && g.fields.recipientKeyId === ctx.keyId,
  )
  const grant = grants.sort((a, b) => b.fields.epoch - a.fields.epoch)[0]
  if (!grant) return null
  const share = await ctx.port.readShare(p.repoOwnerId, p.repoId)
  if (share === null || share.ownerId !== p.repoOwnerId || share.fields.epoch !== grant.fields.epoch || share.fields.keyId !== grant.fields.senderKeyId) return null
  const ownerKey = await ctx.port.syncKey(p.repoOwnerId, grant.fields.senderKeyId)
  if (ownerKey === null) return null
  const params: GrantParams = { network, ownerId: decodeIdentifier(p.repoOwnerId), repoId: repo, memberId: decodeIdentifier(ctx.memberId), epoch: grant.fields.epoch, senderKeyId: grant.fields.senderKeyId, recipientKeyId: grant.fields.recipientKeyId }
  let rsk: Uint8Array
  try {
    rsk = await unwrapGrant(ctx.E, ownerKey.pub, params, grant.fields.wrapped)
  } catch {
    return null
  }
  try {
    const plain = (await openShare(rsk, { network, repoId: repo }, share.fields).catch(() => null)) as Record<string, unknown> | null
    if (plain === null || plain['format'] !== SHARE_FORMAT || typeof plain['profiles'] !== 'object' || plain['profiles'] === null) return null
    const policy = policySchema.safeParse(plain['policy'])
    if (!policy.success) return null
    const profiles = Object.entries(plain['profiles'] as Record<string, unknown>).flatMap(([name, v]) => profileOf(name, v) ?? [])
    if (!policy.data.targets.every((t) => profiles.some((x) => x.name === t))) return null
    return { profiles, policy: policy.data, epoch: grant.fields.epoch }
  } finally {
    rsk.fill(0)
  }
}

/** A shared profile's name in the maintainer's config: apart from the maintainer's own. */
export function sharedName(name: string): string {
  return name === PLATFORM_PROFILE ? PLATFORM_PROFILE : `shared-${name}`.slice(0, 64)
}

/**
 * The config pushes to `repoId` use: the maintainer's own, with the owner's shared profiles added
 * (renamed apart) and the shared policy for this repo, unless the maintainer chose one for it. No
 * other repo's policy names them.
 */
export function withGrantedStorage(config: StorageConfig, repoId: string, granted: GrantedStorage | null): StorageConfig {
  if (granted === null || config.repoPolicies[repoId] !== undefined) return config
  const own = new Set(config.profiles.map((p) => p.name))
  const added = granted.profiles.filter((p) => !(p.name === PLATFORM_PROFILE && own.has(PLATFORM_PROFILE))).map((p) => ({ ...p, name: sharedName(p.name) }) as StorageProfile)
  const profiles = [...config.profiles.filter((p) => !added.some((a) => a.name === p.name)), ...added]
  const policy: StoragePolicy = { ...granted.policy, targets: granted.policy.targets.map(sharedName) }
  return { ...config, profiles, repoPolicies: { ...config.repoPolicies, [repoId]: policy } }
}
