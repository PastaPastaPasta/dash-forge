/**
 * Settings that follow the identity (docs/design/identity-synced-state.md §5, §7): one run reads
 * the `storage` and `prefs` slots, merges them with this device's settings ({@link planSlot}),
 * writes the merged map back when something changed here, reads it back and compares, and only
 * then records the sync. Local settings gain what they lack; nothing local is changed or removed.
 */

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { decodeIdentifier } from '../auth/base58'
import type { StorageConfig } from '../storage/store'
import { canonicalJson, hkdf32, openState, sealState, type StateContext, type StateFields } from './crypto'
import { LWW_VERSION, NewerSyncFormatError, baseOf, parseDoc, planSlot, sameDoc, type LwwDoc, type PlanOptions, type SlotBase, type SlotPlan, type Tagger } from './lww'
import { prefsOwner, readRecord, store, updateRecord, type PrefsMeta, type SlotMeta, type SyncRecord } from './overlay'
import type { Stored, UserSyncPort } from './platform'
import { PREFS_PLAN, prefKeys, prefSlotEdits, prefsEntries, prefsViewRaw } from './prefs-slot'
import { carryProfileExtras, storageEntries, storageView, withAdditions } from './storage-slot'

/** This device's storage settings, as the vault keeps them. */
export interface LocalStorageConfig {
  load(): Promise<StorageConfig>
  /** Read, change and seal in one step, after any other update (`updateStorageConfig`); resolves to what is stored. */
  update(change: (current: StorageConfig) => StorageConfig | null): Promise<StorageConfig>
  /** The stored settings' sync id, made when there is none (`storageSyncId`). */
  syncId(): Promise<string>
}

export interface SyncContext {
  readonly port: UserSyncPort
  /** Forge's network key (`testnet`, `devnet-<name>`): bound into every key and AAD. */
  readonly networkKey: string
  /** The app's network (`testnet`, `mainnet`, `devnet`): the org list's key. */
  readonly network: string
  readonly identityId: string
  readonly keyId: number
  /** The forge-user encryption private key; the caller wipes it. */
  readonly E: Uint8Array
  /** `<name>-<this>` names a local profile its synced namesake replaced in the view. */
  readonly deviceId: string
  /** The storage settings, or null when this session cannot open them (they are not synced then). */
  readonly storage: LocalStorageConfig | null
  readonly localStore?: Pick<Storage, 'getItem' | 'setItem'> | null
  readonly now?: () => number
  /** Whether this identity is still the one signed in here (checked right before a shared browser key is written). */
  readonly stillActive?: () => boolean
}

export interface SyncOutcome {
  /** The effective storage config (null when the storage slot was not synced this run). */
  readonly storage: StorageConfig | null
  /** The synced storage slot's live entries (no device-local copies): what a repo's share is taken from. */
  readonly synced: Readonly<Record<string, unknown>> | null
  /** The synced storage slot's tombstoned keys (with `synced`). */
  readonly syncedRemoved?: readonly string[] | null
  readonly syncedAt: number
}

/** The synced settings were written with another key of this identity: nothing is merged or written. */
export class SyncKeyChangedError extends Error {
  constructor(readonly storedKeyId: number, readonly heldKeyId: number) {
    super(`your synced settings are sealed with key ${storedKeyId}, and this browser holds key ${heldKeyId}; sign in with your wallet again`)
    this.name = 'SyncKeyChangedError'
  }
}

/**
 * This device's sync key is no longer the identity's current one (sync moved to a new key, or the
 * key was disabled): nothing is read or written with it. The recovery phrase adds the new one.
 */
export class SyncKeyMovedError extends SyncKeyChangedError {
  constructor(readonly currentKeyId: number | null, heldKeyId: number) {
    super(currentKeyId ?? -1, heldKeyId)
    this.message = 'your synced settings moved to a new key'
    this.name = 'SyncKeyMovedError'
  }
}

/**
 * Refuse ({@link SyncKeyMovedError}) unless `keyId` is `identityId`'s current forge-user key (its
 * newest live one): a key the owner moved away from never seals settings or shares again.
 */
export async function assertCurrentSyncKey(port: UserSyncPort, identityId: string, keyId: number): Promise<void> {
  const current = await port.syncKey(identityId)
  if (current?.keyId !== keyId) throw new SyncKeyMovedError(current?.keyId ?? null, keyId)
}

/** The synced copy did not read back as written: nothing was recorded, the next run tries again. */
export class SyncReadBackError extends Error {
  constructor(slot: string) {
    super(`the synced ${slot} settings did not read back as written`)
    this.name = 'SyncReadBackError'
  }
}

/** Tags for change detection, keyed with the sync key (storage values hold credentials). */
export async function tagger(E: Uint8Array, identityId: string, networkKey: string, slot: string): Promise<Tagger> {
  const k = await hkdf32(E, decodeIdentifier(identityId), new TextEncoder().encode(`forge-user/v1/local-tag/${networkKey}/${slot}`))
  return (key, value) => bytesToHex(hmac(sha256, k, new TextEncoder().encode(`${key}\u0000${canonicalJson(value ?? null)}`))).slice(0, 32)
}

function stateCtx(ctx: SyncContext): StateContext {
  return { E: ctx.E, keyId: ctx.keyId, identityId: decodeIdentifier(ctx.identityId), network: ctx.networkKey }
}

async function readSlot(ctx: SyncContext, slot: string): Promise<{ stored: Stored<StateFields> | null; doc: LwwDoc | null }> {
  const stored = await ctx.port.readState(ctx.identityId, slot)
  if (stored === null) return { stored, doc: null }
  if (stored.fields.keyId !== ctx.keyId) {
    await assertCurrentSyncKey(ctx.port, ctx.identityId, ctx.keyId)
    throw new SyncKeyChangedError(stored.fields.keyId, ctx.keyId)
  }
  return { stored, doc: parseDoc(await openState(stateCtx(ctx), stored.fields), slot) }
}

/**
 * Merge `slot` and write it back when something changed here, then read it back and compare. One
 * retry when another device wrote in between.
 */
async function mergeSlot(
  ctx: SyncContext,
  slot: string,
  p: { readonly local: Record<string, unknown>; readonly base: SlotBase | null; readonly options: PlanOptions; readonly tag: Tagger; readonly deletions?: Readonly<Record<string, number>>; readonly edits?: Readonly<Record<string, number>>; readonly uploadLocal?: boolean },
): Promise<SlotPlan> {
  const now = ctx.now ?? Date.now
  for (let attempt = 0; ; attempt++) {
    const { stored, doc } = await readSlot(ctx, slot)
    const plan = planSlot({ slot, remote: doc, now: now(), ...p })
    if (!plan.upload) return plan
    // Never written by this build: a newer format's document is read only.
    if (plan.next.version > LWW_VERSION) throw new NewerSyncFormatError(slot, plan.next.version)
    await assertCurrentSyncKey(ctx.port, ctx.identityId, ctx.keyId)
    try {
      await ctx.port.writeState(await sealState(stateCtx(ctx), slot, plan.next), stored)
    } catch (e) {
      if (attempt === 0) continue
      throw e
    }
    const back = await readSlot(ctx, slot)
    if (back.doc === null || !sameDoc(back.doc, plan.next)) {
      if (attempt === 0) continue
      throw new SyncReadBackError(slot)
    }
    return plan
  }
}

function localStore(ctx: SyncContext): Pick<Storage, 'getItem' | 'setItem'> | null {
  return ctx.localStore !== undefined ? ctx.localStore : store()
}

function readRaw(store: Pick<Storage, 'getItem'> | null, keys: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const k of keys) {
    try {
      out[k] = store?.getItem(k) ?? null
    } catch {
      out[k] = null
    }
  }
  return out
}

/** The base a sync records: `snapshot` (what it merged) with the keys it actually added, so an edit made meanwhile still reads as a change next time. */
function baseAfter(snapshot: Record<string, unknown>, written: Record<string, unknown>, tag: Tagger, lists?: PlanOptions['lists']): SlotBase {
  const added = Object.fromEntries(Object.entries(written).filter(([k]) => !Object.hasOwn(snapshot, k)))
  return baseOf({ ...snapshot, ...added }, tag, lists)
}

async function syncStorage(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<{ config: StorageConfig; synced: Readonly<Record<string, unknown>>; removed: readonly string[]; meta: SlotMeta; deletes: Readonly<Record<string, number>>; edits: Readonly<Record<string, number>> } | null> {
  if (ctx.storage === null) return null
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'storage')
  const syncId = await ctx.storage.syncId()
  const meta = record?.storage
  // A base for another key or another blob (forgotten, discarded, re-keyed) is no base: a first sync.
  const base = meta && meta.keyId === ctx.keyId && meta.syncId === syncId ? meta.base : null
  const deletes = record?.deletes ?? {}
  const edits = record?.edits ?? {}
  const local = await ctx.storage.load()
  const snapshot = storageEntries(local)
  const plan = await mergeSlot(ctx, 'storage', { local: snapshot, base, options: { carry: carryProfileExtras }, tag, deletions: deletes, edits })
  // Additions only, to the settings as they are now (a Settings save may have landed meanwhile).
  // Only what this update itself added joins the base: a value a Settings save set meanwhile stays a change.
  let addedHere: Record<string, unknown> = {}
  const written = await ctx.storage.update((current) => {
    const next = withAdditions(current, plan.add)
    const had = storageEntries(current)
    addedHere = next === null ? {} : Object.fromEntries(Object.entries(storageEntries(next)).filter(([k]) => !Object.hasOwn(had, k) && !Object.hasOwn(snapshot, k)))
    return next
  })
  return {
    config: storageView(plan.view, plan.collisions, written, ctx.deviceId),
    synced: plan.view,
    removed: plan.removed,
    meta: { keyId: ctx.keyId, syncedAt: at, syncId, base: baseAfter(snapshot, addedHere, tag) },
    deletes,
    edits,
  }
}

async function syncPrefs(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<PrefsMeta & { readonly carried: Readonly<Record<string, number>> }> {
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'prefs')
  const store = localStore(ctx)
  const keys = prefKeys(ctx.network)
  const raw = readRaw(store, keys)
  const meta = record?.prefs
  const base = meta && meta.keyId === ctx.keyId ? meta.base : null
  // This browser's preferences are uploaded by the first identity that syncs here, or once changed in its session.
  const prefEdits = record?.prefEdits ?? {}
  const edits = prefSlotEdits(prefEdits, ctx.network)
  const plan = await mergeSlot(ctx, 'prefs', { local: prefsEntries(raw, ctx.network), base, options: PREFS_PLAN, tag, edits, uploadLocal: prefsOwner(ctx.identityId) })
  // A preference never set here takes the synced value as its own (an older build sees it too);
  // one set here is never overwritten: the readers show the merged value through the overlay.
  const viewBefore = prefsViewRaw(plan.view, raw, ctx.network)
  const after = { ...raw }
  for (const k of keys) {
    const v = viewBefore[k]
    if (raw[k] !== null || v === undefined) continue
    try {
      if (ctx.stillActive?.() !== false && store?.getItem(k) === null) {
        store.setItem(k, v)
        after[k] = v
      }
    } catch {
      /* storage refused: the overlay still shows it */
    }
  }
  return { keyId: ctx.keyId, syncedAt: at, base: baseAfter(prefsEntries(raw, ctx.network), prefsEntries(after, ctx.network), tag, PREFS_PLAN.lists), raw: after, view: prefsViewRaw(plan.view, after, ctx.network), carried: prefEdits }
}

/** One sync of both slots. Throws when Platform cannot be read or written; nothing local is lost either way. */
export async function syncUserSettings(ctx: SyncContext): Promise<SyncOutcome> {
  const at = (ctx.now ?? Date.now)()
  const record = readRecord(ctx.networkKey, ctx.identityId)
  const { carried, ...prefs } = await syncPrefs(ctx, record, at)
  // The preference edits this run carried are done; any made meanwhile stay for the next.
  const prefEditsLeft = Object.entries(readRecord(ctx.networkKey, ctx.identityId)?.prefEdits ?? {}).filter(([k, t]) => carried[k] !== t)
  updateRecord(ctx.networkKey, ctx.identityId, { prefs, prefEdits: Object.fromEntries(prefEditsLeft) })
  const storage = await syncStorage(ctx, record, at)
  if (storage !== null) {
    // The deletes this run carried are done; any made meanwhile stay for the next.
    const now = readRecord(ctx.networkKey, ctx.identityId)
    const left = Object.entries(now?.deletes ?? {}).filter(([k, t]) => storage.deletes[k] !== t)
    const editsLeft = Object.entries(now?.edits ?? {}).filter(([k, t]) => storage.edits[k] !== t)
    updateRecord(ctx.networkKey, ctx.identityId, { storage: storage.meta, deletes: Object.fromEntries(left), edits: Object.fromEntries(editsLeft) })
  }
  return { storage: storage?.config ?? null, synced: storage?.synced ?? null, syncedRemoved: storage?.removed ?? null, syncedAt: at }
}

/** When this device last synced for (network, identity), or null. */
export function syncedAt(networkKey: string, identityId: string): number | null {
  const r = readRecord(networkKey, identityId)
  return r?.storage?.syncedAt ?? r?.prefs?.syncedAt ?? null
}
