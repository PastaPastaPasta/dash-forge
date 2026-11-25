/**
 * The last-writer-wins map every forge-user slot holds (docs/design/identity-synced-state.md §4):
 * `{format, version, entries: {key: {at, v | null}}}`, `null` a tombstone. Entries and top-level
 * fields this build does not understand are kept and written back unchanged.
 *
 * {@link planSlot} is the whole merge, pure: the local values, what they were at the last sync
 * (`base`, as tags), and the synced document give the next document, the merged view, and the
 * keys to add locally. Local data is never removed or replaced by it: a key missing locally is
 * added, a tombstone only hides a key in the view.
 */

import { canonicalJson } from './crypto'

export const LWW_VERSION = 1

export interface LwwEntry {
  readonly at: number
  readonly v: unknown
}

export interface LwwDoc {
  readonly format: string
  readonly version: number
  readonly entries: Readonly<Record<string, LwwEntry>>
  /** Any other top-level field, kept as is. */
  readonly [extra: string]: unknown
}

/** A synced document of a format newer than this build: read, never written. */
export class NewerSyncFormatError extends Error {
  constructor(format: string, version: number) {
    super(`the synced ${format} is version ${version}, newer than this app understands`)
    this.name = 'NewerSyncFormatError'
  }
}

export function emptyDoc(slot: string): LwwDoc {
  return { format: `forge-user/${slot}`, version: LWW_VERSION, entries: {} }
}

/** A decrypted document as an {@link LwwDoc}; throws on anything that is not one for `slot`. */
export function parseDoc(raw: unknown, slot: string): LwwDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('the synced settings are not a map')
  const r = raw as Record<string, unknown>
  if (r['format'] !== `forge-user/${slot}`) throw new Error(`the synced ${slot} settings have format ${String(r['format'])}`)
  const version = r['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new Error('the synced settings have no version')
  if (version > LWW_VERSION) throw new NewerSyncFormatError(slot, version)
  const entries: Record<string, LwwEntry> = {}
  const rawEntries = r['entries']
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) throw new Error('the synced settings have no entries')
  for (const [key, e] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null) continue
    const at = (e as Record<string, unknown>)['at']
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    entries[key] = { at, v: (e as Record<string, unknown>)['v'] ?? null }
  }
  return { ...r, format: r['format'] as string, version, entries }
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null)
}

export function sameDoc(a: LwwDoc, b: LwwDoc): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** How each key's local value is tagged for change detection, and how a local removal reads. */
export interface PlanOptions {
  /** A key whose local value went missing since the last sync: a deletion (tombstone), or ignored. */
  readonly tombstoneRemoved: boolean
  /**
   * List-valued keys merged element by element (by id): a local change adds and removes only
   * what changed here, keeping what another device added meanwhile.
   */
  readonly lists?: Readonly<Record<string, (element: unknown) => string>>
}

/** What the last sync recorded per key: the value's tag, and for list keys each element's tag by id. */
export interface SlotBase {
  readonly tags: Readonly<Record<string, string>>
  readonly elements?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface SlotPlan {
  /** The document to write (equal to the synced one when nothing changed here). */
  readonly next: LwwDoc
  /** Whether `next` differs from the synced document. */
  readonly upload: boolean
  /** Every live merged value. */
  readonly view: Readonly<Record<string, unknown>>
  /** Keys held locally with another value than the merged one (the merged one wins in the view). */
  readonly collisions: readonly string[]
  /** Merged values of keys missing locally: added locally (write-through). */
  readonly add: Readonly<Record<string, unknown>>
}

export type Tagger = (key: string, value: unknown) => string

/**
 * One slot's merge. `base` null is this device's first sync: a local key the synced copy holds with
 * another value keeps the synced value (the local one stays local), a local key it lacks, or holds
 * as a tombstone, is uploaded. Later syncs upload what changed here since `base`, at `now`.
 */
export function planSlot(p: {
  readonly slot: string
  readonly local: Readonly<Record<string, unknown>>
  readonly base: SlotBase | null
  readonly remote: LwwDoc | null
  readonly now: number
  readonly tag: Tagger
  readonly options: PlanOptions
}): SlotPlan {
  const remote = p.remote ?? emptyDoc(p.slot)
  const entries: Record<string, LwwEntry> = { ...remote.entries }
  const keys = new Set([...Object.keys(p.local), ...Object.keys(p.base?.tags ?? {})])
  for (const key of keys) {
    const has = Object.hasOwn(p.local, key)
    const lv = has ? p.local[key] : undefined
    const synced = entries[key]
    let changed: boolean
    if (!has) changed = p.base !== null && p.options.tombstoneRemoved && synced !== undefined && synced.v !== null
    else if (synced === undefined) changed = true
    else if (p.base === null) changed = synced.v === null
    else changed = p.base.tags[key] !== p.tag(key, lv)
    if (!changed) continue
    const at = Math.max(p.now, (synced?.at ?? 0) + 1)
    const idOf = p.options.lists?.[key]
    const v = has && idOf && p.base !== null && synced?.v != null && Array.isArray(synced.v) && Array.isArray(lv)
      ? mergeList(synced.v, lv, p.base.elements?.[key] ?? {}, idOf, (e) => p.tag(key, e))
      : has ? lv : null
    if (synced !== undefined && sameValue(synced.v, v)) continue
    entries[key] = { at, v }
  }
  const next: LwwDoc = { ...remote, entries }
  const view: Record<string, unknown> = {}
  const add: Record<string, unknown> = {}
  const collisions: string[] = []
  for (const [key, e] of Object.entries(entries)) {
    if (e.v === null) continue
    view[key] = e.v
    const has = Object.hasOwn(p.local, key)
    if (!has) add[key] = e.v
    else if (!sameValue(p.local[key], e.v)) collisions.push(key)
  }
  return { next, upload: p.remote === null ? Object.keys(entries).length > 0 : !sameDoc(next, remote), view, collisions: collisions.sort(), add }
}

/**
 * A list changed here, merged into the synced one: the synced elements, without those removed here
 * since the last sync, with those added or changed here (by id).
 */
export function mergeList(synced: readonly unknown[], local: readonly unknown[], base: Readonly<Record<string, string>>, idOf: (e: unknown) => string, tag: (e: unknown) => string): unknown[] {
  const localById = new Map(local.map((e) => [idOf(e), e] as const))
  const removed = new Set(Object.keys(base).filter((id) => !localById.has(id)))
  const changed = new Map([...localById].filter(([id, e]) => base[id] !== tag(e)))
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const e of synced) {
    const id = idOf(e)
    if (seen.has(id) || removed.has(id)) continue
    seen.add(id)
    out.push(changed.get(id) ?? e)
  }
  for (const [id, e] of changed) if (!seen.has(id)) out.push(e)
  return out
}

/** The base to record after a sync: each local key's tag, and each list element's. */
export function baseOf(local: Readonly<Record<string, unknown>>, tag: Tagger, lists: PlanOptions['lists'] = {}): SlotBase {
  const tags: Record<string, string> = {}
  const elements: Record<string, Record<string, string>> = {}
  for (const [key, v] of Object.entries(local)) {
    tags[key] = tag(key, v)
    const idOf = lists[key]
    if (idOf && Array.isArray(v)) elements[key] = Object.fromEntries(v.map((e) => [idOf(e), tag(key, e)]))
  }
  return Object.keys(elements).length > 0 ? { tags, elements } : { tags }
}
