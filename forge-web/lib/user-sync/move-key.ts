/**
 * Moving settings sync to a new key (#751): a wallet sign-in hands the app the identity's
 * forge-user key, so a lookalike site that got one approval keeps it. The recovery phrase makes
 * every rotation of that key (DIP-15, the wallets' path), so the owner can register the next one
 * and leave the old one behind:
 *
 * 1. The identity's current forge-user key (its newest live one) must be one the phrase makes.
 * 2. Unless an earlier move was cut short (some `state`, `share` or `grant` still names an older
 *    key), one master-key IdentityUpdate adds the next rotation and disables the current key.
 * 3. Every `state` slot is sealed again under the new key, its plaintext byte for byte.
 *    A `storage` or `prefs` slot the identity lacks is started empty under the new key.
 * 4. Every `share` moves to a new epoch under the new key, content unchanged; then its grants are
 *    written again from the new key (a grant to a key no longer live goes, as in a reconcile).
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

/** A key the identity has from the phrase: its rotation and private key (wiped by the move). */
interface Held {
  readonly rotation: number
  readonly secret: Uint8Array
}

/** A forge-user key made from the recovery phrase at `rotation` (the caller derives it; it is wiped after use). */
export type DeriveSyncKey = (rotation: number) => Promise<{ readonly secret: Uint8Array; readonly pub: Uint8Array }>

/** The master-key IdentityUpdate: add `add` as a forge-user ENCRYPTION key and disable `disable`, in one transition. */
export type ReplaceSyncKey = (add: { readonly keyId: number; readonly secret: Uint8Array; readonly pub: Uint8Array }, disable: number) => Promise<void>

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
 * The phrase's rotations 0..n-1 (n: the identity's forge-user keys plus two, at least four) matched
 * to the identity's keys; what matches nothing is wiped at once.
 */
async function matchRotations(derive: DeriveSyncKey, keys: readonly IdentitySyncKey[], held: Map<number, Held>): Promise<void> {
  const n = Math.max(keys.length + 2, 4)
  for (let rotation = 0; rotation < n; rotation++) {
    const { secret, pub } = await derive(rotation)
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
    const interrupted =
      states.some((s) => s.fields.keyId !== current.keyId) || shares.some((s) => s.share.fields.keyId !== current.keyId) || [...grants.values()].flat().some((g) => g.fields.senderKeyId !== current.keyId)
    let target: { readonly keyId: number; readonly secret: Uint8Array } = { keyId: current.keyId, secret: held.get(current.keyId)!.secret }
    if (!interrupted) {
      const rotation = Math.max(...[...held.values()].map((h) => h.rotation)) + 1
      const next = await ctx.derive(rotation)
      const keyId = read.maxKeyId + 1
      held.set(keyId, { rotation, secret: next.secret })
      await ctx.replace({ keyId, secret: next.secret, pub: next.pub }, current.keyId)
      await awaitKey(ctx, keyId, next.pub)
      target = { keyId, secret: next.secret }
    }
    for (const s of states) {
      if (s.fields.keyId === target.keyId) continue
      const from = { E: held.get(s.fields.keyId)!.secret, keyId: s.fields.keyId, identityId: identity, network }
      const to = { E: target.secret, keyId: target.keyId, identityId: identity, network }
      const plain = await openStateBytes(from, s.fields)
      await ctx.port.writeState(await sealStateBytes(to, s.fields.slot, plain), s)
      const back = await ctx.port.readState(ctx.identityId, s.fields.slot)
      if (back === null || back.fields.keyId !== target.keyId || !same(await openStateBytes(to, back.fields), plain)) throw new SyncReadBackError(s.fields.slot)
    }
    // A slot the identity lacks is started empty under the new key: a client holding the old key
    // finds it sealed under another key and never starts it under the old one (forge-core `GUARDED_SLOTS`).
    const created: string[] = []
    for (const slot of GUARDED_SLOTS) {
      if (states.some((s) => s.fields.slot === slot) || (await ctx.port.readState(ctx.identityId, slot)) !== null) continue
      const to = { E: target.secret, keyId: target.keyId, identityId: identity, network }
      const empty = emptyDoc(slot)
      await ctx.port.writeState(await sealState(to, slot, empty), null)
      const back = await ctx.port.readState(ctx.identityId, slot)
      if (back === null || back.fields.keyId !== target.keyId || canonicalJson(await openState(to, back.fields)) !== canonicalJson(empty)) throw new SyncReadBackError(slot)
      created.push(slot)
    }
    for (const { repoId, share } of shares) await moveShare(ctx, repoId, share, grants.get(repoId) ?? [], target, held)
    await ctx.store(target.keyId, target.secret.slice())
    return { keyId: target.keyId, created: !interrupted, slots: states.length, shares: shares.length, startedSlots: created }
  } finally {
    wipe(held)
  }
}

/**
 * One share: at a new epoch past every grant's (unless an earlier run already moved it), under the
 * new key, content unchanged; then its grants from the new key; a grant to a key no longer live last.
 */
async function moveShare(
  ctx: MoveContext,
  repoId: string,
  share: Stored<ShareFields>,
  grants: readonly Stored<GrantFields>[],
  target: { readonly keyId: number; readonly secret: Uint8Array },
  held: ReadonlyMap<number, Held>,
): Promise<void> {
  const network = ctx.networkKey
  const repo = decodeIdentifier(repoId)
  let epoch = share.fields.epoch
  if (share.fields.keyId !== target.keyId) {
    const from = await repoStorageKey(held.get(share.fields.keyId)!.secret, repo, network, share.fields.epoch)
    let plain: Uint8Array
    try {
      plain = await openShareBytes(from, { network, repoId: repo }, share.fields)
    } finally {
      from.fill(0)
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
    }
  } finally {
    rsk.fill(0)
  }
  for (const g of gone) await ctx.port.deleteGrant(g)
}
