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
import type { GrantFields, UserSyncPort } from './platform'
import { profileOf } from './storage-slot'

export const SHARE_FORMAT = 'forge-user/share'

export interface SharePlain {
  readonly format: typeof SHARE_FORMAT
  readonly version: 1
  readonly profiles: Readonly<Record<string, { readonly settings: unknown; readonly secrets: unknown }>>
  /** Null: nothing is shared (the repo stores on Platform only, or has no policy). */
  readonly policy: StoragePolicy | null
}

/** The share that shares nothing: what stopping writes, at the next epoch. */
export const NOTHING_SHARED: SharePlain = { format: SHARE_FORMAT, version: 1, profiles: {}, policy: null }

/**
 * What the owner shares for `repoId` (the rule dg follows too): the owner's synced effective policy
 * for the repo (its `repo:<id>` policy, else the default) and the profiles it names, Platform
 * needing none; {@link NOTHING_SHARED} when it names nothing but Platform. `config` is the synced
 * config, never a device-local one.
 */
export function sharePlain(config: StorageConfig, repoId: string): SharePlain {
  const policy = policyForRepo(config, repoId)
  if (policy === null) return NOTHING_SHARED
  const named = policy.targets.map((t) => config.profiles.find((p) => p.name === t)).filter((p): p is StorageProfile => p !== undefined && p.settings.kind !== 'platform')
  if (named.length === 0) return NOTHING_SHARED
  return { format: SHARE_FORMAT, version: 1, profiles: Object.fromEntries(named.map((p) => [p.name, { settings: p.settings, secrets: p.secrets }])), policy }
}

/**
 * A share's content compared by meaning: the profile set, each one's settings and secrets (an empty
 * secret is an absent one) and the policy. Anything else a writer adds (dg's `dg` object) and the
 * key order do not count, so a share another client wrote is not rewritten for its bytes.
 */
export function shareMeaning(plain: unknown): string | null {
  if (typeof plain !== 'object' || plain === null) return null
  const r = plain as Record<string, unknown>
  if (r['format'] !== SHARE_FORMAT || typeof r['profiles'] !== 'object' || r['profiles'] === null) return null
  const profiles: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(r['profiles'] as Record<string, unknown>)) {
    const value = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
    const secrets = typeof value['secrets'] === 'object' && value['secrets'] !== null ? (value['secrets'] as Record<string, unknown>) : {}
    profiles[name] = { settings: value['settings'] ?? null, secrets: Object.fromEntries(Object.entries(secrets).filter(([, x]) => x !== undefined && x !== null && x !== '')) }
  }
  return canonicalJson({ profiles, policy: r['policy'] ?? null })
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
  const removed = new Set(p.removed ?? [])
  const members = [...new Set(p.maintainers)].filter((m) => m !== ctx.ownerId && !removed.has(m)).sort()
  const grants = (await ctx.port.grantsOf(ctx.ownerId, p.repoId)).filter((g) => g.ownerId === ctx.ownerId)
  const existing = await ctx.port.readShare(ctx.ownerId, p.repoId)
  const plain = sharePlain(p.config, p.repoId)
  const nothing = plain.policy === null
  const stale = grants.filter((g) => nothing || !members.includes(g.fields.memberId))
  // Epochs only go up, whatever happened before: a share is never deleted, and a first one starts
  // past every grant left over, so no repo storage key anyone ever held opens a later share.
  const highest = Math.max(-1, ...grants.map((g) => g.fields.epoch))
  const at = existing === null ? highest + 1 : Math.max(existing.fields.epoch, highest)
  let current: unknown = null
  if (existing !== null && existing.fields.keyId === ctx.keyId) {
    const rsk = await repoStorageKey(ctx.E, repo, network, existing.fields.epoch)
    try {
      current = await openShare(rsk, { network, repoId: repo }, existing.fields).catch(() => null)
    } finally {
      rsk.fill(0)
    }
  }
  const shownNothing = existing === null || shareMeaning(current) === shareMeaning(NOTHING_SHARED)
  if (nothing) {
    // Stop sharing: the nothing share at the next epoch (unless it is already there), every grant revoked.
    if (!shownNothing || (existing === null && grants.length > 0)) {
      const epoch = existing === null ? at : at + 1
      await writeShare(ctx, p.repoId, repo, epoch, NOTHING_SHARED, existing)
    }
    for (const g of grants) await ctx.port.deleteGrant(g)
    return { granted: [], waiting: [], shared: existing !== null, epoch: existing === null && grants.length === 0 ? null : at }
  }
  // A grant to anyone not a maintainer now (removed here, or found stale), or sharing again after a
  // stop, or a grant past the share: the next epoch.
  const bump = existing !== null && (stale.length > 0 || shownNothing || highest > existing.fields.epoch)
  const epoch = bump ? at + 1 : at
  if (epoch > 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
  const rsk = await repoStorageKey(ctx.E, repo, network, epoch)
  try {
    const same = !bump && existing !== null && existing.fields.epoch === epoch && current !== null && shareMeaning(current) === shareMeaning(plain)
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

async function writeShare(ctx: OwnerContext, repoId: string, repo: Uint8Array, epoch: number, plain: SharePlain, existing: Awaited<ReturnType<UserSyncPort['readShare']>>): Promise<void> {
  if (epoch > 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
  const rsk = await repoStorageKey(ctx.E, repo, ctx.networkKey, epoch)
  try {
    await ctx.port.writeShare(repoId, await sealShare(rsk, { network: ctx.networkKey, repoId: repo, epoch, keyId: ctx.keyId }, plain), existing)
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
  const grant = await ctx.port.grantFor(p.repoOwnerId, p.repoId, ctx.memberId)
  if (grant === null || grant.ownerId !== p.repoOwnerId || grant.fields.memberId !== ctx.memberId || grant.fields.recipientKeyId !== ctx.keyId) return null
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
    // The nothing share: the owner stopped sharing.
    if (plain['policy'] === null || plain['policy'] === undefined) return null
    const policy = policySchema.safeParse(plain['policy'])
    if (!policy.success) return null
    const profiles = Object.entries(plain['profiles'] as Record<string, unknown>).flatMap(([name, v]) => profileOf(name, v) ?? [])
    // Platform needs no profile (dg's shares name it without one).
    if (!policy.data.targets.every((t) => t === PLATFORM_PROFILE || profiles.some((x) => x.name === t))) return null
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
  if (granted.policy.targets.includes(PLATFORM_PROFILE) && !own.has(PLATFORM_PROFILE) && !added.some((p) => p.name === PLATFORM_PROFILE)) {
    added.push({ name: PLATFORM_PROFILE, settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as StorageProfile)
  }
  const profiles = [...config.profiles.filter((p) => !added.some((a) => a.name === p.name)), ...added]
  const policy: StoragePolicy = { ...granted.policy, targets: granted.policy.targets.map(sharedName) }
  return { ...config, profiles, repoPolicies: { ...config.repoPolicies, [repoId]: policy } }
}
