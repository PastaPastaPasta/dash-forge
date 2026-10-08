/**
 * Reading a repository's environments in the browser: every kind-8 manifest and the current
 * maintainers, then every snapshot a current maintainer wrote, fetched, checked against its
 * manifest's `packHash` and opened (an old-format Members snapshot under the members key, every
 * other with this browser's encryption keys), then {@link resolveSnapshots} (strict D24). The
 * twin of forge-core `env::service::Environments::read` and its `Book`: the same inputs give
 * `dg env ls`'s answer.
 *
 * Nothing here is kept: the caller holds the {@link EnvBook} in memory for as long as it shows it.
 * The I/O is injected ({@link EnvSources}, {@link EnvKeys}); `sources.ts` binds it to the SDK.
 */

import {
  artifactHeaderLength,
  manifestStanding,
  parseHeader,
  privateId,
  type EpochKeyring,
  type EpochResolution,
  type LetterReader,
  type OwnerKey,
} from '../private'
import { mapPooled } from '../view/pool'
import { exposureOf, resolveSnapshots, type EnvState, type Exposure, type Resolution, type SnapshotRef } from './chain'
import { openSnapshot, SnapshotOpenError, openErrorReason, type OpenErrorCode } from './codec'
import { MAX_RECIPIENTS, MAX_SNAPSHOT, compareStrings as cmp, membersKey, type Snapshot } from './format'

/** One kind-8 `packManifest`, as the reader keeps it. */
export interface EnvManifest extends SnapshotRef {
  /** `$createdAt` (ms). */
  readonly createdAt: number
  /** The sealed size its owner recorded. */
  readonly sizeBytes: number
}

/** What one authorized snapshot came to for this reader. */
export type Opened =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly kind: 'refused'; readonly code: OpenErrorCode }
  | { readonly kind: 'unfetched'; readonly message: string }
  /** An old-format Members snapshot under a members key its author could no longer use when it was saved (§8.2). */
  | { readonly kind: 'late' }
  /** Not fetched: this reader holds nothing that could open it (a signed-out or locked viewer). */
  | { readonly kind: 'skipped' }

/** Why an opened-or-not snapshot cannot be read, for a person. */
export function openedReason(o: Opened): string {
  switch (o.kind) {
    case 'snapshot':
      return ''
    case 'refused':
      return openErrorReason(o.code)
    case 'unfetched':
      return `it could not be fetched (${o.message})`
    case 'late':
      return 'it was saved under a members key after that key was replaced'
    case 'skipped':
      return "you don't hold a key that opens it here"
  }
}

/** Every environment of a repository as one reader sees it (forge-core `Book`). */
export interface EnvBook {
  /** The current maintainers (base58). */
  readonly maintainers: ReadonlySet<string>
  /** Every kind-8 manifest. */
  readonly manifests: readonly EnvManifest[]
  /** What each authorized snapshot came to, by manifest document id. */
  readonly opened: ReadonlyMap<string, Opened>
  /**
   * The authorized snapshots stored in the old format (DFPK 0x01, under the members key), by
   * manifest document id, whether or not they opened here.
   */
  readonly oldFormat: ReadonlySet<string>
  readonly resolution: Resolution
}

/** The largest sealed snapshot: the biggest bucket under the widest header, plus its tag (forge-core `MAX_SEALED`). */
export const MAX_SEALED = MAX_SNAPSHOT + artifactHeaderLength(MAX_RECIPIENTS) + 16

/** The reads the loader makes (bound to the SDK in `sources.ts`). */
export interface EnvSources {
  /** Every kind-8 manifest of the repository. */
  readonly manifests: () => Promise<readonly EnvManifest[]>
  /** The current maintainers (base58). */
  readonly maintainers: () => Promise<readonly string[]>
  /** One manifest's stored bytes (not yet checked against its `packHash`). */
  readonly fetch: (m: EnvManifest) => Promise<Uint8Array>
  /** An identity's public keys (`[]` when it does not exist). */
  readonly ownerKeys: (identityId: string) => Promise<readonly OwnerKey[]>
}

/** What the reader opens with. */
export interface EnvKeys {
  /** The repository id (32 bytes). */
  readonly repoId: Uint8Array
  /** The members key chain this viewer holds (`null`: none, or not unlocked). */
  readonly members: { readonly keys: EpochKeyring; readonly resolution: EpochResolution } | null
  /**
   * Runs `use` with this viewer's identity and ENCRYPTION secrets, wiped afterwards (`null`
   * when there is no unlocked encryption key in this browser).
   */
  readonly withReader: <T>(use: (reader: LetterReader | null) => Promise<T>) => Promise<T>
  /** Whether {@link withReader} can give a reader: otherwise only the members key opens anything. */
  readonly hasReader: boolean
}

/** The DFPK version byte of an old-format Members snapshot (a pack) and of a letter (to specific people). */
const PACK_VERSION = 0x01
const LETTER_VERSION = 0x02

/** Artifacts fetched at once (forge-core `FETCH_WINDOW`). */
const FETCH_WINDOW = 8

/** `(height, id)`: the order the chain reads manifests in. */
function chainOrder(a: EnvManifest, b: EnvManifest): number {
  return a.height - b.height || cmp(a.id, b.id)
}

/** The authorized manifests: a current maintainer's, the first of each `packHash`, in chain order. */
export function authorized(manifests: readonly EnvManifest[], maintainers: ReadonlySet<string>): EnvManifest[] {
  const seen = new Set<string>()
  return [...manifests].sort(chainOrder).filter((m) => {
    if (!maintainers.has(m.ownerId) || seen.has(m.packHash)) return false
    seen.add(m.packHash)
    return true
  })
}

/**
 * Whether `bytes`, a Members (DFPK 0x01) snapshot, is late content: sealed under an epoch its
 * owner could no longer write when the manifest landed. A manifest with no block height cannot be
 * judged and is late (forge-core `Opener::late`).
 */
function isLate(members: EnvKeys['members'], m: EnvManifest, bytes: Uint8Array): boolean {
  if (members === null || bytes[4] !== PACK_VERSION) return false
  let epoch: number
  let owner: Uint8Array
  try {
    epoch = parseHeader(bytes).epoch
    owner = privateId(m.ownerId)
  } catch {
    return false
  }
  return m.height === 0 || !manifestStanding(members.resolution, epoch, m.height, owner).readable
}

/**
 * Read every environment ({@link EnvBook}). A snapshot by anyone but a current maintainer is
 * never fetched or opened (D24). When this viewer holds nothing that could open a snapshot,
 * nothing is fetched: every environment is then counted, never named. `open` is the codec's
 * {@link openSnapshot}; the vector test replaces it to replay `env_snapshot__*` resolutions.
 */
export async function readEnvironments(sources: EnvSources, keys: EnvKeys, open: typeof openSnapshot = openSnapshot): Promise<EnvBook> {
  const [manifests, list] = await Promise.all([sources.manifests(), sources.maintainers()])
  const maintainers = new Set(list)
  const counted = authorized(manifests, maintainers)
  const opened = new Map<string, Opened>()
  const oldFormat = new Set<string>()
  if (keys.members === null && !keys.hasReader) {
    for (const m of counted) opened.set(m.id, { kind: 'skipped' })
  } else {
    // the bytes, or what the snapshot came to without them (never rejects)
    const fetched = await mapPooled(counted, FETCH_WINDOW, async (m): Promise<Uint8Array | Opened> => {
      // larger than any snapshot can be: refused unfetched, as the codec would refuse it
      if (m.sizeBytes > MAX_SEALED) return { kind: 'refused', code: 'sizeMismatch' }
      try {
        return await sources.fetch(m)
      } catch (e) {
        return { kind: 'unfetched', message: e instanceof Error ? e.message : String(e) }
      }
    })
    // a letter's sender key comes from its manifest owner's identity only
    const owners = [...new Set(counted.filter((_, i) => { const b = fetched[i]; return b instanceof Uint8Array && b[4] === LETTER_VERSION }).map((m) => m.ownerId))]
    const ownerKeys = new Map<string, readonly OwnerKey[]>(await Promise.all(owners.map(async (o) => [o, await sources.ownerKeys(o)] as const)))
    const epochKeys: EpochKeyring = keys.members?.keys ?? new Map()
    await keys.withReader(async (reader) => {
      for (const [i, m] of counted.entries()) {
        const bytes = fetched[i] as Uint8Array | Opened
        if (!(bytes instanceof Uint8Array)) {
          opened.set(m.id, bytes)
          continue
        }
        if (isLate(keys.members, m, bytes)) {
          opened.set(m.id, { kind: 'late' })
          continue
        }
        try {
          const snapshot = await open(m, bytes, { repoId: keys.repoId, ownerKeys: ownerKeys.get(m.ownerId) ?? [], reader, epochKeys })
          opened.set(m.id, { kind: 'snapshot', snapshot })
        } catch (e) {
          if (!(e instanceof SnapshotOpenError)) throw e
          opened.set(m.id, { kind: 'refused', code: e.code })
        }
      }
    })
  }
  // old format: a DFPK 0x01 copy that passed the packHash and size checks (it opened, or failed
  // only for want of a key), never a damaged copy
  for (const m of counted) {
    const o = opened.get(m.id)
    if ((o?.kind === 'snapshot' && membersKey(o.snapshot)) || (o?.kind === 'refused' && o.code === 'noKey') || o?.kind === 'late') oldFormat.add(m.id)
  }
  const envByHash = new Map<string, string>()
  for (const m of counted) {
    const o = opened.get(m.id)
    if (o?.kind === 'snapshot') envByHash.set(m.packHash, o.snapshot.env)
  }
  const resolution = resolveSnapshots(maintainers, manifests, (h) => envByHash.get(h) ?? null)
  return { maintainers, manifests, opened, oldFormat, resolution }
}

/** A head, as a conflict or a warning names it. */
export interface Head {
  /** The snapshot's manifest document id. */
  readonly id: string
  /** Who wrote it (base58). */
  readonly author: string
  /** When (`$createdAt`, ms). */
  readonly createdAt: number
}

/** The id prefix people type (`--keep`). */
export function shortHead(h: Head): string {
  return h.id.slice(0, 10)
}

/** Why an environment's values cannot be used (forge-core `Blocked`). */
export type Blocked =
  | { readonly kind: 'missing'; readonly hidden: number }
  | { readonly kind: 'conflict'; readonly heads: readonly Head[]; readonly split: boolean }
  | { readonly kind: 'unreadable'; readonly head: Head; readonly reason: string; readonly unfetched: boolean }

function manifestOf(book: EnvBook, id: string): EnvManifest | undefined {
  return book.manifests.find((m) => m.id === id)
}

export function headOf(book: EnvBook, id: string): Head {
  const m = manifestOf(book, id)
  return { id, author: m?.ownerId ?? '', createdAt: m?.createdAt ?? 0 }
}

/** The snapshot of manifest `id`, when it opened. */
export function snapshotOf(book: EnvBook, id: string): Snapshot | null {
  const o = book.opened.get(id)
  return o?.kind === 'snapshot' ? o.snapshot : null
}

export function stateOf(book: EnvBook, env: string): EnvState | undefined {
  return book.resolution.environments.find((e) => e.env === env)
}

function unreadable(book: EnvBook, id: string): Blocked {
  const o = book.opened.get(id)
  return { kind: 'unreadable', head: headOf(book, id), reason: o === undefined ? '' : openedReason(o), unfetched: o?.kind === 'unfetched' }
}

/** Whether `state`'s heads share no earlier counted version (separate histories). */
export function isSplit(book: EnvBook, state: EnvState): boolean {
  const inEnv = new Map<string, EnvManifest>()
  for (const id of state.snapshots) {
    const m = manifestOf(book, id)
    if (m !== undefined) inEnv.set(m.packHash, m)
  }
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>()
    const todo = [manifestOf(book, id)].filter((m): m is EnvManifest => m !== undefined)
    for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
      for (const h of m.supersedes) {
        const p = inEnv.get(h)
        if (p !== undefined && p.height < m.height && !seen.has(h)) {
          seen.add(h)
          todo.push(p)
        }
      }
    }
    return seen
  }
  const sets = state.heads.map(ancestors)
  const first = sets[0]
  if (first === undefined) return false
  return [...first].filter((h) => sets.every((s) => s.has(h))).length === 0
}

/** The values of `env`, or why they cannot be used: a conflict and an unreadable head fail closed (D24). */
export function currentOf(book: EnvBook, env: string): { readonly ok: true; readonly snapshot: Snapshot } | { readonly ok: false; readonly blocked: Blocked } {
  const state = stateOf(book, env)
  if (state === undefined) return { ok: false, blocked: { kind: 'missing', hidden: book.resolution.hidden.length } }
  const head = state.heads[0] as string
  if (state.state === 'current') {
    const s = snapshotOf(book, head)
    return s === null ? { ok: false, blocked: unreadable(book, head) } : { ok: true, snapshot: s }
  }
  if (state.state === 'unreadable') return { ok: false, blocked: unreadable(book, head) }
  return { ok: false, blocked: { kind: 'conflict', heads: state.heads.map((h) => headOf(book, h)), split: isSplit(book, state) } }
}

/** The ignored manifests (by people who are not maintainers now) naming a head of `env` from a higher block. */
export function ignoredNewerOf(book: EnvBook, env: string): Head[] {
  return (stateOf(book, env)?.ignoredNewer ?? []).map((id) => headOf(book, id))
}

/** How many changes by people who aren't maintainers now were ignored (`dg env ls`'s "Ignored:" line). */
export function ignoredCount(book: EnvBook): number {
  return book.resolution.ignored.filter((i) => i.reason === 'notAMaintainer').length
}

/**
 * The removal checklist for `removed` (base58), who held the members key when `heldMembersKey`:
 * the environments and current value names they could read (forge-core `Book::exposure`).
 */
export function exposureFor(book: EnvBook, removed: string, heldMembersKey: boolean): Exposure[] {
  const pick = (ids: readonly string[]) => ids.map((id) => snapshotOf(book, id)).filter((s): s is Snapshot => s !== null)
  return exposureOf(
    book.resolution.environments.map((e) => ({ env: e.env, heads: pick(e.heads), snapshots: pick(e.snapshots) })),
    removed,
    heldMembersKey,
  )
}

/** What the old format left in one environment ({@link oldFormatOf}). */
export interface OldFormat {
  /** Its latest version is in the old format. */
  readonly latest: boolean
  /** Names held in old-format versions, not marked changed since (sorted). */
  readonly unmarked: readonly string[]
  /** Old-format versions this reader can't open (their names are unknown here). */
  readonly unopened: number
}

/**
 * What the old format left in `env` (DESIGN §4.5, §10): whether its latest version is an
 * old-format Members snapshot, the names held in its old-format snapshots this reader opened that
 * are not marked changed in the latest version, and how many old-format snapshots did not open
 * here. `null` when it has none (forge-core `Book::old_format_of`).
 */
export function oldFormatOf(book: EnvBook, env: string): OldFormat | null {
  const state = stateOf(book, env)
  if (state === undefined) return null
  const old = state.snapshots.filter((id) => book.oldFormat.has(id))
  if (old.length === 0) return null
  const latest = state.heads.some((h) => book.oldFormat.has(h))
  const newest = state.heads[state.heads.length - 1]
  const head = newest === undefined ? null : snapshotOf(book, newest)
  // what is marked is in the latest version: a reader who can't open it can't tell
  if (head === null) return { latest, unmarked: [], unopened: 0 }
  const marked = new Set(head.markedChanged)
  const unmarked = new Set<string>()
  let unopened = 0
  for (const id of old) {
    const s = snapshotOf(book, id)
    if (s === null) unopened++
    else for (const name of s.vars.keys()) if (!marked.has(name)) unmarked.add(name)
  }
  return { latest, unmarked: [...unmarked].sort(cmp), unopened }
}

/** Whether the banner is shown: the latest version is old, or old values may still be in use. */
export function needsAttention(o: OldFormat): boolean {
  return o.latest || o.unmarked.length > 0 || o.unopened > 0
}

/** Environments this reader cannot read at all: hidden ones and those whose latest change does not open here. */
export function unreadableCount(book: EnvBook): number {
  return book.resolution.hidden.length + book.resolution.environments.filter((e) => e.state === 'unreadable').length
}
