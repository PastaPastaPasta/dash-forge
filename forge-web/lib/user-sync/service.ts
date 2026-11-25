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
import { baseOf, parseDoc, planSlot, sameDoc, type LwwDoc, type PlanOptions, type SlotBase, type SlotPlan, type Tagger } from './lww'
import { prefsOwner, readRecord, store, updateRecord, type PrefsMeta, type SlotMeta, type SyncRecord } from './overlay'
import type { Stored, UserSyncPort } from './platform'
import { PREFS_PLAN, prefKeys, prefsEntries, prefsViewRaw } from './prefs-slot'
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
}

export interface SyncOutcome {
  /** The effective storage config (null when the storage slot was not synced this run). */
  readonly storage: StorageConfig | null
  readonly syncedAt: number
}

/** The synced settings were written with another key of this identity: nothing is merged or written. */
export class SyncKeyChangedError extends Error {
  constructor(readonly storedKeyId: number, readonly heldKeyId: number) {
    super(`your synced settings are sealed with key ${storedKeyId}, and this browser holds key ${heldKeyId}; sign in with your wallet again`)
    this.name = 'SyncKeyChangedError'
  }
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
  if (stored.fields.keyId !== ctx.keyId) throw new SyncKeyChangedError(stored.fields.keyId, ctx.keyId)
  return { stored, doc: parseDoc(await openState(stateCtx(ctx), stored.fields), slot) }
}

/**
 * Merge `slot` and write it back when something changed here, then read it back and compare. One
 * retry when another device wrote in between.
 */
async function mergeSlot(
  ctx: SyncContext,
  slot: string,
  p: { readonly local: Record<string, unknown>; readonly base: SlotBase | null; readonly options: PlanOptions; readonly tag: Tagger; readonly deletions?: Readonly<Record<string, number>>; readonly uploadLocal?: boolean },
): Promise<SlotPlan> {
  const now = ctx.now ?? Date.now
  for (let attempt = 0; ; attempt++) {
    const { stored, doc } = await readSlot(ctx, slot)
    const plan = planSlot({ slot, remote: doc, now: now(), ...p })
    if (!plan.upload) return plan
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

async function syncStorage(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<{ config: StorageConfig; meta: SlotMeta; deletes: Readonly<Record<string, number>> } | null> {
  if (ctx.storage === null) return null
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'storage')
  const syncId = await ctx.storage.syncId()
  const meta = record?.storage
  // A base for another key or another blob (forgotten, discarded, re-keyed) is no base: a first sync.
  const base = meta && meta.keyId === ctx.keyId && meta.syncId === syncId ? meta.base : null
  const deletes = record?.deletes ?? {}
  const local = await ctx.storage.load()
  const snapshot = storageEntries(local)
  const plan = await mergeSlot(ctx, 'storage', { local: snapshot, base, options: { carry: carryProfileExtras }, tag, deletions: deletes })
  // Additions only, to the settings as they are now (a Settings save may have landed meanwhile).
  const written = await ctx.storage.update((current) => withAdditions(current, plan.add))
  const addedHere = Object.fromEntries(Object.entries(storageEntries(written)).filter(([k]) => Object.hasOwn(plan.add, k) && !Object.hasOwn(snapshot, k)))
  return {
    config: storageView(plan.view, plan.collisions, written, ctx.deviceId),
    meta: { keyId: ctx.keyId, syncedAt: at, syncId, base: baseAfter(snapshot, addedHere, tag) },
    deletes,
  }
}

async function syncPrefs(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<PrefsMeta> {
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'prefs')
  const store = localStore(ctx)
  const keys = prefKeys(ctx.network)
  const raw = readRaw(store, keys)
  const meta = record?.prefs
  const base = meta && meta.keyId === ctx.keyId ? meta.base : null
  // This browser's preferences are uploaded by the first identity that syncs here, or once changed in a session.
  const plan = await mergeSlot(ctx, 'prefs', { local: prefsEntries(raw, ctx.network), base, options: PREFS_PLAN, tag, uploadLocal: base !== null || prefsOwner(ctx.identityId) })
  // A preference never set here takes the synced value as its own (an older build sees it too);
  // one set here is never overwritten: the readers show the merged value through the overlay.
  const viewBefore = prefsViewRaw(plan.view, raw, ctx.network)
  const after = { ...raw }
  for (const k of keys) {
    const v = viewBefore[k]
    if (raw[k] !== null || v === undefined) continue
    try {
      if (store?.getItem(k) === null) {
        store.setItem(k, v)
        after[k] = v
      }
    } catch {
      /* storage refused: the overlay still shows it */
    }
  }
  return { keyId: ctx.keyId, syncedAt: at, base: baseAfter(prefsEntries(raw, ctx.network), prefsEntries(after, ctx.network), tag, PREFS_PLAN.lists), raw: after, view: prefsViewRaw(plan.view, after, ctx.network) }
}

/** One sync of both slots. Throws when Platform cannot be read or written; nothing local is lost either way. */
export async function syncUserSettings(ctx: SyncContext): Promise<SyncOutcome> {
  const at = (ctx.now ?? Date.now)()
  const record = readRecord(ctx.networkKey, ctx.identityId)
  const prefs = await syncPrefs(ctx, record, at)
  updateRecord(ctx.networkKey, ctx.identityId, { prefs })
  const storage = await syncStorage(ctx, record, at)
  if (storage !== null) {
    // The deletes this run carried are done; any made meanwhile stay for the next.
    const left = Object.entries(readRecord(ctx.networkKey, ctx.identityId)?.deletes ?? {}).filter(([k, t]) => storage.deletes[k] !== t)
    updateRecord(ctx.networkKey, ctx.identityId, { storage: storage.meta, deletes: Object.fromEntries(left) })
  }
  return { storage: storage?.config ?? null, syncedAt: at }
}

/** When this device last synced for (network, identity), or null. */
export function syncedAt(networkKey: string, identityId: string): number | null {
  const r = readRecord(networkKey, identityId)
  return r?.storage?.syncedAt ?? r?.prefs?.syncedAt ?? null
}
