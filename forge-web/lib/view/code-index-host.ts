/**
 * The code search worker's state (P1-3): the stores, and the one index loaded for searching.
 *
 * The page reads the repo's files through its browse reader (every blob hash-checked, as on any
 * page) and hands them here; this keeps them ({@link CodeIndexStore}), loads an index's files into
 * memory as text, and runs searches over them ({@link searchCorpus}) with no request of any kind.
 * One index is held at a time: a 100 MiB repo's text is the most a tab should carry.
 *
 * A loaded file is checked against its blob id first (the store is this browser's disk, not the
 * repo): one that fails is dropped, and an index missing any file is reported `incomplete`, so
 * the page plans it again and reads what is missing (a plan reads only what is not kept).
 *
 * Plain logic, no `self`: `code-search.worker.ts` wires it to messages, the tests call it.
 */

import { gitOidHex } from '../browse/pack'
import { searchCorpus, type CorpusFile, type SearchResult } from './code-match'
import { parseCodeQuery } from './code-query'
import { IdbCodeIndexStore, MemoryCodeIndexStore, type CodeIndexRecord, type CodeIndexStore, type StoredBlob, type StoredKind } from './code-index-store'
import { headerLanguage, searchLanguageOf } from './languages'

/** An index as the page shows it. */
export interface CodeIndexSummary {
  readonly tip: string
  readonly commit: string | null
  readonly tree: string
  readonly ref: string
  readonly files: number
  /** Text bytes searched. */
  readonly bytes: number
  readonly skipped: CodeIndexRecord['skipped']
  readonly truncated: boolean
  readonly capped: boolean
  readonly large: boolean
  readonly builtAt: number
}

export type OpenResult =
  | { readonly state: 'ready'; readonly summary: CodeIndexSummary }
  /** An index is stored, but some of its files are not (evicted, or dropped failing their check). */
  | { readonly state: 'incomplete'; readonly missing: number }
  | { readonly state: 'none' }

/** One file handed over by the page: its bytes, or why it is not searched. */
export interface AddedBlob {
  readonly oid: string
  readonly bytes?: Uint8Array
  readonly skip?: 'binary' | 'large'
}

/** Requests the worker takes (`id` pairs a reply with its request). */
export type CodeIndexRequest =
  | { readonly op: 'open'; readonly scope: string; readonly persist: boolean; readonly tip: string }
  | { readonly op: 'latest'; readonly scope: string; readonly persist: boolean; readonly ref: string }
  | { readonly op: 'stored'; readonly scope: string; readonly persist: boolean; readonly oids: readonly string[] }
  | { readonly op: 'add'; readonly scope: string; readonly persist: boolean; readonly blobs: readonly AddedBlob[] }
  | { readonly op: 'commit'; readonly scope: string; readonly persist: boolean; readonly record: CodeIndexRecord; readonly keep: number }
  | { readonly op: 'search'; readonly scope: string; readonly tip: string; readonly query: string; readonly offset: number; readonly limit: number }
  | { readonly op: 'drop'; readonly scope: string }

/** The error a search of an index that is not loaded (another was opened since, or the worker restarted) fails with. */
export const NOT_LOADED = 'code-index-not-loaded'

/** Whether a file is binary: a NUL in its first 8,000 bytes, git's own test (`buffer_is_binary`). */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

/** The summary of a record whose files are loaded. */
function summaryOf(record: CodeIndexRecord, bytes: number): CodeIndexSummary {
  const { tip, commit, tree, ref, skipped, truncated, capped, large, builtAt } = record
  return { tip, commit, tree, ref, files: record.files.length, bytes, skipped, truncated, capped, large, builtAt }
}

export class CodeIndexHost {
  private readonly persistent: CodeIndexStore
  private readonly memory: CodeIndexStore
  /** The index searched now. */
  private loaded: { readonly scope: string; readonly tip: string; readonly files: readonly CorpusFile[]; readonly summary: CodeIndexSummary } | null = null

  constructor(stores?: { readonly persistent: CodeIndexStore; readonly memory: CodeIndexStore }) {
    this.persistent = stores?.persistent ?? (typeof indexedDB === 'undefined' ? new MemoryCodeIndexStore() : new IdbCodeIndexStore())
    this.memory = stores?.memory ?? new MemoryCodeIndexStore()
  }

  private store(persist: boolean): CodeIndexStore {
    return persist ? this.persistent : this.memory
  }

  async handle(req: CodeIndexRequest): Promise<unknown> {
    switch (req.op) {
      case 'open':
        return this.open(req.scope, req.persist, req.tip)
      case 'latest': {
        const rec = await this.store(req.persist).latestIndex(req.scope, req.ref)
        return rec === undefined ? null : summaryOf(rec, 0)
      }
      case 'stored':
        return [...(await this.store(req.persist).stored(req.scope, req.oids))] satisfies [string, StoredKind][]
      case 'add':
        return this.add(req.scope, req.persist, req.blobs)
      case 'commit':
        await this.store(req.persist).putIndex(req.scope, req.record, req.keep)
        return this.open(req.scope, req.persist, req.record.tip, true)
      case 'search':
        return this.search(req.scope, req.tip, req.query, req.offset, req.limit)
      case 'drop':
        if (this.loaded?.scope === req.scope) this.loaded = null
        await this.memory.dropScope(req.scope)
        return null
    }
  }

  /** Keep the page's files: text as bytes, anything else as why it is not searched. */
  private async add(scope: string, persist: boolean, blobs: readonly AddedBlob[]): Promise<null> {
    const rows = blobs.map((b): readonly [string, StoredBlob] => {
      if (b.bytes !== undefined && !isBinary(b.bytes)) return [b.oid, { bytes: b.bytes }]
      return [b.oid, { skip: b.skip ?? 'binary' }]
    })
    await this.store(persist).putBlobs(scope, rows)
    return null
  }

  /**
   * Load the index of `tip` for searching: every file it names, each checked against its id. An
   * index loaded already is not loaded again.
   */
  private async open(scope: string, persist: boolean, tip: string, reload = false): Promise<OpenResult> {
    const loaded = this.loaded
    if (!reload && loaded !== null && loaded.scope === scope && loaded.tip === tip) return { state: 'ready', summary: loaded.summary }
    const store = this.store(persist)
    const record = await store.getIndex(scope, tip)
    if (record === undefined) return { state: 'none' }
    // One index in memory at a time: let the one searched before go before this one loads.
    this.loaded = null
    const oids = [...new Set(record.files.map((f) => f[1]))]
    const blobs = await store.getBlobs(scope, oids)
    const missing: string[] = []
    const bad: string[] = []
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const texts = new Map<string, string>()
    for (const oid of oids) {
      const bytes = blobs.get(oid)
      // Gone (evicted, cleared), or bytes that are not the blob: read it again.
      if (bytes === undefined) missing.push(oid)
      else if (gitOidHex('blob', bytes) !== oid) bad.push(oid)
      else texts.set(oid, decoder.decode(bytes))
    }
    // Bytes that are not their blob are dropped: the next plan reads them again.
    if (bad.length > 0) await store.deleteBlobs(scope, bad)
    if (missing.length + bad.length > 0) return { state: 'incomplete', missing: missing.length + bad.length }
    // A `.h` takes the language of the sources around it, as the language bar decides.
    const header = headerLanguage(record.files.map((f) => f[0]))
    let bytes = 0
    const files = record.files.map(([path, oid]): CorpusFile => {
      const text = texts.get(oid) as string
      bytes += text.length
      return { path, text, language: searchLanguageOf(path, header) }
    })
    const summary = summaryOf(record, bytes)
    this.loaded = { scope, tip, files, summary }
    await store.touch(scope)
    return { state: 'ready', summary }
  }

  private search(scope: string, tip: string, query: string, offset: number, limit: number): SearchResult {
    const loaded = this.loaded
    if (loaded === null || loaded.scope !== scope || loaded.tip !== tip) throw new Error(NOT_LOADED)
    return searchCorpus(loaded.files, parseCodeQuery(query), { offset, limit })
  }
}
