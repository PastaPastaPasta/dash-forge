/**
 * Moving settings sync to a new key (#751): a wallet sign-in hands the app the identity's
 * forge-user key, so a lookalike site that got one approval keeps it. The recovery phrase makes
 * every rotation of that key (DIP-15, the wallets' path), so the owner can register the next one
 * and leave the old one behind:
 *
 * 1. The identity's current forge-user key (its newest live one) must be one the phrase makes.
 * 2. Unless an earlier move was cut short (the current key is rotation 1 or above and the newest
 *    rotation the phrase makes, and some `state`, `share` or `grant` still names an older key, this
 *    device holds an older one, or this device registered it), one master-key IdentityUpdate adds the next rotation and disables every live key the
 *    phrase makes. A legacy key (the wallets' path with no rotation level) counts as below rotation 0.
 * 3. Every `state` slot is sealed again under the new key, its plaintext byte for byte.
 *    A `storage` or `prefs` slot the identity lacks is started empty under the new key (one an old
 *    client started meanwhile, under the old key, is sealed again instead).
 * 4. Every `share` moves to a new epoch under the new key, content unchanged; then its grants are
 *    written again from the new key (a grant to a key no longer live, to someone no longer a
 *    maintainer, or behind the share's epoch goes, as in a reconcile).
 * 5. The new key becomes this device's sync key.
 *
 * Any step that fails leaves a state the same move carries on from. {@link addSyncKey} gives
 * another device the current key from the phrase.
 */

import { decodeIdentifier } from '../auth/base58'
import { WRAPPED_BYTES, canonicalJson, openShareBytes, openState, sealState, openStateBytes, repoStorageKey, sealShareBytes, sealStateBytes, wrapGrant, type GrantParams, type ShareFields } from './crypto'
import type { GrantFields, IdentitySyncKey, IdentitySyncKeys, Stored, UserSyncPort } from './platform'
import { emptyDoc } from './lww'
import { SyncReadBackError } from './service'

/** The identity has no live forge-user key: there is nothing to move or add. */
export class SyncNotSetUpError extends Error {
  constructor() {
    super("This identity doesn't sync yet.")
    this.name = 'SyncNotSetUpError'
  }
}

/** The recovery phrase does not make the identity's current forge-user key: nothing was written. */
export class WrongSyncPhraseError extends Error {
  constructor() {
    super("This recovery phrase doesn't make this identity's sync key.")
    this.name = 'WrongSyncPhraseError'
  }
}

/** A key the identity has from the phrase: its rotation ({@link LEGACY_ROTATION} for the legacy path) and private key (wiped by the move). */
interface Held {
  readonly rotation: number
  readonly secret: Uint8Array
}

/**
 * A forge-user key made from the recovery phrase at `rotation`, or at the wallets' legacy path
 * with no rotation level (keys registered before rotations; the caller derives it, it is wiped after use).
 */
export type DeriveSyncKey = (rotation: number | 'legacy') => Promise<{ readonly secret: Uint8Array; readonly pub: Uint8Array }>

/** Where a legacy key sorts among rotations: below 0, so a move from one goes to rotation 1 (0 is what wallets hand out). */
const LEGACY_ROTATION = -1

/** The master-key IdentityUpdate: add `add` as a forge-user ENCRYPTION key and disable every key in `disable`, in one transition. */
export type ReplaceSyncKey = (add: { readonly keyId: number; readonly secret: Uint8Array; readonly pub: Uint8Array }, disable: readonly number[]) => Promise<void>

export interface KeyPhraseContext {
  readonly port: UserSyncPort
  readonly networkKey: string
  readonly identityId: string
  readonly derive: DeriveSyncKey
  /** Keep the key as this device's sync key (the vault entry); the caller does not keep `secret`. */
  readonly store: (keyId: number, secret: Uint8Array) => Promise<void>
}

export interface MoveContext extends KeyPhraseContext {
  readonly replace: ReplaceSyncKey
  /** The repository's current maintainers (none for a repository that no longer exists): who its grants may go to. */
  readonly maintainers: (repoId: string) => Promise<readonly string[]>
  /** The sync key id this device holds, if any: one that is not the current key means a move here stopped part-way. */
  readonly held?: number | null
  /**
   * The key a move from this device registered and has not finished (kept outside the vault: an
   * id and a public key only), so a retry after a lost answer finishes it instead of adding another.
   */
  readonly pending?: { get(): { readonly keyId: number; readonly pub: Uint8Array } | null; set(key: { readonly keyId: number; readonly pub: Uint8Array } | null): void }
  /** Waits between reads of the identity while a node catches up with the update. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface MoveOutcome {
  /** The key sync uses now. */
  readonly keyId: number
  /** Whether this run registered it (false: it finished an earlier move). */
  readonly created: boolean
  readonly slots: number
  readonly shares: number
  /** Guarded slots the identity lacked, started empty under the new key. */
  readonly startedSlots: readonly string[]
  /** Settings, shares and grants this run wrote (0 with `created` false: sync already used the newest key). */
  readonly written: number
}

/** Slots a move starts (empty) when the identity has none: storage and display preferences. */
export const GUARDED_SLOTS = ['storage', 'prefs'] as const

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

async function identityKeys(port: UserSyncPort, identityId: string): Promise<IdentitySyncKeys> {
  const read = await port.identitySyncKeys(identityId)
  if (read === null) throw new SyncNotSetUpError()
  return read
}

function currentOf(keys: readonly IdentitySyncKey[]): IdentitySyncKey {
  const live = keys.filter((k) => !k.disabled)
  const current = live.reduce<IdentitySyncKey | null>((a, k) => (a === null || k.keyId > a.keyId ? k : a), null)
  if (current === null) throw new SyncNotSetUpError()
  return current
}

/**
 * The phrase's legacy key and rotations 0..n (n: the identity's forge-user keys plus two, at least
 * four) matched to the identity's keys; what matches nothing is wiped at once.
 */
async function matchRotations(derive: DeriveSyncKey, keys: readonly IdentitySyncKey[], held: Map<number, Held>): Promise<void> {
  const n = Math.max(keys.length + 2, 4)
  for (let rotation = LEGACY_ROTATION; rotation <= n; rotation++) {
    const { secret, pub } = await derive(rotation === LEGACY_ROTATION ? 'legacy' : rotation)
    const matches = keys.filter((k) => same(k.pub, pub) && !held.has(k.keyId))
    if (matches.length === 0) {
      secret.fill(0)
      continue
    }
    matches.forEach((k, i) => held.set(k.keyId, { rotation, secret: i === 0 ? secret : secret.slice() }))
  }
}

function wipe(held: Map<number, Held>): void {
  for (const h of held.values()) h.secret.fill(0)
  held.clear()
}

/** The key the identity's current forge-user key is, from the phrase ({@link WrongSyncPhraseError} when it is none of them). */
async function phraseKeys(ctx: KeyPhraseContext): Promise<{ readonly read: IdentitySyncKeys; readonly current: IdentitySyncKey; readonly held: Map<number, Held> }> {
  const read = await identityKeys(ctx.port, ctx.identityId)
  const current = currentOf(read.keys)
  const held = new Map<number, Held>()
  try {
    await matchRotations(ctx.derive, read.keys, held)
  } catch (e) {
    wipe(held)
    throw e
  }
  if (!held.has(current.keyId)) {
    wipe(held)
    throw new WrongSyncPhraseError()
  }
  return { read, current, held }
}

/**
 * B': keep the identity's current forge-user key, made from the recovery phrase, as this
 * device's sync key. Nothing is written to Platform.
 */
export async function addSyncKey(ctx: KeyPhraseContext): Promise<{ readonly keyId: number }> {
  const { current, held } = await phraseKeys(ctx)
  try {
    await ctx.store(current.keyId, held.get(current.keyId)!.secret.slice())
    return { keyId: current.keyId }
  } finally {
    wipe(held)
  }
}

/** Re-read the identity until it shows `keyId` live with `pub` (a node a block behind does not yet). */
async function awaitKey(ctx: MoveContext, keyId: number, pub: Uint8Array): Promise<void> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; ; i++) {
    const keys = (await ctx.port.identitySyncKeys(ctx.identityId))?.keys ?? []
    const current = keys.filter((k) => !k.disabled).at(-1)
    if (current?.keyId === keyId && same(current.pub, pub)) return
    if (i >= 6) throw new Error("Your new sync key is registered, but Platform doesn't show it yet. Try again in a minute: the move carries on from here.")
    await sleep(1500)
  }
}

/** Move sync to a new key (see the module comment). */
export async function moveSyncKey(ctx: MoveContext): Promise<MoveOutcome> {
  const { read, current, held } = await phraseKeys(ctx)
  try {
    const identity = decodeIdentifier(ctx.identityId)
    const network = ctx.networkKey
    const states = await ctx.port.statesOf(ctx.identityId)
    const shares = await ctx.port.sharesOf(ctx.identityId)
    const grants = new Map<string, Stored<GrantFields>[]>()
    for (const { repoId } of shares) grants.set(repoId, (await ctx.port.grantsOf(ctx.identityId, repoId)).filter((g) => g.ownerId === ctx.identityId))
    // Everything sealed must open with a key the phrase makes, before anything is written.
    for (const keyId of [...states.map((s) => s.fields.keyId), ...shares.map((s) => s.share.fields.keyId)]) {
      if (!held.has(keyId)) throw new Error(`Some of your synced settings are sealed with key ${keyId}, which this recovery phrase doesn't make. Nothing was changed.`)
    }
    const behind =
      states.some((s) => s.fields.keyId !== current.keyId) || shares.some((s) => s.share.fields.keyId !== current.keyId) || [...grants.values()].flat().some((g) => g.fields.senderKeyId !== current.keyId)
    // A resume only when the current key is the newest rotation the phrase makes: a key added back
    // later under an older rotation (one a site may have kept) is never what sync moves to.
    // Never onto rotation 0 (what wallets hand out at sign-in) or a legacy key: a move never registers those.
    const highest = Math.max(...[...held.values()].map((h) => h.rotation))
    const currentRotation = held.get(current.keyId)!.rotation
    const newest = currentRotation >= 1 && currentRotation === highest
    const heldOther = ctx.held !== undefined && ctx.held !== null && ctx.held !== current.keyId
    const pending = ctx.pending?.get() ?? null
    const registeredHere = pending !== null && same(pending.pub, current.pub)
    const interrupted = newest && (behind || heldOther || registeredHere)
    // Everything that moves must open, and every share's epoch must be able to advance, before the
    // old keys are disabled: a run that would stop on them never starts.
    const moving = (keyId: number): boolean => !interrupted || keyId !== current.keyId
    const plains = new Map<string, Uint8Array>()
    for (const s of states) {
      if (!moving(s.fields.keyId)) continue
      plains.set(`state/${s.fields.slot}`, await openStateBytes({ E: held.get(s.fields.keyId)!.secret, keyId: s.fields.keyId, identityId: identity, network }, s.fields))
    }
    for (const { repoId, share } of shares) {
      if (!moving(share.fields.keyId)) continue
      const rsk = await repoStorageKey(held.get(share.fields.keyId)!.secret, decodeIdentifier(repoId), network, share.fields.epoch)
      try {
        plains.set(`share/${repoId}`, await openShareBytes(rsk, { network, repoId: decodeIdentifier(repoId) }, share.fields))
      } finally {
        rsk.fill(0)
      }
      if (Math.max(share.fields.epoch, ...(grants.get(repoId) ?? []).map((g) => g.fields.epoch)) >= 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
    }
    const maintainers = new Map<string, ReadonlySet<string>>()
    for (const { repoId } of shares) maintainers.set(repoId, new Set(await ctx.maintainers(repoId)))
    let target: { readonly keyId: number; readonly secret: Uint8Array } = { keyId: current.keyId, secret: held.get(current.keyId)!.secret }
    if (!interrupted) {
      const rotation = Math.max(highest, 0) + 1
      const next = await ctx.derive(rotation)
      if (read.keys.some((k) => same(k.pub, next.pub))) {
        next.secret.fill(0)
        throw new Error(`This identity already has the sync key a move would add (rotation ${rotation}). Nothing was changed.`)
      }
      const keyId = read.maxKeyId + 1
      held.set(keyId, { rotation, secret: next.secret })
      const disable = read.keys.filter((k) => !k.disabled && held.has(k.keyId)).map((k) => k.keyId)
      ctx.pending?.set({ keyId, pub: next.pub })
      await ctx.replace({ keyId, secret: next.secret, pub: next.pub }, disable)
      await awaitKey(ctx, keyId, next.pub)
      target = { keyId, secret: next.secret }
    }
    let written = 0
    for (const s of states) {
      if (s.fields.keyId === target.keyId) continue
      const from = { E: held.get(s.fields.keyId)!.secret, keyId: s.fields.keyId, identityId: identity, network }
      const to = { E: target.secret, keyId: target.keyId, identityId: identity, network }
      const plain = plains.get(`state/${s.fields.slot}`) ?? (await openStateBytes(from, s.fields))
      await ctx.port.writeState(await sealStateBytes(to, s.fields.slot, plain), s)
      const back = await ctx.port.readState(ctx.identityId, s.fields.slot)
      if (back === null || back.fields.keyId !== target.keyId || !same(await openStateBytes(to, back.fields), plain)) throw new SyncReadBackError(s.fields.slot)
      written++
    }
    // A slot the identity lacks is started empty under the new key: a client holding the old key
    // finds it sealed under another key and never starts it under the old one (forge-core `GUARDED_SLOTS`).
    const created: string[] = []
    for (const slot of GUARDED_SLOTS) {
      if (states.some((s) => s.fields.slot === slot)) continue
      const to = { E: target.secret, keyId: target.keyId, identityId: identity, network }
      // One an old-key client started after the listing, before the update disabled its key: sealed again.
      const late = await ctx.port.readState(ctx.identityId, slot)
      if (late !== null) {
        if (late.fields.keyId === target.keyId) continue
        const from = held.get(late.fields.keyId)
        if (from === undefined) throw new Error(`Some of your synced settings are sealed with key ${late.fields.keyId}, which this recovery phrase doesn't make.`)
        const plain = await openStateBytes({ E: from.secret, keyId: late.fields.keyId, identityId: identity, network }, late.fields)
        await ctx.port.writeState(await sealStateBytes(to, slot, plain), late)
        const back = await ctx.port.readState(ctx.identityId, slot)
        if (back === null || back.fields.keyId !== target.keyId || !same(await openStateBytes(to, back.fields), plain)) throw new SyncReadBackError(slot)
        written++
        continue
      }
      const empty = emptyDoc(slot)
      await ctx.port.writeState(await sealState(to, slot, empty), null)
      const back = await ctx.port.readState(ctx.identityId, slot)
      if (back === null || back.fields.keyId !== target.keyId || canonicalJson(await openState(to, back.fields)) !== canonicalJson(empty)) throw new SyncReadBackError(slot)
      created.push(slot)
      written++
    }
    for (const { repoId, share } of shares) written += await moveShare(ctx, repoId, share, grants.get(repoId) ?? [], target, held, maintainers.get(repoId)!, plains.get(`share/${repoId}`))
    await ctx.store(target.keyId, target.secret.slice())
    ctx.pending?.set(null)
    return { keyId: target.keyId, created: !interrupted, slots: states.length, shares: shares.length, startedSlots: created, written }
  } finally {
    wipe(held)
  }
}

/**
 * One share: at a new epoch past every grant's (unless an earlier run already moved it), under the
 * new key, content unchanged; then its grants from the new key; a grant to a key no longer live last.
 * A grant to someone no longer a maintainer, or behind the share's epoch (one a removal that stopped
 * part-way left: it no longer opens the share), is deleted first, before the share moves, so a retry
 * never mistakes it for a current one.
 * Returns how many writes it made.
 */
async function moveShare(
  ctx: MoveContext,
  repoId: string,
  share: Stored<ShareFields>,
  grants: readonly Stored<GrantFields>[],
  target: { readonly keyId: number; readonly secret: Uint8Array },
  held: ReadonlyMap<number, Held>,
  maintainers: ReadonlySet<string>,
  opened?: Uint8Array,
): Promise<number> {
  let written = 0
  const network = ctx.networkKey
  const repo = decodeIdentifier(repoId)
  let epoch = share.fields.epoch
  const moving = share.fields.keyId !== target.keyId
  // As a reconcile would, before the share moves (and on a resume): a grant to someone no longer a
  // maintainer, or below the share's epoch, is deleted, so no retry lends the new share to it.
  const stale = grants.filter((g) => !maintainers.has(g.fields.memberId) || g.fields.memberId === ctx.identityId || (moving && g.fields.epoch < share.fields.epoch))
  for (const g of stale) await ctx.port.deleteGrant(g)
  written += stale.length
  grants = grants.filter((g) => !stale.includes(g))
  if (moving) {
    let plain: Uint8Array
    if (opened !== undefined) plain = opened
    else {
      const from = await repoStorageKey(held.get(share.fields.keyId)!.secret, repo, network, share.fields.epoch)
      try {
        plain = await openShareBytes(from, { network, repoId: repo }, share.fields)
      } finally {
        from.fill(0)
      }
    }
    epoch = Math.max(share.fields.epoch, ...grants.map((g) => g.fields.epoch)) + 1
    if (epoch > 0xffffffff) throw new Error('this repository changed its storage maintainers too often to share again')
    const rsk = await repoStorageKey(target.secret, repo, network, epoch)
    try {
      await ctx.port.writeShare(repoId, await sealShareBytes(rsk, { network, repoId: repo, epoch, keyId: target.keyId }, plain), share)
      const back = await ctx.port.readShare(ctx.identityId, repoId)
      if (back === null || back.fields.keyId !== target.keyId || back.fields.epoch !== epoch || !same(await openShareBytes(rsk, { network, repoId: repo }, back.fields), plain)) {
        throw new SyncReadBackError('shared storage')
      }
      written++
    } finally {
      rsk.fill(0)
    }
  }
  const rsk = await repoStorageKey(target.secret, repo, network, epoch)
  const gone: Stored<GrantFields>[] = []
  try {
    for (const g of grants) {
      if (g.fields.epoch === epoch && g.fields.senderKeyId === target.keyId && g.fields.wrapped.length === WRAPPED_BYTES) continue
      const key = await ctx.port.syncKey(g.fields.memberId, g.fields.recipientKeyId)
      if (key === null) {
        gone.push(g)
        continue
      }
      const params: GrantParams = { network, ownerId: decodeIdentifier(ctx.identityId), repoId: repo, memberId: decodeIdentifier(g.fields.memberId), epoch, senderKeyId: target.keyId, recipientKeyId: key.keyId }
      await ctx.port.writeGrant({ ...g.fields, epoch, senderKeyId: target.keyId, wrapped: await wrapGrant(target.secret, key.pub, params, rsk) }, g)
      written++
    }
  } finally {
    rsk.fill(0)
  }
  for (const g of gone) await ctx.port.deleteGrant(g)
  return written + gone.length
}
