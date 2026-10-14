/**
 * The code a private repository made public publishes (mixed-visibility DESIGN §4.10 steps 0 and
 * 5), held in this tab: dg's work repository (`repo_make_public.rs` `work_repo`) as an in-memory
 * object store over the private era's plaintext packs ({@link workStoreOf}), and what dg asks git
 * for, done over that store:
 *
 * - {@link reachable}: `git rev-list --objects <tips>`, every commit, tree, blob and annotated tag
 *   reachable from the tips (gitlinks skipped), each object with the first path the walk gives it;
 * - {@link scanObjects}: dg `scan_objects`, the secret scan of the blobs reachable from the tips, or
 *   with `every` of every blob in the store (deleted and force-pushed-away history too) named by
 *   the paths any commit gives it;
 * - {@link packSize} and {@link buildPack}: the fresh public pack (`lib/merge/pack-writer.ts`, every
 *   object stored whole) and its exact size, without the objects already public.
 *
 * Unlike the merge's walk (`lib/merge/objects.ts`), nothing is refused for its content: this is
 * code members already pushed, published as it is. A repo past the caps is refused, pointing at
 * `dg repo make-public`, which builds the same with git.
 */

import { zlibSync } from 'fflate'

import { BrowseReader, MODE_GITLINK, MODE_TREE, ObjectLocator, type GitObject, type GitObjType } from '../browse'
import { IndexTooLargeError, indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { writePack, type BuiltPack } from '../merge/pack-writer'
import { findingLocation, MAX_SCAN_BYTES, scanFile, scanUnread, verdict, type Finding } from '../secrets'
import { parseCommit, parseTag, parseTree } from '../view/git-objects'
import { COPY, MakePublicError, type MakePublicSecret } from './make-public'

/** Objects the browser publishes at most; a larger repo is made public with `dg`. */
export const MAKE_PUBLIC_MAX_OBJECTS = 200_000
/** Bytes the private era's packs may decode to, all objects together. */
export const MAKE_PUBLIC_MAX_BYTES = 256 * 1024 * 1024

/** The private era's objects, as this tab holds them. */
export interface WorkStore {
  /** Every object indexed (hex oids). */
  readonly oids: ReadonlySet<string>
  /** Read one object (throws for one the store does not hold). */
  read(oid: string): Promise<GitObject>
  /** Its type, from the pack headers. */
  typeOf(oid: string): Promise<GitObjType | null>
}

/** An empty store (a repo with no code yet). */
const EMPTY: WorkStore = {
  oids: new Set(),
  read: async (oid) => {
    throw new MissingCodeError(oid)
  },
  typeOf: async () => null,
}

/** An object a walk needs is not in the store (a pack not fetched or not opened). */
export class MissingCodeError extends MakePublicError {
  constructor(readonly oid: string) {
    super(COPY.missingObject, 'E503')
    this.name = 'MissingCodeError'
  }
}

/** The too-large refusal for the repo `label`. */
export function tooLarge(label: string): MakePublicError {
  return new MakePublicError(COPY.tooLarge(label), 'E103')
}

/**
 * The store over whole plaintext `packs` (oldest first, so a thin pack meets its bases first):
 * every delta resolved by the browse indexer. Refused past {@link MAKE_PUBLIC_MAX_BYTES} or
 * {@link MAKE_PUBLIC_MAX_OBJECTS} (`label` names the repo in the copy).
 */
export async function workStoreOf(
  packs: readonly Uint8Array[],
  label: string,
  onProgress?: (indexed: number, total: number) => void,
  budget = MAKE_PUBLIC_MAX_BYTES,
): Promise<WorkStore> {
  if (packs.length === 0) return EMPTY
  let rows
  try {
    rows = await indexPacks(packs, onProgress, budget)
  } catch (e) {
    if (e instanceof IndexTooLargeError) throw tooLarge(label)
    throw e
  }
  const oids = new Set(rows.map((r) => r.oidHex))
  if (oids.size > MAKE_PUBLIC_MAX_OBJECTS) throw tooLarge(label)
  const reader = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource(packs))
  return {
    oids,
    read: async (oid) => {
      if (!oids.has(oid)) throw new MissingCodeError(oid)
      return reader.readObject(oid)
    },
    typeOf: (oid) => (oids.has(oid) ? reader.objectType(oid) : Promise.resolve(null)),
  }
}

/** An object a walk reached, and the first path it was named by (null: a commit or a tag; `''`: a root tree). */
export interface Reached {
  readonly type: GitObjType
  readonly path: string | null
}

/**
 * Every object reachable from `tips` (`git rev-list --objects`), in walk order: annotated tags
 * peeled, commits newest first by committer time, then each commit's tree depth first (a tree met
 * before is not walked again), gitlinks skipped. Each object keeps the first path it was named by.
 * An object the store lacks is a {@link MissingCodeError}, or with `skipMissing` left out and told
 * to `onMissing`. More than `cap` objects: {@link tooLarge}.
 */
export async function reachable(
  store: WorkStore,
  tips: readonly string[],
  opts: { readonly skipMissing?: boolean; readonly cap?: number; readonly label?: string; readonly onMissing?: (oid: string) => void } = {},
): Promise<Map<string, Reached>> {
  const cap = opts.cap ?? MAKE_PUBLIC_MAX_OBJECTS
  const out = new Map<string, Reached>()
  const missing = (oid: string): void => opts.onMissing?.(oid)
  const add = (oid: string, r: Reached): boolean => {
    if (out.has(oid)) return false
    if (out.size >= cap) throw tooLarge(opts.label ?? 'o/r')
    out.set(oid, r)
    return true
  }
  const read = async (oid: string): Promise<GitObject | null> => {
    if (opts.skipMissing === true && !store.oids.has(oid)) {
      missing(oid)
      return null
    }
    return store.read(oid)
  }
  const commits = new Map<string, { readonly when: number; readonly tree: string; readonly order: number }>()
  const roots: { oid: string; type: 'tree' | 'blob' }[] = []
  // tips: tags peeled, commits collected
  const pending: string[] = []
  for (const tip of tips) {
    let oid: string | null = tip
    for (let depth = 0; oid !== null && depth < 64; depth++) {
      const obj = await read(oid)
      if (obj === null) break
      if (obj.type === 'tag') {
        add(oid, { type: 'tag', path: null })
        oid = parseTag(obj.bytes)?.object ?? null
        continue
      }
      if (obj.type === 'commit') pending.push(oid)
      else roots.push({ oid, type: obj.type })
      break
    }
  }
  // every ancestor commit
  while (pending.length > 0) {
    const oid = pending.pop() as string
    if (commits.has(oid)) continue
    const obj = await read(oid)
    if (obj === null) continue
    if (obj.type !== 'commit') continue
    const c = parseCommit(obj.bytes)
    commits.set(oid, { when: c.committer.when, tree: c.tree, order: commits.size })
    if (commits.size > cap) throw tooLarge(opts.label ?? 'o/r')
    for (const p of c.parents) if (!commits.has(p)) pending.push(p)
  }
  const ordered = [...commits].sort(([, a], [, b]) => b.when - a.when || a.order - b.order)
  for (const [oid] of ordered) add(oid, { type: 'commit', path: null })
  const walkTree = async (oid: string, path: string): Promise<void> => {
    if (!add(oid, { type: 'tree', path })) return
    const obj = await read(oid)
    if (obj === null) {
      out.delete(oid)
      return
    }
    for (const e of parseTree(obj.bytes)) {
      if (e.mode === MODE_GITLINK) continue
      const child = path === '' ? e.name : `${path}/${e.name}`
      if (e.mode === MODE_TREE) await walkTree(e.oid, child)
      else if (!out.has(e.oid)) {
        if (!store.oids.has(e.oid)) {
          if (opts.skipMissing !== true) throw new MissingCodeError(e.oid)
          missing(e.oid)
          continue
        }
        add(e.oid, { type: 'blob', path: child })
      }
    }
  }
  for (const [, c] of ordered) await walkTree(c.tree, '')
  for (const r of roots) {
    if (r.type === 'tree') await walkTree(r.oid, '')
    else add(r.oid, { type: 'blob', path: '' })
  }
  return out
}

/** Whether commit `ancestor` (a tag peeled to its commit) is `tip` or one of its ancestors. */
export async function isAncestorIn(store: WorkStore, ancestor: string, tip: string): Promise<boolean> {
  let target: string | null = ancestor
  for (let depth = 0; target !== null && depth < 64; depth++) {
    if (!store.oids.has(target)) return false
    const obj: GitObject = await store.read(target)
    if (obj.type !== 'tag') break
    target = parseTag(obj.bytes)?.object ?? null
  }
  if (target === null) return false
  const seen = new Set<string>()
  const pending = [tip]
  while (pending.length > 0) {
    const oid = pending.pop() as string
    if (oid === target) return true
    if (seen.has(oid) || !store.oids.has(oid)) continue
    seen.add(oid)
    const obj = await store.read(oid)
    if (obj.type !== 'commit') continue
    pending.push(...parseCommit(obj.bytes).parents)
  }
  return false
}

/** A finding as the check reports it (dg `secret_of`). */
export function secretOf(f: Finding): MakePublicSecret {
  return { place: findingLocation(f), rule: f.rule, fingerprint: f.fingerprint, refuses: verdict(f, false).severity === 'refuse' }
}

/** "(an old object no commit names) 1a2b3c4d5": an object reached by no commit's tree. */
function unnamed(oid: string): string {
  return `(an old object no commit names) ${oid.slice(0, 9)}`
}

/**
 * Possible secrets in the blobs reachable from `tips` and, with `every`, in every blob of the store
 * (what the published keys open: deleted and force-pushed-away history too), named by the paths
 * any commit gives them (dg `scan_objects`). Blobs over the scan limit are judged by their names.
 */
export async function scanObjects(store: WorkStore, tips: readonly string[], every: boolean, label?: string): Promise<MakePublicSecret[]> {
  let blobs: { oid: string; place: string }[]
  if (every) {
    const commits: string[] = []
    const types = new Map<string, GitObjType | null>()
    for (const oid of store.oids) {
      const t = await store.typeOf(oid)
      types.set(oid, t)
      if (t === 'commit') commits.push(oid)
    }
    // every commit in the store, so a path rule (`.env`) fires on history no branch holds
    const paths = await reachable(store, commits, { skipMissing: true, ...(label !== undefined ? { label } : {}) })
    blobs = [...store.oids].filter((o) => types.get(o) === 'blob').map((oid) => ({ oid, place: paths.get(oid)?.path ?? unnamed(oid) }))
  } else {
    // what can't be read is counted by the check (`missingObjects`), which the gate refuses
    const paths = await reachable(store, tips, { skipMissing: true, ...(label !== undefined ? { label } : {}) })
    blobs = [...paths].filter(([, r]) => r.type === 'blob').map(([oid, r]) => ({ oid, place: r.path ?? unnamed(oid) }))
  }
  const out: MakePublicSecret[] = []
  for (const b of blobs) {
    const obj = await store.read(b.oid)
    const found = obj.bytes.length > MAX_SCAN_BYTES ? scanUnread(b.place, b.oid) : scanFile(b.place, obj.bytes)
    for (const f of found) out.push(secretOf(f))
  }
  return out
}

/** A pack entry's header length for an object of `size` bytes (`lib/merge/pack-writer.ts`). */
function entryHeaderLength(size: number): number {
  let n = 1
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) n++
  return n
}

/** Each object's stored size in a fresh pack, by oid (deflating is the cost: done once per object). */
export type EntrySizes = Map<string, number>

/**
 * The exact size and object count of the fresh pack of `oids` ({@link buildPack} writes the same
 * bytes): a header, each object deflated whole, the trailer. `sizes` memoises each object's entry.
 */
export async function packSize(store: WorkStore, oids: Iterable<string>, sizes: EntrySizes = new Map()): Promise<{ bytes: number; objects: number }> {
  let bytes = 12 + 20
  let objects = 0
  for (const oid of oids) {
    let n = sizes.get(oid)
    if (n === undefined) {
      const obj = await store.read(oid)
      n = entryHeaderLength(obj.bytes.length) + zlibSync(obj.bytes).length
      sizes.set(oid, n)
    }
    bytes += n
    objects++
  }
  return { bytes: objects === 0 ? 0 : bytes, objects }
}

/**
 * The fresh public pack of everything reachable from `tips` that is not reachable from `have` (the
 * tips already public, walked as far as the store holds them): every object stored whole, so the
 * pack reads on its own beside the public packs (non-thin). Null when nothing is new.
 */
export async function buildPack(store: WorkStore, tips: readonly string[], have: readonly string[], label?: string): Promise<BuiltPack | null> {
  const opts = label !== undefined ? { label } : {}
  const want = await reachable(store, tips, opts)
  const old = have.length === 0 ? new Map<string, Reached>() : await reachable(store, have, { ...opts, skipMissing: true })
  const objects: GitObject[] = []
  for (const oid of want.keys()) if (!old.has(oid)) objects.push(await store.read(oid))
  return objects.length === 0 ? null : writePack(objects)
}
