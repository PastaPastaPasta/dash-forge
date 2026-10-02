/**
 * In-repo code search, the page's side (P1-3): plan and build a ref's index from the packs the
 * browse reader already reads, and ask the search worker (`code-search.worker.ts`) to keep and
 * search it.
 *
 * Building reads every text file of the ref once, through the page's reader (each blob
 * hash-checked against its id, as on any page), in pack order so neighbouring files share their
 * chunk queries, and hands the bytes to the worker, which keeps them per repo (IndexedDB; memory
 * for a private repo). A later build of the repo reads only blobs it does not hold yet, so an index
 * of a new tip costs the files that changed; a build cut short keeps what it read.
 *
 * Bounded, and said so in the UI (`code-search-content.tsx`):
 * - files over {@link MAX_FILE_BYTES} (GitHub's code search skips large files too), binary files,
 *   symlinks and submodules are not searched;
 * - the walk lists at most {@link MAX_FILES} files, and reading stops at {@link MAX_TEXT_BYTES} of
 *   text (the 100 MB a browser materializes, `ux-dx-spec.md` §5.11);
 * - a large repo ({@link LARGE_FILES} files, or {@link LARGE_STORED_BYTES} stored) is indexed on its
 *   default branch only, one index kept, and a build is never started without the viewer's say;
 *   a small one may be built at once when it reads little ({@link AUTO_BUILD_BYTES}).
 *
 * Searching a built index sends no request: the worker holds the text.
 */

import { ObjectTooLargeError, SPAN_SENTINEL } from '../browse'
import { storedMaxBytes } from '../browse/pack'
import { ACTIVE_NETWORK } from '../constants'
import { repoKey, type RepoRef } from '../repo/contract'
import { onPrivateSessionEnded } from '../repo/private-session'
import type { SearchResult } from './code-match'
import type { CodeIndexRecord, SkipReason, StoredKind } from './code-index-store'
import { isBinary, NOT_LOADED, type AddedBlob, type CodeIndexRequest, type CodeIndexSummary, type OpenResult } from './code-index-host'
import { treeWalker } from './commit-log'
import { mapPooled } from './pool'
import { extensionOf } from './languages'
import { repoFilesWalk } from './repo-facts'
import { rootTreeOf, type PeeledTip } from './tip'
import type { ObjectReader } from './tree-nav'
import { walkFiles, type FileWalk } from './zip'

/** Files larger than this are not searched (GitHub's code search leaves out files over 350 KiB). */
export const MAX_FILE_BYTES = 384 * 1024
/** Text read into one index, at most: what a browser tab materializes (`ux-dx-spec.md` §5.11). */
export const MAX_TEXT_BYTES = 100 * 1024 * 1024
/** Files the walk lists for an index (and trees it reads to find them). */
export const MAX_FILES = 25_000
const MAX_TREES = 25_000
/** A repo is large past this many searchable files, or {@link LARGE_STORED_BYTES} stored. */
export const LARGE_FILES = 2_000
export const LARGE_STORED_BYTES = 16 * 1024 * 1024
/** An index that reads at most this much (and is not large) is built without asking. */
export const AUTO_BUILD_BYTES = 4 * 1024 * 1024
/** Indexes kept per repo: a few refs of a small repo; the default branch's one of a large repo. */
const KEEP_INDEXES = 4
const KEEP_INDEXES_LARGE = 1
/** Blob reads in flight while building (neighbours in the pack share their chunk queries). */
const READ_POOL = 16
/** Bytes, or files, handed to the worker at a time. */
const ADD_BATCH_BYTES = 2 * 1024 * 1024
const ADD_BATCH_FILES = 128
/** A search the worker has not answered in this long is stopped (a regular expression that backtracks without end). */
const SEARCH_TIMEOUT_MS = 20_000

/** Extensions never read: their files are binary (git's own test, after reading, catches the rest). */
const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif bmp ico icns webp tif tiff psd xcf ai sketch heic avif ' +
    'pdf zip gz tgz bz2 xz zst 7z rar tar jar war ear apk ipa dmg iso deb rpm msi ' +
    'exe dll so dylib a o obj lib class pyc pyo wasm bin dat raw db sqlite sqlite3 ' +
    'woff woff2 ttf otf eot mp3 mp4 m4a mov avi mkv webm wav ogg flac aac ' +
    'pack idx keystore p12 der'
  ).split(' '),
)

/** What an index is built for: a repo's ref tip, and where it is kept. */
export interface CodeSearchTarget {
  /** Per network and repo; a private repo's names its decryption session too. */
  readonly scope: string
  /** Kept in IndexedDB (public) or the worker's memory only (private). */
  readonly persist: boolean
  /** The ref's tip (a commit, or an annotated tag). */
  readonly tip: string
  /** The ref's name as shown (`develop`). */
  readonly ref: string
  /** The ref is the default branch (a large repo is searched there only). */
  readonly defaultBranch: boolean
}

/** Private scopes this tab made, dropped from the worker when their session ends. */
const privateScopes = new Set<string>()

export function codeSearchTarget(repo: RepoRef, tip: string, ref: string, defaultBranch: boolean): CodeSearchTarget {
  const persist = repo.visibility !== 'private'
  const scope = `${ACTIVE_NETWORK.key}:${persist ? repo.repoId : repoKey(repo)}`
  if (!persist) privateScopes.add(scope)
  return { scope, persist, tip, ref, defaultBranch }
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** Something that answers {@link CodeIndexRequest}s: the worker, or a host in-process (tests). */
export interface CodeIndexPort {
  request<T>(req: CodeIndexRequest, transfer?: Transferable[]): Promise<T>
}

type Reply = { readonly id: number; readonly ok: true; readonly result: unknown } | { readonly id: number; readonly ok: false; readonly error: string }

/** The search worker, started on first use and kept for the tab (it holds the loaded index). */
class WorkerPort implements CodeIndexPort {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, { readonly search: boolean; resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /**
   * When the worker last answered (or was handed work while idle). Searches queue in the worker,
   * so a search is timed by how long the worker has been silent, not by how long it has waited.
   */
  private lastHeard = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  private start(): Worker {
    if (this.worker !== null) return this.worker
    const worker = new Worker(new URL('./code-search.worker.ts', import.meta.url))
    worker.onmessage = (ev: MessageEvent<Reply>) => {
      this.lastHeard = Date.now()
      const p = this.pending.get(ev.data.id)
      if (p === undefined) return
      this.pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.result)
      else p.reject(new Error(ev.data.error))
    }
    worker.onerror = (ev) => this.fail(new Error(ev.message || 'the code search worker failed'))
    this.worker = worker
    return worker
  }

  /** Stop the worker: every request waiting fails with `error`; the next one starts it afresh. */
  private fail(error: Error): void {
    this.worker?.terminate()
    this.worker = null
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }

  /** While a search waits: stop a worker silent for {@link SEARCH_TIMEOUT_MS} (a regex that backtracks without end). */
  private watch(): void {
    if (this.watchdog !== null) return
    this.watchdog = setInterval(() => {
      const searching = [...this.pending.values()].some((p) => p.search)
      if (searching && Date.now() - this.lastHeard > SEARCH_TIMEOUT_MS) this.fail(new SearchTimeoutError())
      if (!searching && this.watchdog !== null) {
        clearInterval(this.watchdog)
        this.watchdog = null
      }
    }, 1000)
  }

  request<T>(req: CodeIndexRequest, transfer: Transferable[] = []): Promise<T> {
    const worker = this.start()
    const id = this.nextId++
    if (this.pending.size === 0) this.lastHeard = Date.now()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { search: req.op === 'search', resolve: resolve as (v: unknown) => void, reject })
      if (req.op === 'search') this.watch()
      worker.postMessage({ id, req }, transfer)
    })
  }
}

/** The worker stopped a search that ran too long; the index is loaded again on the next one. */
export class SearchTimeoutError extends Error {
  constructor() {
    super('The search worker was silent for 20 seconds and was stopped. A regular expression that backtracks heavily can do this: try a simpler one.')
    this.name = 'SearchTimeoutError'
  }
}

let port: CodeIndexPort | null = null

/** The tab's search worker. */
export function codeIndexPort(): CodeIndexPort {
  port ??= new WorkerPort()
  return port
}

/** Test hook: answer requests with `p` instead of the worker. */
export function setCodeIndexPort(p: CodeIndexPort | null): void {
  port = p
}

onPrivateSessionEnded((id) => {
  for (const scope of [...privateScopes]) {
    if (!scope.endsWith(`#${id}`)) continue
    privateScopes.delete(scope)
    if (port !== null) void port.request({ op: 'drop', scope }).catch(() => undefined)
  }
})

/** Load the index of the target's tip, if one is kept: no request beyond the worker. */
export function openCodeIndex(target: CodeSearchTarget): Promise<OpenResult> {
  return codeIndexPort().request({ op: 'open', scope: target.scope, persist: target.persist, tip: target.tip })
}

/** The newest index kept of the target's ref at another tip (a ref that moved since), or null. */
export function latestCodeIndex(target: CodeSearchTarget): Promise<CodeIndexSummary | null> {
  return codeIndexPort().request({ op: 'latest', scope: target.scope, persist: target.persist, ref: target.ref })
}

/**
 * Search the loaded index of `tip` (opened with {@link openCodeIndex} or built). The worker holds
 * one index: when another was opened since, or the worker was restarted (a search that ran too
 * long), this one is loaded again first, from what the worker keeps.
 */
export async function searchCode(target: CodeSearchTarget, tip: string, query: string, offset: number, limit: number): Promise<SearchResult> {
  const p = codeIndexPort()
  const run = (): Promise<SearchResult> => p.request({ op: 'search', scope: target.scope, tip, query, offset, limit })
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof Error) || e.message !== NOT_LOADED) throw e
    const opened = await p.request<OpenResult>({ op: 'open', scope: target.scope, persist: target.persist, tip })
    if (opened.state !== 'ready') throw new Error('This browser no longer holds the index. Reload the page to build it again.')
    return run()
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** A file of the tree to search: its stored size from the locator, and whether it is a delta. */
export interface PlanFile {
  readonly path: string
  readonly oid: string
  readonly size: number
  readonly delta: boolean
  /** About how many bytes reading it takes (its entry, or a delta's whole chain); 0 when not known. */
  readonly read: number
}

export interface CodeIndexPlan {
  readonly target: CodeSearchTarget
  readonly commit: string | null
  readonly tree: string
  /** The files the index will search (those already kept included). */
  readonly files: readonly PlanFile[]
  /** Files of the tree left out before any is read, by reason. */
  readonly skipped: Readonly<Record<SkipReason, number>>
  /** Files kept from an earlier build (none of them is read again). */
  readonly cached: number
  /** The files to read, in pack order. */
  readonly toRead: readonly PlanFile[]
  /** About how many bytes reading them takes (stored sizes, a delta's whole chain). */
  readonly readBytes: number
  /**
   * Files stored as deltas whose chain the index cannot size (a sentinel span): {@link readBytes}
   * counts only their own entry, so it is a lower bound, and the build is never started unasked.
   */
  readonly unsized: number
  /** Paths whose blob is read (several paths can share one blob). */
  readonly readPaths: number
  /** Stored bytes of every file to search: a lower bound of the text they hold. */
  readonly storedBytes: number
  /** The walk stopped at {@link MAX_FILES}. */
  readonly truncated: boolean
  /** A large repo: default branch only, never built without asking. */
  readonly large: boolean
  /** More text than a browser index holds ({@link MAX_TEXT_BYTES}): clone instead. */
  readonly tooLarge: boolean
}

/** Whether a plan may be built for its target: a large repo's index is of its default branch only. */
export function planAllowed(plan: Pick<CodeIndexPlan, 'large' | 'tooLarge' | 'target'>): boolean {
  return !plan.tooLarge && (!plan.large || plan.target.defaultBranch)
}

/** Whether a plan is small enough to build without asking. */
export function planAutoBuilds(plan: CodeIndexPlan): boolean {
  return planAllowed(plan) && !plan.large && plan.unsized === 0 && plan.readBytes <= AUTO_BUILD_BYTES
}

/**
 * Every file of `tip`'s tree, from the walk Go to file and the language bar share when it saw the
 * whole tree, else from a walk of its own with a higher bound ({@link MAX_FILES}).
 */
async function walkTree(reader: ObjectReader, repoKeyOf: string, tip: string, tree: string, signal?: AbortSignal): Promise<FileWalk> {
  const shared = await repoFilesWalk(repoKeyOf, tip, reader, tree)
  if (!shared.truncated) return shared
  signal?.throwIfAborted()
  const walker = treeWalker(reader)
  try {
    return await walkFiles(walker, tree, { maxFiles: MAX_FILES, maxTrees: MAX_TREES })
  } finally {
    walker.flush?.()
  }
}

/**
 * What indexing `tip` takes: its tree walked (tree reads, and the object index for every file's
 * stored size), the files left out by name or size, and of the rest those the worker does not
 * hold yet, in pack order. No blob is read.
 */
export async function planCodeIndex(
  reader: ObjectReader,
  repo: RepoRef,
  target: CodeSearchTarget,
  tip: PeeledTip,
  { signal, indexPort = codeIndexPort() }: { readonly signal?: AbortSignal; readonly indexPort?: CodeIndexPort } = {},
): Promise<CodeIndexPlan> {
  const tree = await rootTreeOf(reader, tip)
  const walk = await walkTree(reader, repoKey(repo), tip.oid, tree, signal)
  signal?.throwIfAborted()
  const skipped: Record<SkipReason, number> = { binary: 0, large: 0, symlink: 0 }
  const candidates: PlanFile[] = []
  const tooBig = storedMaxBytes(MAX_FILE_BYTES)
  for (const f of walk.files) {
    if ((f.mode & 0o170000) === 0o120000) skipped.symlink += 1
    else if (BINARY_EXTENSIONS.has(extensionOf(f.path))) skipped.binary += 1
    // A whole-stored entry this long cannot inflate to a file under the limit.
    else if (f.delta !== true && f.size > tooBig) skipped.large += 1
    else candidates.push({ path: f.path, oid: f.oid, size: f.size, delta: f.delta === true, read: 0 })
  }
  const kept = new Map(await indexPort.request<[string, StoredKind][]>({ op: 'stored', scope: target.scope, persist: target.persist, oids: [...new Set(candidates.map((c) => c.oid))] }))
  // A blob an earlier build found binary or too large is left out again, unread.
  const files = candidates.filter((c) => {
    const kind = kept.get(c.oid)
    if (kind === 'binary' || kind === 'large') skipped[kind] += 1
    return kind !== 'binary' && kind !== 'large'
  })
  const unread = new Map<string, PlanFile>()
  for (const f of files) if (!kept.has(f.oid)) unread.set(f.oid, f)
  // Pack order: reads of neighbouring blobs gather into the same chunk queries.
  const located = await Promise.all(
    [...unread.values()].map(async (f) => {
      const entry = await reader.locate?.(f.oid).catch(() => null)
      const unsized = entry != null && entry.deltaDepth > 0 && entry.deltaChainSpan === SPAN_SENTINEL
      const read = entry == null ? f.size : entry.deltaDepth > 0 && !unsized ? entry.deltaChainSpan : entry.length
      return { f: { ...f, read }, unsized, pack: entry?.packRef ?? Number.MAX_SAFE_INTEGER, offset: entry?.offset ?? 0 }
    }),
  )
  located.sort((a, b) => a.pack - b.pack || a.offset - b.offset)
  const storedBytes = files.reduce((n, f) => n + f.size, 0)
  return {
    target,
    commit: tip.type === 'commit' ? tip.oid : null,
    tree,
    files,
    skipped,
    cached: files.filter((f) => kept.get(f.oid) === 'text').length,
    toRead: located.map((l) => l.f),
    readBytes: located.reduce((n, l) => n + l.f.read, 0),
    unsized: located.filter((l) => l.unsized).length,
    readPaths: files.filter((f) => unread.has(f.oid)).length,
    storedBytes,
    truncated: walk.truncated,
    large: files.length > LARGE_FILES || storedBytes > LARGE_STORED_BYTES,
    tooLarge: storedBytes > MAX_TEXT_BYTES,
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildProgress {
  /** Files read, of {@link total}. */
  readonly files: number
  readonly total: number
  /** About how many bytes were read, of about {@link CodeIndexPlan.readBytes}. */
  readonly bytes: number
  /** Text bytes held. */
  readonly text: number
}

/** The build was refused for its target (a large repo off its default branch, or too much text). */
export class CodeIndexRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodeIndexRefusedError'
  }
}

interface BuildOptions {
  readonly onProgress?: (p: BuildProgress) => void
  readonly signal?: AbortSignal
  readonly indexPort?: CodeIndexPort
  readonly now?: () => number
  /** The text cap ({@link MAX_TEXT_BYTES}; tests lower it). */
  readonly maxTextBytes?: number
}

/**
 * Read the plan's files (hash-checked by the reader), hand them to the worker as they arrive, and
 * store the index; resolves with it loaded for searching. Cancelled through `signal`, what was read
 * is kept (the next build skips it). A file larger than {@link MAX_FILE_BYTES} once inflated, or
 * binary, is left out; past {@link MAX_TEXT_BYTES} of text the rest are left out (`capped`).
 */
export async function buildCodeIndex(
  reader: ObjectReader,
  plan: CodeIndexPlan,
  { onProgress, signal, indexPort = codeIndexPort(), now = Date.now, maxTextBytes = MAX_TEXT_BYTES }: BuildOptions = {},
): Promise<CodeIndexSummary> {
  if (!planAllowed(plan)) {
    throw new CodeIndexRefusedError(
      plan.tooLarge ? 'This ref holds more text than a browser index can (100 MiB). Clone the repo and use git grep.' : 'Content search on a repo this large covers its default branch only.',
    )
  }
  const { target } = plan
  const skipped: Record<SkipReason, number> = { ...plan.skipped }
  /** Blobs left out of the index (binary, too large, past the text cap). */
  const left = new Set<string>()
  const reading = new Set(plan.toRead.map((f) => f.oid))
  // Text kept from earlier builds counts toward the cap (its stored size: a lower bound).
  let text = plan.files.filter((f) => !reading.has(f.oid)).reduce((n, f) => n + f.size, 0)
  let capped = false
  let done = 0
  let bytes = 0
  let batch: AddedBlob[] = []
  let batchBytes = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const sending = batch
    batch = []
    batchBytes = 0
    await indexPort.request({ op: 'add', scope: target.scope, persist: target.persist, blobs: sending }, sending.flatMap((b) => (b.bytes ? [b.bytes.buffer as ArrayBuffer] : [])))
  }
  const walker = treeWalker(reader)
  try {
    await mapPooled(plan.toRead, READ_POOL, async (f) => {
      signal?.throwIfAborted()
      if (capped) {
        left.add(f.oid)
        return
      }
      let added: AddedBlob
      try {
        const obj = await walker.readObject(f.oid, { maxBytes: MAX_FILE_BYTES })
        // A copy: the reader keeps `obj.bytes` in its memo, and the transfer detaches what it sends.
        const copy = obj.bytes.slice()
        added = isBinary(copy) ? { oid: f.oid, skip: 'binary' } : { oid: f.oid, bytes: copy }
      } catch (e) {
        if (!(e instanceof ObjectTooLargeError)) throw e
        added = { oid: f.oid, skip: 'large' }
      }
      if (added.bytes !== undefined && text + added.bytes.length > maxTextBytes) {
        capped = true
        left.add(f.oid)
        return
      }
      text += added.bytes?.length ?? 0
      if (added.skip !== undefined) {
        skipped[added.skip] += 1
        left.add(f.oid)
      }
      batch.push(added)
      batchBytes += added.bytes?.length ?? 0
      done += 1
      bytes += f.read
      onProgress?.({ files: done, total: plan.toRead.length, bytes, text })
      if (batchBytes >= ADD_BATCH_BYTES || batch.length >= ADD_BATCH_FILES) await flush()
    })
  } finally {
    walker.flush?.()
    // What was read is kept even when the build stops: the next one starts from there.
    await flush().catch(() => undefined)
  }
  const record: CodeIndexRecord = {
    tip: target.tip,
    commit: plan.commit,
    tree: plan.tree,
    ref: target.ref,
    files: plan.files.filter((f) => !left.has(f.oid)).map((f) => [f.path, f.oid] as const),
    skipped,
    truncated: plan.truncated,
    capped,
    large: plan.large,
    builtAt: now(),
  }
  const opened = await indexPort.request<OpenResult>({ op: 'commit', scope: target.scope, persist: target.persist, record, keep: plan.large ? KEEP_INDEXES_LARGE : KEEP_INDEXES })
  if (opened.state !== 'ready') throw new Error('The index was stored but could not be loaded: some of its files went missing. Build it again.')
  return opened.summary
}
