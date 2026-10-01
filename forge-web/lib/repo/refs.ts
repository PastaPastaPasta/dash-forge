/**
 * Ref reads — branch/tag enumeration + tip resolution (`forge-v2.md` §2).
 *
 * Every ref's complete update history comes from a **keyset scan** over the `refState` index
 * (`refNameHash, $createdAt`): pages of `refNameHash > last`, 100 rows each, with no
 * `startAfter` cursor. Every ref on a full page except the last is complete; the next page
 * starts after the last complete ref. A ref that fills a page by itself is read on its own
 * (an equality query, single-branch) and the scan moves past it. When the first page is full,
 * the rest of the key space is scanned as up to {@link KEYSET_SPLITS} ranges side by side, sized
 * from how far that page reached ({@link keysetSplits}). Cost: ⌈updates/100⌉ queries per type,
 * plus one per page-filling ref, plus at most one page per extra range (each range's last page
 * reads past its ceiling). Parity: forge-core `refs::read_all_ref_updates` (serial).
 *
 * WHY NO CURSOR: paging `refState` with `startAfter` lost rows on protocol 13 — 32 of 229
 * updates on the old nightly repo. Drive's v0 lowering applies the cursor document's
 * lower-level bounds to every sibling `refNameHash` branch, not only the cursor's own, so a
 * page omits rows from later refs and can come back short (the only end-of-data signal a
 * pager has). Same family as dashpay/platform#4396; the orderBy-only shape is still unfixed
 * there. A range where-clause carries no cursor document, so nothing leaks.
 *
 * WHEN THE SCAN IS NOT TRUSTED: the scan is abandoned and the answer comes from the
 * `$createdAt` (`reflog`) read of both types ALONE, deduplicated by `$id`, when a page is out
 * of `refNameHash` order, holds a row at or below its `> last` bound, or would not advance
 * `last` (the node did not honor the query), or when the completeness check fails: every
 * non-null `prevOid` a pusher records is some earlier update's `newOid` in the same ref, so a
 * dangling one means a row is missing (or was written dangling on purpose — which costs the
 * extra read, never the answer).
 *
 * LIMITS (same as forge-core `refs`, whose module doc has the detail): the check sees only
 * mid-chain gaps — a missing newest update or a wholly missing ref leaves no dangling
 * `prevOid`. And a ref with more than a page of updates is read by `==` paged with
 * `startAfter`: single-branch, so no sibling drop (and protocol 14 no longer skips rows that
 * share the boundary's `$createdAt`).
 *
 * Tip resolution folds a ref's full update history (both types, with the `protected` flag
 * set per source) through {@link resolveRef}, honoring as-of protected-pattern config.
 * Divergence resolution that turns on real commit ancestry (a merge superseding both racing
 * heads) needs a commit-graph predicate from the browse plane; callers may pass one via
 * `isAncestor`. Without it, linear/fast-forward/force/delete cases still resolve correctly
 * (the consensus clock, with the prevOid chain inside one block, carries those); only
 * unmerged races stay `Diverged`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  displayRefName,
  isNullOid,
  resolveRef,
  type ConfigDoc,
  type IsAncestor,
  type RefState,
  type RefUpdate,
} from '../rules'
import {
  base64ToHex,
  hexToBase64,
  IncompleteReadError,
  queryAllDocuments,
  queryDocumentsWithProof,
  type PlainDocument,
} from '../sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { DOC, str, toRefUpdate, wellFormed, type RepoRef } from './contract'
import { admitAll } from './private-content'
import { readConfigHistory } from './config'
import { repoSource } from './source'

const NO_ANCESTRY: IsAncestor = () => false

/** One query page — also the Platform per-query document cap. */
const PAGE = 100

/** Backstop against a node that never lets the scan finish (each round passes ≥ 1 ref). */
const MAX_KEYSET_ROUNDS = 100_000

/** Both ref-update types, each with the `protected` flag its updates carry into the fold. */
const REF_UPDATE_TYPES: readonly (readonly [string, boolean])[] = [
  [DOC.refUpdate, false],
  [DOC.protectedRefUpdate, true],
]

/** A resolved ref for list views. */
export interface ResolvedRef {
  /** The ref name, e.g. `refs/heads/main`. */
  readonly refName: string
  /** `sha256(refName)` hex — the indexed key. */
  readonly refNameHash: string
  /** Resolved state (resolved / diverged / unborn). */
  readonly state: RefState
}

/** The row's `refNameHash` as lowercase hex — hex order is byte order; base64 order is not. */
function refHashHexOf(doc: PlainDocument, documentTypeName: string): string {
  const raw = doc['refNameHash']
  let hex = ''
  try {
    hex = typeof raw === 'string' ? base64ToHex(raw) : ''
  } catch {
    /* reported below */
  }
  if (hex.length !== 64) {
    // A row that cannot be attributed to a ref would make the answer wrong, not partial.
    throw new Error(`${documentTypeName} ${String(doc['$id'])} has no 32-byte refNameHash`)
  }
  return hex
}

/** One ref's updates of one type (an equality read — single-branch, so cursor-safe). */
export function readOneRef(
  sdk: EvoSDK,
  repo: RepoRef,
  documentTypeName: string,
  refNameHashB64: string,
): Promise<PlainDocument[]> {
  return queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(documentTypeName, {
      where: [['refNameHash', '==', refNameHashB64]],
      orderBy: [['$createdAt', 'asc']],
    }),
  )
}

/**
 * The rows of `rows` filed under the ref `refNameHashHex` (a row whose `refNameHash` is not 32
 * bytes is no ref's). A reader that holds a type's whole timeline takes one ref's history from it.
 */
export function rowsOfRef(rows: readonly PlainDocument[], refNameHashHex: string): PlainDocument[] {
  return rows.filter((d) => {
    try {
      return refHashHexOf(d, '') === refNameHashHex
    } catch {
      return false
    }
  })
}

/** Drop repeated `$id`s, keeping the first occurrence. */
function dedupeById(rows: readonly PlainDocument[]): PlainDocument[] {
  const seen = new Set<string>()
  return rows.filter((d) => {
    const id = String(d['$id'])
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** A `refNameHash` bound: lowercase hex (for comparisons) and base64 (the query operand). */
interface HashKey {
  readonly hex: string
  readonly b64: string
}

function hashKey(hex: string): HashKey {
  return { hex, b64: hexToBase64(hex) }
}

/**
 * Ranges the rest of a scan is split into once its first page comes back full. A large repo's
 * refs (dashpay/dash: hundreds of tags) took about seven serial pages, ~1.5 s before anything
 * else on the repo home could start (L-15). Split, the pages run side by side.
 */
const KEYSET_SPLITS = 4

const HASH_MAX = 2n ** 256n - 1n

/**
 * How many ranges the rest of a scan is worth splitting into, after a full first page that reached
 * `lastHex`: about as many as the pages still to read, estimated from the share of the key space
 * that page covered (a sha256 spreads refs evenly), at most {@link KEYSET_SPLITS}. 1: read on, one
 * page at a time (a split would only add the over-read of its extra ranges).
 */
export function keysetSplits(lastHex: string): number {
  const reached = Number(BigInt(`0x${lastHex}`) >> 192n) / 2 ** 64
  if (!(reached > 0)) return KEYSET_SPLITS
  const pagesLeft = (1 - reached) / reached
  return Math.max(1, Math.min(KEYSET_SPLITS, Math.ceil(pagesLeft)))
}

/**
 * `splits - 1` ceilings splitting `(afterHex, max]` into ranges of equal width, each a 32-byte hex
 * key strictly above `afterHex` and below the next. Together with `afterHex` and the end of the
 * key space they cover it exactly. `refNameHash` is a sha256, so equal widths hold roughly equal
 * numbers of refs.
 */
export function splitHashRange(afterHex: string, splits = KEYSET_SPLITS): string[] {
  const floor = BigInt(`0x${afterHex}`)
  const width = (HASH_MAX - floor) / BigInt(splits)
  const out: string[] = []
  if (width === 0n) return out
  for (let i = 1; i < splits; i++) out.push((floor + width * BigInt(i)).toString(16).padStart(64, '0'))
  return out
}

/**
 * Page one type by key from `after` (see the module doc; null: from the start). `null` when the
 * node did not honor the query — a page out of order, a row at or below the `> after` bound, or
 * a round that would not advance `after` — and the caller then discards the scan entirely.
 *
 * `upToHex` ends the scan on the client: rows above it are left to the next range, and the scan
 * stops at the first page that reaches past it (every ref at or below it is then whole: its rows
 * sort before that page's last). Only `refNameHash >` is ever sent. Drive checks the two bounds
 * of a `>`/`<=` pair as text, the base64 operands, before it decodes them, and base64 order is
 * not byte order: a range whose bounds straddle `+`/`/`/digits/letters is refused.
 *
 * A scan over the whole key space reads its first page on its own; when that page is full, the
 * rest is split into {@link keysetSplits} ranges scanned in parallel. Each range keeps only the
 * rows in `(start, ceiling]`: those are disjoint and cover the rest exactly, so the rows are those
 * of one serial scan (the queries themselves overlap by up to a page).
 */
/** @internal Exported for tests: one keyset scan (see above). */
export async function keysetScan(
  sdk: EvoSDK,
  repo: RepoRef,
  documentTypeName: string,
  after: HashKey | null = null,
  upToHex: string | null = null,
): Promise<PlainDocument[] | null> {
  const source = repoSource(repo)
  const rows: PlainDocument[] = []
  const whole = after === null && upToHex === null
  for (let round = 0; round < MAX_KEYSET_ROUNDS; round++) {
    const floorHex = after?.hex
    const { documents: page } = await queryDocumentsWithProof(
      sdk,
      source.repoQuery(documentTypeName, {
        where: after === null ? [] : [['refNameHash', '>', after.b64]],
        orderBy: [
          ['refNameHash', 'asc'],
          ['$createdAt', 'asc'],
        ],
        limit: PAGE,
      }),
    )
    const hashes = page.map((d) => refHashHexOf(d, documentTypeName))
    const inOrder = hashes.every((h, i) => i === 0 || (hashes[i - 1] as string) <= h)
    const inRange = floorHex === undefined || hashes.every((h) => h > floorHex)
    if (!inOrder || !inRange) return null

    if (upToHex !== null && hashes.some((h) => h > upToHex)) {
      // The page reaches the next range: what is at or below the ceiling is complete.
      rows.push(...page.filter((_, i) => (hashes[i] as string) <= upToHex))
      return dedupeById(rows)
    }
    if (page.length < PAGE) {
      rows.push(...page)
      return dedupeById(rows)
    }
    const last = hashes[hashes.length - 1] as string
    const cut = hashes.indexOf(last)
    let next: HashKey
    if (cut === 0) {
      // One ref filled the page: read it on its own, then move past it.
      const b64 = (page[0] as PlainDocument)['refNameHash'] as string
      rows.push(...(await readOneRef(sdk, repo, documentTypeName, b64)))
      next = { hex: last, b64 }
    } else {
      // Every ref before the last is whole; the last may be cut off and is re-read next page.
      const prev = page[cut - 1] as PlainDocument
      next = { hex: hashes[cut - 1] as string, b64: prev['refNameHash'] as string }
      rows.push(...page.slice(0, cut))
    }
    // In-range pages already imply progress; this guards the invariant termination rests on.
    if (floorHex !== undefined && next.hex <= floorHex) return null
    after = next
    if (whole && round === 0) {
      // The first page was full: scan what is left as parallel ranges, each up to its ceiling.
      const splits = keysetSplits(next.hex)
      if (splits === 1) continue
      const ceilings = splitHashRange(next.hex, splits)
      const starts = [next, ...ceilings.map(hashKey)]
      const parts = await Promise.all(
        starts.map((start, i) => keysetScan(sdk, repo, documentTypeName, start, ceilings[i] ?? null)),
      )
      if (parts.some((p) => p === null)) return null
      return dedupeById([...rows, ...parts.flatMap((p) => p as PlainDocument[])])
    }
  }
  throw new IncompleteReadError(
    documentTypeName,
    rows.length,
    `the ref keyset scan did not finish in ${MAX_KEYSET_ROUNDS} rounds`,
  )
}

/**
 * Every row of one ref-update type, read as `splits` keyset ranges side by side from the start
 * (QW-087): for a reader that already knows the type has more than a page (the repo chrome's
 * `$createdAt` page came back full) and so need not read a first page to learn it. dashpay/dash's
 * ~700 updates were six serial continuation pages (a 1.0–1.4 s waterfall on every cold page); as
 * ranges they are one round trip, each range read on (by key) only past its own page. Null when a
 * node did not honor a range (see {@link keysetScan}): the caller then reads the plain way.
 */
export async function readRefRowsInRanges(
  sdk: EvoSDK,
  repo: RepoRef,
  documentTypeName: string,
  splits = CHROME_KEYSET_SPLITS,
): Promise<PlainDocument[] | null> {
  const ceilings = splitHashRange('0'.repeat(64), splits)
  const starts: (HashKey | null)[] = [null, ...ceilings.map(hashKey)]
  const parts = await Promise.all(starts.map((start, i) => keysetScan(sdk, repo, documentTypeName, start, ceilings[i] ?? null)))
  if (parts.some((p) => p === null)) return null
  return dedupeById(parts.flatMap((p) => p as PlainDocument[]))
}

/** Ranges {@link readRefRowsInRanges} reads by default: a page each covers ~800 updates in one round trip. */
export const CHROME_KEYSET_SPLITS = 8

/**
 * Whether some update's non-null `prevOid` is no update's `newOid` in the same ref — a parent
 * that should have been read and was not. Parity: forge-core `refs::has_missing_parent`.
 */
export function hasMissingParent(updates: readonly RefUpdate[]): boolean {
  const tips = new Set(updates.map((u) => u.newOid))
  return updates.some((u) => u.prevOid !== undefined && !isNullOid(u.prevOid) && !tips.has(u.prevOid))
}

interface TypeScan {
  readonly type: string
  readonly isProtected: boolean
  readonly rows: readonly PlainDocument[]
}

/** Group rows per ref: plain before protected, each in read order (the fold re-sorts). */
function groupByRef(repo: RepoRef, scans: readonly TypeScan[]): Map<string, RefUpdate[]> {
  const byHash = new Map<string, RefUpdate[]>()
  for (const { type, isProtected, rows } of scans) {
    for (const doc of rows) {
      // forge-v2: a ref update not well-formed for the repo's visibility (a private repo's
      // plaintext `refName`, say) is skipped before the fold sees it (`forge-v2.md` §5).
      if (!wellFormed(repo, 'refUpdate', doc)) continue
      const hex = refHashHexOf(doc, type)
      const update = toRefUpdate(doc, isProtected)
      const group = byHash.get(hex)
      if (group === undefined) byHash.set(hex, [update])
      else group.push(update)
    }
  }
  return byHash
}

/**
 * Whether rows of both ref-update types, grouped per ref ACROSS the two types, lose a parent
 * ({@link hasMissingParent}): the check {@link readAllRefUpdates} runs after its keyset scan, for a
 * reader that read the rows as key ranges ({@link readRefRowsInRanges}) and must catch rows that
 * never came back. Across both types, never per type: a protected update's `prevOid` may be a
 * plain update's `newOid`. `rowsByType`: each type's rows, keyed by document type name.
 */
export function refRowsMissParent(repo: RepoRef, rowsByType: Readonly<Record<string, readonly PlainDocument[]>>): boolean {
  const scans = REF_UPDATE_TYPES.map(([type, isProtected]): TypeScan => ({ type, isProtected, rows: rowsByType[type] ?? [] }))
  return [...groupByRef(repo, scans).values()].some(hasMissingParent)
}

/** `sha256(refName)` hex: the key a private ref is grouped under once its name is decrypted. */
export function publicRefKey(refName: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(refName)))
}

/**
 * A private repo's refs (`docs/security/private-repos.md` §4.5): the complete `reflog` of both
 * types, each update opened through the session's gate (its `refNameHash` is an HMAC under the
 * write epoch, so one ref's history spans several hashes). An opened update names its ref in
 * `refName`; rewriting `refNameHash` to `sha256(refName)` groups a ref's history across epochs
 * by that name and lets the public resolver fold it unchanged (protected routing uses the
 * decrypted config timeline). Nothing is readable without a session.
 */
async function readPrivateRefUpdates(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, RefUpdate[]>> {
  const session = repo.session
  if (session === undefined) return new Map()
  return session.refUpdates(async () => {
    const byKey = new Map<string, RefUpdate[]>()
    for (const [type, isProtected] of REF_UPDATE_TYPES) {
      const rows = dedupeById(await queryAllDocuments(sdk, repoSource(repo).repoQuery(type, { orderBy: [['$createdAt', 'asc']] })))
      const { docs } = await admitAll(session.gate, type as 'refUpdate' | 'protectedRefUpdate', rows)
      for (const doc of docs) {
        const refName = str(doc, 'refName')
        const key = publicRefKey(refName)
        const update = { ...toRefUpdate(doc, isProtected), refNameHash: key }
        const group = byKey.get(key)
        if (group === undefined) byKey.set(key, [update])
        else group.push(update)
      }
    }
    return byKey
  })
}

/**
 * Every ref's complete update history, keyed by `refNameHash` hex. Keyset scan per type, then
 * the `prevOid` completeness check; when the scan misbehaves or fails the check, the answer
 * is the `reflog` read of both types alone (see the module doc). A private repo: see
 * {@link readPrivateRefUpdates} (keyed by `sha256` of the decrypted name).
 */
export async function readAllRefUpdates(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<Map<string, RefUpdate[]>> {
  if (repo.visibility === 'private') return readPrivateRefUpdates(sdk, repo)
  const scanned = await Promise.all(
    REF_UPDATE_TYPES.map(async ([type, isProtected]) => ({
      type,
      isProtected,
      rows: await keysetScan(sdk, repo, type),
    })),
  )
  if (scanned.every((s) => s.rows !== null)) {
    const grouped = groupByRef(repo, scanned as TypeScan[])
    if (![...grouped.values()].some(hasMissingParent)) return grouped
  }

  // The fallback stands alone: a scan that misbehaved or lost rows is not trusted for any.
  const full = await Promise.all(
    REF_UPDATE_TYPES.map(async ([type, isProtected]): Promise<TypeScan> => ({
      type,
      isProtected,
      rows: dedupeById(
        await queryAllDocuments(
          sdk,
          repoSource(repo).repoQuery(type, { orderBy: [['$createdAt', 'asc']] }),
        ),
      ),
    })),
  )
  return groupByRef(repo, full)
}

/**
 * Fetch a single ref's **complete** update history (both types), converted to rules inputs.
 *
 * Pages to exhaustion: {@link resolveRef} folds the whole causal chain, so stopping at one
 * page pins a branch at its 100th push — the tip stops advancing and every later commit
 * becomes unreachable through the UI. It also feeds {@link historicalTipsPredicate}, where
 * a truncated tip set makes a genuinely merged PR fold as still-open. Parity: forge-core
 * `refs::read_ref_history` (behind `read_merge_base`).
 */
export async function readRefUpdates(
  sdk: EvoSDK,
  repo: RepoRef,
  refNameHashB64: string,
): Promise<RefUpdate[]> {
  // Private: the argument is the public key `sha256(name)` of a decrypted name.
  if (repo.visibility === 'private') return (await readPrivateRefUpdates(sdk, repo)).get(base64ToHex(refNameHashB64)) ?? []
  const [plain, prot] = await Promise.all([
    readOneRef(sdk, repo, DOC.refUpdate, refNameHashB64),
    readOneRef(sdk, repo, DOC.protectedRefUpdate, refNameHashB64),
  ])
  return [
    ...plain.filter((d) => wellFormed(repo, 'refUpdate', d)).map((d) => toRefUpdate(d, false)),
    ...prot.filter((d) => wellFormed(repo, 'refUpdate', d)).map((d) => toRefUpdate(d, true)),
  ]
}

/**
 * Fold a ref's full (`$createdAt asc`) update history into its resolved list-view state.
 *
 * The display name comes from the newest update whose `refName` actually hashes to this key,
 * on the `(createdAt, id)` total order. `refName` is caller-supplied content while only
 * `refNameHash` is indexed, so a writer can file an update under `main`'s hash carrying
 * any legal name; `resolveRef` already ignores such an update, and naming the ref from it
 * would show a different branch name than a client that does not. Taking the last element of
 * the plain-then-protected concatenation — which is not even the newest update overall —
 * was the forge-web half of that divergence. forge-core `read_refs` applies the same rule.
 *
 * **Null means the ref is omitted, not rendered blank.** When no update under this key
 * carries a name that hashes to it there is nothing safe to display, and forge-core's
 * `read_refs` skips the ref entirely (`continue`). Returning an empty name here instead
 * would have re-opened the same cross-client divergence one level up: one client listing a
 * nameless row, the other listing nothing.
 */
function toResolvedRef(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHashHex: string,
  isAncestor: IsAncestor,
): ResolvedRef | null {
  const refName = displayRefName(updates, refNameHashHex)
  if (refName === undefined) return null
  return {
    refName,
    refNameHash: refNameHashHex,
    state: resolveRef(updates, configHistory, refNameHashHex, isAncestor),
  }
}

/** Resolve a single ref by its (base64) `refNameHash`. */
export async function resolveRefByHash(
  sdk: EvoSDK,
  repo: RepoRef,
  refNameHashB64: string,
  configHistory: readonly ConfigDoc[],
  isAncestor: IsAncestor = NO_ANCESTRY,
): Promise<ResolvedRef | null> {
  const updates = await readRefUpdates(sdk, repo, refNameHashB64)
  if (updates.length === 0) return null
  return toResolvedRef(updates, configHistory, base64ToHex(refNameHashB64), isAncestor)
}

/**
 * Every ref of a public repo, folded from rows already read: each type's complete `reflog`
 * (`(repoId, $createdAt)`, as the repo chrome store holds them) and the config timeline. This is
 * the scan's own fallback answer, read as one timeline instead of a keyset scan: every row of
 * both types, grouped by `refNameHash`, so no ref can be cut off by a page boundary.
 */
export function refsFromRows(
  repo: RepoRef,
  refUpdates: readonly PlainDocument[],
  protectedRefUpdates: readonly PlainDocument[],
  configHistory: readonly ConfigDoc[],
  isAncestor: IsAncestor = NO_ANCESTRY,
): ResolvedRef[] {
  const byHash = groupByRef(repo, [
    { type: DOC.refUpdate, isProtected: false, rows: dedupeById(refUpdates) },
    { type: DOC.protectedRefUpdate, isProtected: true, rows: dedupeById(protectedRefUpdates) },
  ])
  return [...byHash]
    .map(([refNameHashHex, updates]) => toResolvedRef(updates, configHistory, refNameHashHex, isAncestor))
    .filter((r): r is ResolvedRef => r !== null)
}

/**
 * One ref's update history (both types) from rows already read, as {@link readRefUpdates}
 * returns it: a PR list folds every row's base ref from the stored timelines.
 */
export function refUpdatesFromRows(
  repo: RepoRef,
  refUpdates: readonly PlainDocument[],
  protectedRefUpdates: readonly PlainDocument[],
  refNameHashB64: string,
): RefUpdate[] {
  const hex = base64ToHex(refNameHashB64)
  return (groupByRef(repo, [
    { type: DOC.refUpdate, isProtected: false, rows: dedupeById(refUpdates) },
    { type: DOC.protectedRefUpdate, isProtected: true, rows: dedupeById(protectedRefUpdates) },
  ]).get(hex) ?? [])
}

/**
 * Read every ref of a repo: {@link readAllRefUpdates}, each ref folded locally. Fetches the
 * config history once and reuses it across refs — or accepts the caller's in-flight fetch
 * (`configHistoryPromise`) so a composed read like `loadRepoHome` issues only ONE config
 * query total.
 */
export async function readRefs(
  sdk: EvoSDK,
  repo: RepoRef,
  isAncestor: IsAncestor = NO_ANCESTRY,
  configHistoryPromise?: Promise<readonly ConfigDoc[]>,
): Promise<ResolvedRef[]> {
  const [byHash, configHistory] = await Promise.all([
    readAllRefUpdates(sdk, repo),
    configHistoryPromise ?? readConfigHistory(sdk, repo),
  ])
  return [...byHash]
    .map(([refNameHashHex, updates]) =>
      toResolvedRef(updates, configHistory, refNameHashHex, isAncestor),
    )
    .filter((r): r is ResolvedRef => r !== null)
}

/** Filter helper: only `refs/heads/*` branches. */
export function branchesOf(refs: readonly ResolvedRef[]): ResolvedRef[] {
  return refs.filter((r) => r.refName.startsWith('refs/heads/'))
}

/** Filter helper: only `refs/tags/*` tags. */
export function tagsOf(refs: readonly ResolvedRef[]): ResolvedRef[] {
  return refs.filter((r) => r.refName.startsWith('refs/tags/'))
}
