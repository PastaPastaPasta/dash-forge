/**
 * Maintainers use the owner's storage (docs/design/identity-synced-state.md §5): the owner writes
 * the repo's `share` (the profiles its storage policy names, under the repo storage key) and one
 * `grant` per current maintainer with a forge-user key (that key, wrapped to them). A removal moves
 * to the next epoch, re-encrypts the share, rewrites the remaining grants, and deletes the removed
 * member's. A maintainer reads its grant, accepts it only from the repo's owner, and uses the
 * profiles for pushes to that repo alone.
 */

import { decodeIdentifier } from '../auth/base58'
import { PLATFORM_PROFILE, policySchema, validProfileName, type StoragePolicy, type StorageProfile } from '../storage/profiles'
import type { StorageConfig } from '../storage/store'
import { WRAPPED_BYTES, canonicalJson, openShare, repoStorageKey, sealShare, unwrapGrant, wrapGrant, type GrantParams } from './crypto'
import type { GrantFields, SyncPublicKey, UserSyncPort } from './platform'
import { profileOf } from './storage-slot'

export const SHARE_FORMAT = 'forge-user/share'

/** A policy in a share: the synced `{targets, replicas, platformFallback}`, and whatever else it carries. */
export interface SharedPolicy {
  readonly targets: readonly string[]
  readonly [field: string]: unknown
}

export interface SharePlain {
  readonly format: typeof SHARE_FORMAT
  readonly version: 1
  readonly profiles: Readonly<Record<string, { readonly settings: unknown; readonly secrets: unknown }>>
  /** The synced policy as it is, its targets as shared; null: nothing is shared (Platform only). */
  readonly policy: SharedPolicy | null
}

/** The share that shares nothing: what stopping writes, at the next epoch. */
export const NOTHING_SHARED: SharePlain = { format: SHARE_FORMAT, version: 1, profiles: {}, policy: null }

/** What a repository's share should hold: as it is (keep), nothing (stop sharing), or this. */
/** Why nothing is shared: the repo has no storage of its own (`repo:<id>`), or it stores on Platform only. */
export type NothingReason = 'no-repo-policy' | 'platform-only'

/**
 * The owner's line for a pass that stopped sharing a repo with no storage of its own (forge-core
 * `stopped_line`): `default` when it never had any (a share made from the default storage before
 * repo-only sharing), `removed` when the owner removed it.
 */
export type StopLine = 'default' | 'removed'

export type ShareRule = { readonly kind: 'keep' } | { readonly kind: 'nothing'; readonly reason: NothingReason } | { readonly kind: 'content'; readonly plain: SharePlain }

const KEEP: ShareRule = { kind: 'keep' }

/** A synced policy as both clients read it (dg `policy_from_synced`): `replicas` null when it names none, else 1 to 8. */
export interface SyncedPolicy {
  readonly targets: readonly string[]
  readonly replicas: number | null
  readonly platformFallback: boolean
}

export function syncedPolicy(v: unknown): SyncedPolicy | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const targets = r['targets']
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string' && validProfileName(t))) return null
  const replicas = r['replicas']
  if (replicas !== undefined && replicas !== null && !(typeof replicas === 'number' && Number.isInteger(replicas) && replicas >= 1 && replicas <= 8)) return null
  return { targets: targets as string[], replicas: typeof replicas === 'number' ? replicas : null, platformFallback: r['platformFallback'] === true }
}

function httpUrl(v: unknown): URL | null {
  if (typeof v !== 'string') return null
  try {
    const u = new URL(v)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' && u.username === '' && u.password === '' && u.search === '' && u.hash === '' ? u : null
  } catch {
    return null
  }
}

const httpOrigin = (v: unknown): boolean => httpUrl(v) !== null

/** dg's `S3Config::validate` over a synced s3 profile's settings. */
function s3Valid(o: Record<string, unknown>): boolean {
  const url = httpUrl(o['endpoint'])
  const bucket = o['bucket']
  if (url === null || (url.pathname !== '/' && url.pathname !== '') || typeof bucket !== 'string' || !/^[a-z0-9._-]+$/.test(bucket)) return false
  const pathStyle = typeof o['pathStyle'] === 'boolean' ? o['pathStyle'] : true
  const ipHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith('[')
  if (!pathStyle && (ipHost || (bucket.includes('.') && url.protocol === 'https:'))) return false
  const prefix = typeof o['prefix'] === 'string' ? o['prefix'] : ''
  return prefix === '' || prefix.replace(/\/+$/, '').split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const filled = (o: Record<string, unknown>, k: string): boolean => typeof o[k] === 'string' && o[k] !== ''
const optionalOrigin = (o: Record<string, unknown>, k: string): boolean => !filled(o, k) || httpOrigin(o[k])

/**
 * What a synced profile value is to the share rule, read as dg reads it (`profile_from_synced`,
 * then `validate`): `platform`, `storage`, or null when it does not read (an unknown kind too).
 */
export function syncedProfileKind(v: unknown): 'platform' | 'storage' | null {
  if (typeof v !== 'object' || v === null) return null
  const settings = (v as Record<string, unknown>)['settings']
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  const o = settings as Record<string, unknown>
  const rawSecrets = (v as Record<string, unknown>)['secrets']
  const secrets = (typeof rawSecrets === 'object' && rawSecrets !== null ? rawSecrets : {}) as Record<string, unknown>
  switch (o['kind']) {
    case 'platform':
      return 'platform'
    case 's3':
      if (!s3Valid(o)) return null
      if (filled(secrets, 'accessKeyId') !== filled(secrets, 'secretAccessKey')) return null
      if (filled(secrets, 'sessionToken') && !filled(secrets, 'secretAccessKey')) return null
      return 'storage'
    case 'ipfs-kubo':
      return httpOrigin(o['api']) && optionalOrigin(o, 'gateway') && optionalOrigin(o, 'publicGateway') ? 'storage' : null
    case 'ipfs-pinning-service':
      return httpOrigin(o['api']) && httpOrigin(o['pinningEndpoint']) && filled(secrets, 'pinningToken') && optionalOrigin(o, 'gateway') && optionalOrigin(o, 'publicGateway') ? 'storage' : null
    default:
      return null
  }
}

/**
 * What the owner shares for `repoId`, by the rule dg follows too (forge-core `ShareRule::of`), over
 * the owner's synced storage slot (`view`: its live entries; null when it was not read): only the
 * storage set for this repo, its `repo:<id>` policy, and the synced profiles it names, as they are
 * synced (a platform-kind profile is the `platform` target). Never the default or any other
 * account-wide storage: no `repo:<id>` entry (or a tombstoned one) is nothing. A `repo:<id>` entry
 * that does not parse, or one naming a profile that is not synced or does not read: keep the share
 * as it is (never a partial set). A policy naming only Platform: nothing.
 */
export function shareRule(view: Readonly<Record<string, unknown>> | null, repoId: string): ShareRule {
  if (view === null) return KEEP
  const repoKey = `repo:${repoId}`
  if (!Object.hasOwn(view, repoKey)) return { kind: 'nothing', reason: 'no-repo-policy' }
  const raw = view[repoKey]
  const policy = syncedPolicy(raw)
  if (policy === null) return KEEP
  const profiles: Record<string, { readonly settings: unknown; readonly secrets: unknown }> = {}
  const targets: string[] = []
  for (const name of policy.targets) {
    if (name === PLATFORM_PROFILE) {
      targets.push(name)
      continue
    }
    const key = `profile:${name}`
    if (!Object.hasOwn(view, key)) return KEEP
    const kind = syncedProfileKind(view[key])
    if (kind === null) return KEEP
    if (kind === 'platform') targets.push(PLATFORM_PROFILE)
    else {
      profiles[name] = view[key] as { settings: unknown; secrets: unknown }
      targets.push(name)
    }
  }
  if (Object.keys(profiles).length === 0) return { kind: 'nothing', reason: 'platform-only' }
  return { kind: 'content', plain: { format: SHARE_FORMAT, version: 1, profiles, policy: { ...(raw as object), targets } } }
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
  const policy = r['policy'] === null || r['policy'] === undefined ? null : syncedPolicy(r['policy'])
  return canonicalJson({ profiles, policy })
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
  /** This pass stopped sharing (wrote the nothing share or revoked grants) for want of repo storage: the owner's line. */
  readonly stopped?: StopLine
}

/**
 * Bring `repoId`'s share and grants in line with the owner's effective storage config and the
 * repo's current maintainers. A grant to anyone else (`removed`, or found stale) moves to the next
 * epoch first. Writes only what differs.
 */
export async function reconcileRepoShare(ctx: OwnerContext, p: ReconcileInput): Promise<Reconciled> {
  const done = await reconcileOnce(ctx, p)
  // Another tab or device may have granted meanwhile (a stale maintainer list): a grant to anyone
  // not a maintainer now, or past this epoch, is revoked by one more pass, at the next epoch.
  const removed = new Set(p.removed ?? [])
  const members = new Set(p.maintainers.filter((m) => m !== ctx.ownerId && !removed.has(m)))
  const after = (await ctx.port.grantsOf(ctx.ownerId, p.repoId)).filter((g) => g.ownerId === ctx.ownerId)
  const unexpected = after.some((g) => !members.has(g.fields.memberId) || (done.epoch !== null && g.fields.epoch > done.epoch))
  if (!unexpected) return done
  const again = await reconcileOnce(ctx, p)
  return done.stopped !== undefined ? { ...again, stopped: done.stopped } : again
}

type ReconcileInput = {
  readonly repoId: string
  readonly view: Readonly<Record<string, unknown>> | null
  readonly maintainers: readonly string[]
  readonly removed?: readonly string[]
  /** The owner removed this repo's storage (its synced `repo:<id>` entry is a tombstone). */
  readonly repoPolicyRemoved?: boolean
}

async function reconcileOnce(ctx: OwnerContext, p: ReconcileInput): Promise<Reconciled> {
  const network = ctx.networkKey
  const repo = decodeIdentifier(p.repoId)
  const removed = new Set(p.removed ?? [])
  const members = [...new Set(p.maintainers)].filter((m) => m !== ctx.ownerId && !removed.has(m)).sort()
  const grants = (await ctx.port.grantsOf(ctx.ownerId, p.repoId)).filter((g) => g.ownerId === ctx.ownerId)
  const existing = await ctx.port.readShare(ctx.ownerId, p.repoId)
  const rule = shareRule(p.view, p.repoId)
  const stop = rule.kind === 'nothing'
  // Each maintainer's live forge-user keys, oldest first (none needed when sharing stops).
  const keys = new Map<string, readonly SyncPublicKey[]>()
  if (!stop) for (const m of members) keys.set(m, await ctx.port.syncKeys(m))
  const newest = (m: string): SyncPublicKey | undefined => keys.get(m)?.at(-1)
  // A grant to a key that is not the member's newest moves the share on: the key it went to keeps
  // that epoch's repo key, so a rotated-out key never opens what is shared after.
  const rekeyed = grants.some((g) => {
    const key = newest(g.fields.memberId)
    return key !== undefined && key.keyId !== g.fields.recipientKeyId
  })
  // Revoked: every grant when sharing stops; else one to anyone not a maintainer now, or to a key no longer live.
  const revoked = grants.filter((g) => stop || !(keys.get(g.fields.memberId) ?? []).some((k) => k.keyId === g.fields.recipientKeyId))
  let opened: SharePlain | null = null
  if (existing !== null && existing.fields.keyId === ctx.keyId) {
    const rsk = await repoStorageKey(ctx.E, repo, network, existing.fields.epoch)
    try {
      const plain: unknown = await openShare(rsk, { network, repoId: repo }, existing.fields).catch(() => null)
      opened = shareMeaning(plain) === null ? null : (plain as SharePlain)
    } finally {
      rsk.fill(0)
    }
  }
  const lent = (s: SharePlain | null): boolean => s !== null && Object.keys(s.profiles).length > 0
  // Stopping a share that lends storage, or one that does not open here.
  const stopping = stop && (opened === null || lent(opened))
  // Epochs only go up: a share is never deleted, and a new one starts past every grant left over,
  // so no repo storage key anyone ever held opens a later share. Also past a grant ahead of the share.
  const highest = grants.length === 0 ? null : Math.max(...grants.map((g) => g.fields.epoch))
  const ahead = existing !== null && highest !== null && highest > existing.fields.epoch
  const bump = revoked.length > 0 || stopping || rekeyed || ahead
  const epoch = existing !== null ? (bump ? Math.max(existing.fields.epoch, highest ?? 0) + 1 : existing.fields.epoch) : highest !== null ? highest + 1 : 0
  if (epoch > 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
  // Keep: what the share holds now, as it is (an empty one stays empty, its grants left as they are).
  // Stopping, or revoking with nothing to re-encrypt: the empty share at the new epoch, written
  // before any grant goes (it keeps the epoch from going back).
  const content: SharePlain | null =
    rule.kind === 'content' ? rule.plain : rule.kind === 'keep' && opened !== null ? opened : (existing !== null || grants.length > 0) && (stop || revoked.length > 0) ? NOTHING_SHARED : null
  let written = false
  if (content !== null) {
    const same = existing !== null && existing.fields.epoch === epoch && existing.fields.keyId === ctx.keyId && opened !== null && shareMeaning(opened) === shareMeaning(content)
    if (!same) {
      await writeShare(ctx, p.repoId, repo, epoch, content, existing)
      written = true
    }
  }
  const lends = !stop && lent(content)
  const granted: string[] = []
  const waiting: string[] = []
  // Grants rewritten in place (to a member's newer key): replaced, not deleted.
  const replaced = new Set<string>()
  if (lends) {
    const rsk = await repoStorageKey(ctx.E, repo, network, epoch)
    try {
      for (const member of members) {
        const own = grants.find((g) => g.fields.memberId === member) ?? null
        // A share kept as it is (no usable repo setting) may hold what an older build shared from
        // the default storage: it is never lent to anyone new, only refreshed for those who hold it.
        if (rule.kind === 'keep' && own === null) continue
        const key = newest(member)
        if (key === undefined) {
          waiting.push(member)
          continue
        }
        // An envelope of another size (a later format) is rewritten in this one.
        if (own !== null && own.fields.epoch === epoch && own.fields.senderKeyId === ctx.keyId && own.fields.recipientKeyId === key.keyId && own.fields.wrapped.length === WRAPPED_BYTES) {
          granted.push(member)
          continue
        }
        const params: GrantParams = { network, ownerId: decodeIdentifier(ctx.ownerId), repoId: repo, memberId: decodeIdentifier(member), epoch, senderKeyId: ctx.keyId, recipientKeyId: key.keyId }
        const fields: GrantFields = { repoId: p.repoId, memberId: member, epoch, senderKeyId: ctx.keyId, recipientKeyId: key.keyId, wrapped: await wrapGrant(ctx.E, key.pub, params, rsk) }
        await ctx.port.writeGrant(fields, own)
        if (own !== null) replaced.add(own.id)
        granted.push(member)
      }
    } finally {
      rsk.fill(0)
    }
  }
  let deleted = 0
  for (const g of revoked) {
    if (replaced.has(g.id)) continue
    await ctx.port.deleteGrant(g)
    deleted++
  }
  // Said once, as the share is empty after; not for Platform-only storage the owner did set.
  const stopped = rule.kind === 'nothing' && rule.reason === 'no-repo-policy' && (written || deleted > 0) ? { stopped: p.repoPolicyRemoved === true ? ('removed' as const) : ('default' as const) } : {}
  return { granted, waiting, shared: lends || existing !== null, epoch: written ? epoch : (existing?.fields.epoch ?? null), ...stopped }
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
    const read = syncedPolicy(plain['policy'])
    if (read === null) return null
    // Each destination once, and no more copies than destinations (a share may list Platform twice).
    const targets = [...new Set(read.targets)]
    const replicas = Math.min(Math.max(read.replicas ?? targets.length, 1), targets.length)
    const policy = policySchema.safeParse({ targets, replicas, platformFallback: read.platformFallback })
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
  // Each shared profile under a name of its own: never one of the maintainer's (they keep theirs).
  const taken = new Set(own)
  const names = new Map<string, string>()
  const added: StorageProfile[] = []
  for (const p of granted.profiles) {
    if (p.name === PLATFORM_PROFILE) continue
    const base = sharedName(p.name)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}-${i}`
    taken.add(name)
    names.set(p.name, name)
    added.push({ ...p, name } as StorageProfile)
  }
  if (granted.policy.targets.includes(PLATFORM_PROFILE) && !own.has(PLATFORM_PROFILE)) {
    added.push({ name: PLATFORM_PROFILE, settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as StorageProfile)
  }
  const profiles = [...config.profiles, ...added]
  const policy: StoragePolicy = { ...granted.policy, targets: granted.policy.targets.map((t) => (t === PLATFORM_PROFILE ? t : (names.get(t) ?? sharedName(t)))) }
  return { ...config, profiles, repoPolicies: { ...config.repoPolicies, [repoId]: policy } }
}
