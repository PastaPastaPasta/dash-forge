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
import { baseOf, parseDoc, planSlot, sameDoc, type LwwDoc, type PlanOptions, type SlotPlan, type Tagger } from './lww'
import { readRecord, store, updateRecord, type PrefsMeta, type SlotMeta, type SyncRecord } from './overlay'
import type { Stored, UserSyncPort } from './platform'
import { PREFS_PLAN, prefKeys, prefsEntries, prefsViewRaw } from './prefs-slot'
import { storageEntries, storageView, withAdditions } from './storage-slot'

/** This device's storage settings, as the vault keeps them. */
export interface LocalStorageConfig {
  load(): Promise<StorageConfig>
  save(config: StorageConfig): Promise<void>
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
  return { stored, doc: parseDoc(await openState(stateCtx(ctx), stored.fields), slot) }
}

/**
 * Merge `slot` and write it back when something changed here; with `verify`, read it back and
 * compare before returning. One retry when another device wrote in between.
 */
async function mergeSlot(ctx: SyncContext, slot: string, local: Record<string, unknown>, base: SlotMeta | undefined, options: PlanOptions, tag: Tagger): Promise<SlotPlan> {
  const now = ctx.now ?? Date.now
  for (let attempt = 0; ; attempt++) {
    const { stored, doc } = await readSlot(ctx, slot)
    const plan = planSlot({ slot, local, base: base && base.keyId === ctx.keyId ? base.base : null, remote: doc, now: now(), tag, options })
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

async function syncStorage(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<{ config: StorageConfig; meta: SlotMeta } | null> {
  if (ctx.storage === null) return null
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'storage')
  const local = await ctx.storage.load()
  const plan = await mergeSlot(ctx, 'storage', storageEntries(local), record?.storage, { tombstoneRemoved: true }, tag)
  const added = withAdditions(local, plan.add)
  if (added !== null) await ctx.storage.save(added)
  const after = added ?? local
  return { config: storageView(plan.view, plan.collisions, after, ctx.deviceId), meta: { keyId: ctx.keyId, syncedAt: at, base: baseOf(storageEntries(after), tag) } }
}

async function syncPrefs(ctx: SyncContext, record: SyncRecord | null, at: number): Promise<PrefsMeta> {
  const tag = await tagger(ctx.E, ctx.identityId, ctx.networkKey, 'prefs')
  const store = localStore(ctx)
  const keys = prefKeys(ctx.network)
  const raw = readRaw(store, keys)
  const plan = await mergeSlot(ctx, 'prefs', prefsEntries(raw, ctx.network), record?.prefs, PREFS_PLAN, tag)
  // A preference never set here takes the synced value as its own (an older build sees it too);
  // one set here is never overwritten: the readers show the merged value through the overlay.
  const viewBefore = prefsViewRaw(plan.view, raw, ctx.network)
  for (const k of keys) {
    const v = viewBefore[k]
    if (raw[k] !== null || v === undefined) continue
    try {
      if (store?.getItem(k) === null) store.setItem(k, v)
    } catch {
      /* storage refused: the overlay still shows it */
    }
  }
  const after = readRaw(store, keys)
  return { keyId: ctx.keyId, syncedAt: at, base: baseOf(prefsEntries(after, ctx.network), tag, PREFS_PLAN.lists), raw: after, view: prefsViewRaw(plan.view, after, ctx.network) }
}

/** One sync of both slots. Throws when Platform cannot be read or written; nothing local is lost either way. */
export async function syncUserSettings(ctx: SyncContext): Promise<SyncOutcome> {
  const at = (ctx.now ?? Date.now)()
  const record = readRecord(ctx.networkKey, ctx.identityId)
  const prefs = await syncPrefs(ctx, record, at)
  updateRecord(ctx.networkKey, ctx.identityId, { prefs })
  const storage = await syncStorage(ctx, record, at)
  if (storage !== null) updateRecord(ctx.networkKey, ctx.identityId, { storage: storage.meta })
  return { storage: storage?.config ?? null, syncedAt: at }
}

/** When this device last synced for (network, identity), or null. */
export function syncedAt(networkKey: string, identityId: string): number | null {
  const r = readRecord(networkKey, identityId)
  return r?.storage?.syncedAt ?? r?.prefs?.syncedAt ?? null
}
