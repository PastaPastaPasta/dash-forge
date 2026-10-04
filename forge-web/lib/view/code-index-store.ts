/**
 * Where code search's indexes are kept (P1-3): the files of a repo's ref, as blob bytes, and per
 * indexed tip the list of its files. In IndexedDB for a public repo (the index survives a reload,
 * and a later tip re-reads only the files that changed: blobs are kept by id, per repo), in memory
 * for a private one (decrypted file contents never reach this browser's disk, as the session's
 * keys do not).
 *
 * A blob that is not searched (binary, or over the per-file limit) is kept as a marker in its key
 * alone (`<scope>\0<oid>:binary`), so a later build of the repo does not read it again, and asking
 * which blobs are stored ({@link CodeIndexStore.stored}) reads keys, never bytes.
 *
 * Bounded: a repo keeps its newest {@link CodeIndexRecord}s (`keep`), the blobs only a dropped
 * index named go with it, and past {@link CODE_INDEX_BUDGET_BYTES} across repos the
 * least recently used repos go whole.
 *
 * Every stored blob is checked against its id when an index is loaded (`code-index-host.ts`): a
 * tampered or truncated entry is read again, never searched.
 *
 * Plain IndexedDB (no DOM): it runs in the search worker. Tests use `fake-indexeddb`.
 */

/** Bytes of blobs kept across every repo before the least recently used repos are dropped. */
export const CODE_INDEX_BUDGET_BYTES = 256 * 1024 * 1024

/** Why a file of the tree is not searched. */
export type SkipReason = 'binary' | 'large' | 'symlink'

/** What is stored for a blob: its text, or why it is not searched. */
export type StoredKind = 'text' | 'binary' | 'large'

/** A blob handed to the store: its bytes, or why it is not searched. */
export type StoredBlob = { readonly bytes: Uint8Array } | { readonly skip: 'binary' | 'large' }

/** One indexed tip: the files searched (`[path, blob id]`), and what was left out. */
export interface CodeIndexRecord {
  /** The ref tip the index was built for (a commit, or a tag object). */
  readonly tip: string
  /** The commit (when the tip is one, or a tag of one) and its root tree. */
  readonly commit: string | null
  readonly tree: string
  /** The ref's name as the page showed it (`develop`, `v1.0`), for "the index is of an older commit". */
  readonly ref: string
  readonly files: readonly (readonly [path: string, oid: string])[]
  /** Files of the tree not searched, by reason. */
  readonly skipped: Readonly<Record<SkipReason, number>>
  /** The tree walk stopped at its file cap: files past it are not in the index. */
  readonly truncated: boolean
  /** Reading stopped at the text cap: files past it are not in the index. */
  readonly capped: boolean
  /** Built under the large-repo rules (default branch only). */
  readonly large: boolean
  /** When built (ms). */
  readonly builtAt: number
}

export interface CodeIndexStore {
  getIndex(scope: string, tip: string): Promise<CodeIndexRecord | undefined>
  /** The newest index of `ref` (any tip), for a ref that moved since. */
  latestIndex(scope: string, ref: string): Promise<CodeIndexRecord | undefined>
  /** What is stored of each of `oids` (absent: nothing). */
  stored(scope: string, oids: readonly string[]): Promise<Map<string, StoredKind>>
  /** The bytes of each of `oids` stored as text. */
  getBlobs(scope: string, oids: readonly string[]): Promise<Map<string, Uint8Array>>
  putBlobs(scope: string, blobs: readonly (readonly [oid: string, blob: StoredBlob])[]): Promise<void>
  /** Forget the text of `oids` (it failed its check). */
  deleteBlobs(scope: string, oids: readonly string[]): Promise<void>
  /** Store an index, keep the repo's newest `keep`, drop the blobs none of them names, then fit the budget. */
  putIndex(scope: string, record: CodeIndexRecord, keep: number): Promise<void>
  /** The repo's index was just used: it is the last to be dropped for the budget. */
  touch(scope: string): Promise<void>
  /** Forget a repo's indexes and blobs. */
  dropScope(scope: string): Promise<void>
}

/** What a repo's indexes hold, for eviction. */
interface ScopeMeta {
  readonly scope: string
  /** Indexed tips, newest first. */
  readonly tips: readonly string[]
  /** Blob bytes stored for the repo (kept ones, plus any read since the last index was stored). */
  readonly bytes: number
  readonly usedAt: number
}

const SEP = '\u0000'
const tipKey = (scope: string, tip: string): string => `${scope}${SEP}${tip}`
/** A blob's key: its id for text, `<id>:<reason>` for a marker. */
const blobKey = (scope: string, oid: string, kind: StoredKind = 'text'): string => `${scope}${SEP}${oid}${kind === 'text' ? '' : `:${kind}`}`
const keyOf = (scope: string, oid: string, b: StoredBlob): string => blobKey(scope, oid, 'bytes' in b ? 'text' : b.skip)
const sizeOf = (b: StoredBlob): number => ('bytes' in b ? b.bytes.length : 0)

/** A stored key back to its blob id and kind. */
function parseBlobKey(scope: string, key: string): readonly [oid: string, kind: StoredKind] {
  const rest = key.slice(scope.length + 1)
  const colon = rest.indexOf(':')
  return colon === -1 ? [rest, 'text'] : [rest.slice(0, colon), rest.slice(colon + 1) as StoredKind]
}

/** The tips a repo keeps after `tip` is stored, newest first, and those it drops. */
function keptTips(meta: ScopeMeta | undefined, tip: string, keep: number): { kept: string[]; dropped: string[] } {
  const tips = [tip, ...(meta?.tips ?? []).filter((t) => t !== tip)]
  return { kept: tips.slice(0, keep), dropped: tips.slice(keep) }
}

/** The repos to drop, least recently used first (never `current`), until the rest fit `budget`. */
function overBudget(scopes: readonly ScopeMeta[], current: string, budget: number): string[] {
  let total = scopes.reduce((n, s) => n + s.bytes, 0)
  const out: string[] = []
  for (const s of [...scopes].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= budget) break
    if (s.scope === current) continue
    total -= s.bytes
    out.push(s.scope)
  }
  return out
}

// ---------------------------------------------------------------------------
// In memory (private repos, tests)
// ---------------------------------------------------------------------------

/** A store in this worker's memory: gone with the tab, or when the repo's session ends. */
export class MemoryCodeIndexStore implements CodeIndexStore {
  private readonly blobs = new Map<string, Uint8Array | null>()
  private readonly indexes = new Map<string, CodeIndexRecord>()
  private readonly scopes = new Map<string, ScopeMeta>()

  constructor(private readonly budget = CODE_INDEX_BUDGET_BYTES) {}

  async getIndex(scope: string, tip: string): Promise<CodeIndexRecord | undefined> {
    return this.indexes.get(tipKey(scope, tip))
  }

  async latestIndex(scope: string, ref: string): Promise<CodeIndexRecord | undefined> {
    return (this.scopes.get(scope)?.tips ?? []).map((t) => this.indexes.get(tipKey(scope, t))).find((r) => r?.ref === ref)
  }

  async stored(scope: string, oids: readonly string[]): Promise<Map<string, StoredKind>> {
    const out = new Map<string, StoredKind>()
    for (const o of oids) {
      const kind = (['text', 'binary', 'large'] as const).find((k) => this.blobs.has(blobKey(scope, o, k)))
      if (kind !== undefined) out.set(o, kind)
    }
    return out
  }

  async getBlobs(scope: string, oids: readonly string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    for (const o of oids) {
      const b = this.blobs.get(blobKey(scope, o))
      if (b != null) out.set(o, b)
    }
    return out
  }

  async putBlobs(scope: string, blobs: readonly (readonly [string, StoredBlob])[]): Promise<void> {
    let added = 0
    for (const [oid, b] of blobs) {
      const key = keyOf(scope, oid, b)
      if (!this.blobs.has(key)) added += sizeOf(b)
      this.blobs.set(key, 'bytes' in b ? b.bytes : null)
    }
    const meta = this.scopes.get(scope)
    this.scopes.set(scope, { scope, tips: meta?.tips ?? [], bytes: (meta?.bytes ?? 0) + added, usedAt: Date.now() })
  }

  async deleteBlobs(scope: string, oids: readonly string[]): Promise<void> {
    for (const o of oids) this.blobs.delete(blobKey(scope, o))
  }

  async putIndex(scope: string, record: CodeIndexRecord, keep: number): Promise<void> {
    const { kept, dropped } = keptTips(this.scopes.get(scope), record.tip, keep)
    const unnamed = new Set(dropped.flatMap((t) => this.indexes.get(tipKey(scope, t))?.files.map((f) => f[1]) ?? []))
    this.indexes.set(tipKey(scope, record.tip), record)
    for (const t of dropped) this.indexes.delete(tipKey(scope, t))
    for (const t of kept) for (const f of this.indexes.get(tipKey(scope, t))?.files ?? []) unnamed.delete(f[1])
    let bytes = 0
    for (const [key, b] of this.blobs) {
      if (!key.startsWith(scope + SEP) || b === null) continue
      if (unnamed.has(parseBlobKey(scope, key)[0])) this.blobs.delete(key)
      else bytes += b.length
    }
    this.scopes.set(scope, { scope, tips: kept, bytes, usedAt: Date.now() })
    for (const s of overBudget([...this.scopes.values()], scope, this.budget)) await this.dropScope(s)
  }

  async touch(scope: string): Promise<void> {
    const meta = this.scopes.get(scope)
    if (meta !== undefined) this.scopes.set(scope, { ...meta, usedAt: Date.now() })
  }

  async dropScope(scope: string): Promise<void> {
    for (const m of [this.blobs, this.indexes]) for (const k of [...m.keys()]) if (k.startsWith(scope + SEP)) m.delete(k)
    this.scopes.delete(scope)
  }
}

// ---------------------------------------------------------------------------
// IndexedDB (public repos)
// ---------------------------------------------------------------------------

const DB_NAME = 'dash-forge-code-search'
const DB_VERSION = 1
const BLOBS = 'blobs'
const INDEXES = 'indexes'
const SCOPES = 'scopes'

/** `IDBRequest` → promise. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

/** A transaction's completion → promise. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/** Every key of `scope` (and none of a scope it prefixes: the separator follows it). */
const scopeRange = (scope: string): IDBKeyRange => IDBKeyRange.bound(scope + SEP, `${scope}${SEP}￿`)

export class IdbCodeIndexStore implements CodeIndexStore {
  private db: Promise<IDBDatabase> | null = null

  constructor(
    private readonly name = DB_NAME,
    private readonly budget = CODE_INDEX_BUDGET_BYTES,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, DB_VERSION)
      r.onupgradeneeded = () => {
        for (const s of [BLOBS, INDEXES, SCOPES]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s)
      }
      r.onsuccess = () => {
        const db = r.result
        // A newer build upgrading the database: let go, and open afresh on next use.
        db.onversionchange = () => {
          db.close()
          this.db = null
        }
        resolve(db)
      }
      r.onerror = () => {
        this.db = null
        reject(r.error ?? new Error('could not open the code search index'))
      }
      r.onblocked = () => {
        this.db = null
        reject(new Error('the code search index is held open by an older Dash Forge tab; reload that tab'))
      }
    })
    return this.db
  }

  private async tx(stores: string[], mode: IDBTransactionMode): Promise<IDBTransaction> {
    return (await this.open()).transaction(stores, mode)
  }

  async getIndex(scope: string, tip: string): Promise<CodeIndexRecord | undefined> {
    const tx = await this.tx([INDEXES], 'readonly')
    return (await req(tx.objectStore(INDEXES).get(tipKey(scope, tip)))) as CodeIndexRecord | undefined
  }

  async latestIndex(scope: string, ref: string): Promise<CodeIndexRecord | undefined> {
    const tx = await this.tx([INDEXES, SCOPES], 'readonly')
    const meta = (await req(tx.objectStore(SCOPES).get(scope))) as ScopeMeta | undefined
    for (const tip of meta?.tips ?? []) {
      const rec = (await req(tx.objectStore(INDEXES).get(tipKey(scope, tip)))) as CodeIndexRecord | undefined
      if (rec?.ref === ref) return rec
    }
    return undefined
  }

  async stored(scope: string, oids: readonly string[]): Promise<Map<string, StoredKind>> {
    const out = new Map<string, StoredKind>()
    if (oids.length === 0) return out
    const tx = await this.tx([BLOBS], 'readonly')
    const keys = (await req(tx.objectStore(BLOBS).getAllKeys(scopeRange(scope)))) as string[]
    const wanted = new Set(oids)
    for (const key of keys) {
      const [oid, kind] = parseBlobKey(scope, key)
      if (wanted.has(oid)) out.set(oid, kind)
    }
    return out
  }

  async getBlobs(scope: string, oids: readonly string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    if (oids.length === 0) return out
    const tx = await this.tx([BLOBS], 'readonly')
    const store = tx.objectStore(BLOBS)
    // Every get is queued at once on the one transaction.
    const values = await Promise.all(oids.map((o) => req(store.get(blobKey(scope, o)))))
    oids.forEach((o, i) => {
      const v = values[i]
      if (v instanceof Uint8Array) out.set(o, v)
    })
    return out
  }

  async putBlobs(scope: string, blobs: readonly (readonly [string, StoredBlob])[]): Promise<void> {
    if (blobs.length === 0) return
    const tx = await this.tx([BLOBS, SCOPES], 'readwrite')
    const store = tx.objectStore(BLOBS)
    // Only blobs not stored yet add to the repo's bytes (a build continued after a stop re-adds some).
    const fresh = await Promise.all(blobs.map(([oid, b]) => req(store.getKey(keyOf(scope, oid, b))).then((k) => k === undefined)))
    for (const [oid, b] of blobs) store.put('bytes' in b ? b.bytes : true, keyOf(scope, oid, b))
    const scopes = tx.objectStore(SCOPES)
    const meta = (await req(scopes.get(scope))) as ScopeMeta | undefined
    const added = blobs.reduce((n, [, b], i) => n + (fresh[i] ? sizeOf(b) : 0), 0)
    scopes.put({ scope, tips: meta?.tips ?? [], bytes: (meta?.bytes ?? 0) + added, usedAt: Date.now() } satisfies ScopeMeta, scope)
    await done(tx)
  }

  async deleteBlobs(scope: string, oids: readonly string[]): Promise<void> {
    if (oids.length === 0) return
    const tx = await this.tx([BLOBS], 'readwrite')
    for (const o of oids) tx.objectStore(BLOBS).delete(blobKey(scope, o))
    await done(tx)
  }

  async putIndex(scope: string, record: CodeIndexRecord, keep: number): Promise<void> {
    const tx = await this.tx([BLOBS, INDEXES, SCOPES], 'readwrite')
    const indexes = tx.objectStore(INDEXES)
    const scopes = tx.objectStore(SCOPES)
    const blobs = tx.objectStore(BLOBS)
    const { kept, dropped } = keptTips((await req(scopes.get(scope))) as ScopeMeta | undefined, record.tip, keep)
    // The blobs only a dropped index named go with it. Blobs no index names yet stay: another tab's
    // build (each tab has its own worker over this database) may be about to store its index, and
    // a stopped build's blobs are what lets the next one continue.
    const unnamed = new Set<string>()
    for (const t of dropped) {
      const rec = (await req(indexes.get(tipKey(scope, t)))) as CodeIndexRecord | undefined
      for (const f of rec?.files ?? []) unnamed.add(f[1])
      indexes.delete(tipKey(scope, t))
    }
    indexes.put(record, tipKey(scope, record.tip))
    for (const f of record.files) unnamed.delete(f[1])
    for (const t of kept.slice(1)) {
      const rec = (await req(indexes.get(tipKey(scope, t)))) as CodeIndexRecord | undefined
      for (const f of rec?.files ?? []) unnamed.delete(f[1])
    }
    // Markers stay too: they are keys alone, and save a re-read.
    let bytes = 0
    await new Promise<void>((resolve, reject) => {
      const cursor = blobs.openCursor(scopeRange(scope))
      cursor.onerror = () => reject(cursor.error ?? new Error('IndexedDB cursor failed'))
      cursor.onsuccess = () => {
        const c = cursor.result
        if (c === null) return resolve()
        if (c.value instanceof Uint8Array) {
          if (unnamed.has(parseBlobKey(scope, String(c.key))[0])) c.delete()
          else bytes += c.value.length
        }
        c.continue()
      }
    })
    scopes.put({ scope, tips: kept, bytes, usedAt: Date.now() } satisfies ScopeMeta, scope)
    await done(tx)
    await this.fitBudget(scope)
  }

  /** Drop the least recently used repos (never `current`) until the stored bytes fit the budget. */
  private async fitBudget(current: string): Promise<void> {
    const tx = await this.tx([SCOPES], 'readonly')
    const all = (await req(tx.objectStore(SCOPES).getAll())) as ScopeMeta[]
    for (const s of overBudget(all, current, this.budget)) await this.dropScope(s)
  }

  async touch(scope: string): Promise<void> {
    const tx = await this.tx([SCOPES], 'readwrite')
    const scopes = tx.objectStore(SCOPES)
    const meta = (await req(scopes.get(scope))) as ScopeMeta | undefined
    if (meta !== undefined) scopes.put({ ...meta, usedAt: Date.now() } satisfies ScopeMeta, scope)
    await done(tx)
  }

  async dropScope(scope: string): Promise<void> {
    const tx = await this.tx([BLOBS, INDEXES, SCOPES], 'readwrite')
    tx.objectStore(BLOBS).delete(scopeRange(scope))
    tx.objectStore(INDEXES).delete(scopeRange(scope))
    tx.objectStore(SCOPES).delete(scope)
    await done(tx)
  }
}
