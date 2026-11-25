/**
 * What sync knows on this device, per (network, identity), in one localStorage record of its own
 * (`forge:user-sync:<network key>:<identity>`): when each slot last synced, its base (what the local
 * values were then, as tags), and for prefs the merged values to show.
 *
 * Synced preferences never overwrite the preference keys themselves (an older build on this device
 * keeps reading its own). The readers ask {@link effectiveRaw} instead: the merged value while the
 * local value is still what it was at the last sync, else the local one (changed here since, and
 * about to be uploaded). Nothing here is secret: storage tags are keyed with the sync key, and
 * preferences are plain in localStorage already.
 */

import type { SlotBase } from './lww'

const RECORD_VERSION = 1

export interface SlotMeta {
  readonly keyId: number
  readonly syncedAt: number
  readonly base: SlotBase
  /** The storage settings' sync id the base belongs to (`lib/auth/vault.ts` `storageSyncId`). */
  readonly syncId?: string
}

export interface PrefsMeta extends SlotMeta {
  /** Each preference key's local raw value at the sync. */
  readonly raw: Readonly<Record<string, string | null>>
  /** Each preference key's merged raw value. */
  readonly view: Readonly<Record<string, string>>
}

export interface SyncRecord {
  readonly v: 1
  readonly storage?: SlotMeta
  readonly prefs?: PrefsMeta
  /** Storage keys the user deleted here, and when: the only tombstones sync writes. */
  readonly deletes?: Readonly<Record<string, number>>
  /** Storage keys the user edited here, and when: uploaded even when the value is the one held here before. */
  readonly edits?: Readonly<Record<string, number>>
  /** Preference keys written here since the last sync, and when: they read as written, and are uploaded. */
  readonly prefEdits?: Readonly<Record<string, number>>
}

/** Record that the user edited `keys` of the storage settings here at `at`. */
export function noteStorageEdits(networkKey: string, identityId: string, keys: readonly string[], at: number): void {
  if (keys.length === 0) return
  const r = readRecord(networkKey, identityId)
  updateRecord(networkKey, identityId, { edits: { ...(r?.edits ?? {}), ...Object.fromEntries(keys.map((k) => [k, at])) } })
}

/** Record that the user deleted `keys` from the storage settings here at `at`. */
export function noteStorageDeletes(networkKey: string, identityId: string, keys: readonly string[], at: number): void {
  if (keys.length === 0) return
  const r = readRecord(networkKey, identityId)
  updateRecord(networkKey, identityId, { deletes: { ...(r?.deletes ?? {}), ...Object.fromEntries(keys.map((k) => [k, at])) } })
}

const DEVICE_KEY = 'forge:user-sync:device'

/**
 * The identity whose first sync on this device took its preferences (they are this browser's, not
 * any one identity's): another identity's first sync does not upload them as its own.
 */
export function prefsOwner(identityId: string): boolean {
  try {
    const s = store()
    const first = s?.getItem(DEVICE_KEY) ?? null
    if (first === null) s?.setItem(DEVICE_KEY, identityId)
    return first === null || first === identityId
  } catch {
    return true
  }
}

export function recordKey(networkKey: string, identityId: string): string {
  return `forge:user-sync:${networkKey}:${identityId}`
}

/** localStorage, or null where it is missing or refused. */
export function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isMeta = (v: unknown): boolean => isMap(v) && typeof v['keyId'] === 'number' && typeof v['syncedAt'] === 'number' && isMap(v['base']) && isMap(v['base']['tags'])

/** The stored record, each part dropped that does not read as one (it is redone by the next sync). */
export function readRecord(networkKey: string, identityId: string): SyncRecord | null {
  try {
    const raw = store()?.getItem(recordKey(networkKey, identityId))
    if (!raw) return null
    const r = JSON.parse(raw) as unknown
    if (!isMap(r) || r['v'] !== RECORD_VERSION) return null
    const prefs = r['prefs']
    const prefsOk = isMeta(prefs) && isMap((prefs as Record<string, unknown>)['raw']) && isMap((prefs as Record<string, unknown>)['view'])
    return {
      v: 1,
      ...(isMeta(r['storage']) ? { storage: r['storage'] as SlotMeta } : {}),
      ...(prefsOk ? { prefs: prefs as PrefsMeta } : {}),
      ...(isMap(r['deletes']) ? { deletes: r['deletes'] as Record<string, number> } : {}),
      ...(isMap(r['edits']) ? { edits: r['edits'] as Record<string, number> } : {}),
      ...(isMap(r['prefEdits']) ? { prefEdits: r['prefEdits'] as Record<string, number> } : {}),
    }
  } catch {
    return null
  }
}

/** `patch` merged over the stored record. */
export function updateRecord(networkKey: string, identityId: string, patch: Omit<Partial<SyncRecord>, 'v'>): void {
  writeRecord(networkKey, identityId, { ...(readRecord(networkKey, identityId) ?? { v: 1 }), ...patch })
}

export function writeRecord(networkKey: string, identityId: string, record: SyncRecord): void {
  try {
    store()?.setItem(recordKey(networkKey, identityId), JSON.stringify(record))
  } catch {
    /* storage refused: sync starts over next time, nothing local is affected */
  }
  if (active?.networkKey === networkKey && active.identityId === identityId) setActive(networkKey, identityId)
}

let active: { networkKey: string; identityId: string; prefs: PrefsMeta | null; edits: Readonly<Record<string, number>> } | null = null

/** The preference keys whose effective value differs between two overlays. */
function changedKeys(a: PrefsMeta | null | undefined, b: PrefsMeta | null | undefined): string[] {
  const keys = new Set([...Object.keys(a?.view ?? {}), ...Object.keys(b?.view ?? {})])
  return [...keys].filter((k) => a?.view[k] !== b?.view[k] || a?.raw[k] !== b?.raw[k])
}

/** Tell this tab's readers a preference may read differently (they listen for `storage`). */
function announce(keys: readonly string[]): void {
  if (typeof window === 'undefined' || typeof StorageEvent === 'undefined') return
  for (const key of keys) {
    try {
      window.dispatchEvent(new StorageEvent('storage', { key }))
    } catch {
      /* no StorageEvent constructor: readers pick it up on their next read */
    }
  }
}

/** The signed-in identity whose synced preferences apply (null: none, the local ones only). */
export function setActive(networkKey: string, identityId: string | null): void {
  const before = active?.prefs ?? null
  const record = identityId === null ? null : readRecord(networkKey, identityId)
  const prefs = record?.prefs ?? null
  active = identityId === null ? null : { networkKey, identityId, prefs, edits: record?.prefEdits ?? {} }
  announce(changedKeys(before, prefs))
}

/** The value a preference reader uses for `key`, given the local raw value. */
export function effectiveRaw(key: string, localRaw: string | null): string | null {
  const prefs = active?.prefs
  if (!prefs) return localRaw
  const merged = prefs.view[key]
  // Written here since the last sync: the user's choice, whatever value it is.
  if (active !== null && Object.hasOwn(active.edits, key)) return localRaw
  if (merged === undefined || !Object.hasOwn(prefs.raw, key) || prefs.raw[key] !== localRaw) return localRaw
  return merged
}

/**
 * A preference reader wrote `key` (the user changed it here): it reads as written from now on, and
 * the next sync uploads it, even when it equals the value held here before.
 */
export function notePrefWrite(key: string): void {
  if (active === null || active.prefs === null) return
  updateRecord(active.networkKey, active.identityId, { prefEdits: { ...(readRecord(active.networkKey, active.identityId)?.prefEdits ?? {}), [key]: Date.now() } })
}

/** `localStorage.getItem(key)` as a preference reader should see it. */
export function readPref(key: string): string | null {
  let raw: string | null = null
  try {
    raw = store()?.getItem(key) ?? null
  } catch {
    raw = null
  }
  return effectiveRaw(key, raw)
}
