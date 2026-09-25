/**
 * Ref reads — branch/tag enumeration + tip resolution (data-contracts §2.3, §4).
 *
 * Every ref's complete update history comes from a **keyset scan** over the `refState` index
 * (`refNameHash, $createdAt`): pages of `refNameHash > last`, 100 rows each, with no
 * `startAfter` cursor. Every ref on a full page except the last is complete; the next page
 * starts after the last complete ref. A ref that fills a page by itself is read on its own
 * (an equality query, single-branch) and the scan moves past it. Cost: ⌈updates/100⌉
 * queries per type plus one per such ref. Parity: forge-core `refs::read_all_ref_updates`.
 *
 * WHY NO CURSOR: paging `refState` with `startAfter` loses rows on testnet (protocol 13) —
 * 32 of 229 updates on the nightly repo. Drive's v0 lowering applies the cursor document's
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
 * `startAfter`: single-branch, so no sibling drop, but protocol 13's same-`$createdAt`
 * boundary skip still applies to repo-v1 ref updates until forge-v2 on protocol 14.
 *
 * Tip resolution folds a ref's full update history (both types, with the `protected` flag
 * set per source) through {@link resolveRef}, honoring as-of protected-pattern config.
 * Divergence resolution that turns on real commit ancestry (a merge superseding both racing
 * heads) needs a commit-graph predicate from the browse plane; callers may pass one via
 * `isAncestor`. Without it, linear/fast-forward/force/delete cases still resolve correctly
 * (the prevOid causal DAG carries those); only unmerged three-way races stay `Diverged`.
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
  IncompleteReadError,
  queryAllDocuments,
  queryDocumentsWithProof,
  type PlainDocument,
} from '../sdk'
import { DOC, toRefUpdate, wellFormed, type RepoRef } from './contract'
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
function readOneRef(
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

/**
 * Page one type by key (see the module doc). `null` when the node did not honor the query —
 * a page out of order, a row at or below the `> last` bound, or a round that would not
 * advance `last` — and the caller then discards the scan entirely.
 */
async function keysetScan(
  sdk: EvoSDK,
  repo: RepoRef,
  documentTypeName: string,
): Promise<PlainDocument[] | null> {
  const source = repoSource(repo)
  const rows: PlainDocument[] = []
  let after = null as { hex: string; b64: string } | null
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

    if (page.length < PAGE) {
      rows.push(...page)
      return dedupeById(rows)
    }
    const last = hashes[hashes.length - 1] as string
    const cut = hashes.indexOf(last)
    let next: { hex: string; b64: string }
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
  }
  throw new IncompleteReadError(
    documentTypeName,
    rows.length,
    `the ref keyset scan did not finish in ${MAX_KEYSET_ROUNDS} rounds`,
  )
}

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
  readonly rows: PlainDocument[]
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
 * Every ref's complete update history, keyed by `refNameHash` hex. Keyset scan per type, then
 * the `prevOid` completeness check; when the scan misbehaves or fails the check, the answer
 * is the `reflog` read of both types alone (see the module doc).
 */
export async function readAllRefUpdates(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<Map<string, RefUpdate[]>> {
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
 * `refs::read_ref_history` (behind `base_ref_tips`).
 */
export async function readRefUpdates(
  sdk: EvoSDK,
  repo: RepoRef,
  refNameHashB64: string,
): Promise<RefUpdate[]> {
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
 * `refNameHash` is indexed, so a token holder can file an update under `main`'s hash carrying
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
