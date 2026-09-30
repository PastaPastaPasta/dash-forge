/**
 * CI outcome counts for a list of commits (O-07): what the PR list's and the commit list's status
 * dots show, from proved counts over `checkRun.outcome (repoId, headOid, outcome)` (forge-community,
 * `rangeCountable`, so countable). `outcome` is 0 pending, 1 success / neutral / skipped, 2 anything
 * else; consensus checks it agrees with `status` and `conclusion` (the `outcomeOf` rule).
 *
 * The read: for each outcome, one proved count `repoId == repo AND headOid in [heads] AND
 * outcome == k`, grouped by `headOid`, so {@link OUTCOME_REQUESTS} requests per 100 heads (the `in`
 * clause's limit), whatever the page's length. Drive serves this shape as a point-lookup count proof,
 * one CountTree element per head (rs-drive `verify_point_lookup_count_proof`: an `in` at any index
 * position with trailing `==` clauses), each keyed by the head's bytes, hex.
 *
 * Why not one request: Drive can answer `headOid in [...] AND outcome >= 0` grouped by
 * `[headOid, outcome]` (its compound range-distinct proof), but the wasm SDK's `documents.count`
 * sums a compound result's per-`(headOid, outcome)` entries by `outcome` into a flat map
 * (`into_flat_map`, wasm-sdk `queries/document.rs`), which drops the head. Two `in` clauses are
 * refused, and a composite query's counts bind only identifier properties of its page's
 * documents. Each request yields one number per head and there are three unknowns, so three is the
 * floor through this binding.
 *
 * What a count covers (display, never a gate): every run document reported on the commit. Consensus
 * admits a `checkRun` only from a runner, maintainer or writer of the repo at write time
 * (`ownerRefersTo`), so a count holds runs by members at the time they reported, including a
 * reporter revoked since, and every attempt of a re-run (a re-run is a new document). The merge
 * box's `checksState` and a commit's Checks tab count only the newest run per name from a current
 * member or runner (`./checks`), as GitHub's dot reads only the latest run of each check. So a run
 * that failed and then passed on a re-run still counts as failing here: counting only the newest run
 * per name needs a contract that replaces a re-run in place (deferred to the next registration).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isRc1OidHex } from '../rules'
import { countDocumentsGrouped, hexToBase64, shareInFlight } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { repoSource } from './source'

/** A commit's run documents by outcome. */
export interface OutcomeCounts {
  readonly pending: number
  readonly passed: number
  readonly failed: number
}

/** The `checkRun.outcome` values: pending, passed, failed (the {@link OutcomeCounts} order). */
const OUTCOMES = [0, 1, 2] as const

/** Proved requests per batch of up to {@link IN_MAX} heads: one per outcome. */
export const OUTCOME_REQUESTS = OUTCOMES.length

/** The proved `in` clause limit: a count names at most this many heads. */
const IN_MAX = 100

const NONE: OutcomeCounts = { pending: 0, passed: 0, failed: 0 }

/**
 * Counts go stale as runs finish; a read within this long of the reply reads nothing again. Per repo
 * and head, so a list's next page reads only the heads it adds.
 */
export const CACHE_TTL_MS = 60_000
/** The most heads kept; the oldest reply is dropped first (a Map iterates in insertion order). */
const CACHE_MAX = 5_000
const cache = new Map<string, { readonly at: number; readonly counts: OutcomeCounts }>()

/** Heads being read now, per repo: a caller asking for one joins that read rather than sending its own. */
const inFlight = new Map<string, Promise<OutcomeCounts>>()

const cacheKey = (repo: RepoRef, oid: string): string => `${repo.forge.community}:${repo.repoId}:${oid}`

/** The distinct valid heads of `headOids` (SHA-1 or SHA-256 hex), lowercase: the one place heads are normalized. */
export function headsOf(headOids: readonly string[]): string[] {
  return [...new Set(headOids.map((h) => h.toLowerCase()).filter(isRc1OidHex))]
}

/** A normalized head's cached counts, if the reply is younger than `maxAgeMs`. */
function fresh(repo: RepoRef, head: string, now: number, maxAgeMs = CACHE_TTL_MS): OutcomeCounts | undefined {
  const hit = cache.get(cacheKey(repo, head))
  return hit !== undefined && now - hit.at < maxAgeMs ? hit.counts : undefined
}

/**
 * The cached counts of `headOids` whose reply is younger than `maxAgeMs` (a partial map; empty when
 * none are). With `Infinity`, what a list shows while it re-reads: stale dots rather than none.
 */
export function cachedOutcomeCounts(repo: RepoRef, headOids: readonly string[], maxAgeMs = CACHE_TTL_MS, now = Date.now()): Map<string, OutcomeCounts> {
  const out = new Map<string, OutcomeCounts>()
  for (const h of headsOf(headOids)) {
    const counts = fresh(repo, h, now, maxAgeMs)
    if (counts !== undefined) out.set(h, counts)
  }
  return out
}

/**
 * The run counts of each of `headOids` (hex) in `repo`, keyed by the lowercase head: every valid head
 * gets an entry (all zeros when nothing was reported). {@link OUTCOME_REQUESTS} proved requests per
 * 100 heads neither cached nor already being read; none when all are. A failed read rejects and
 * caches nothing.
 */
export async function readOutcomeCounts(sdk: EvoSDK, repo: RepoRef, headOids: readonly string[]): Promise<Map<string, OutcomeCounts>> {
  const now = Date.now()
  const out = new Map<string, OutcomeCounts>()
  const reads = new Map<string, Promise<OutcomeCounts>>()
  const missing: string[] = []
  for (const h of headsOf(headOids)) {
    const counts = fresh(repo, h, now)
    const held = inFlight.get(cacheKey(repo, h))
    if (counts !== undefined) out.set(h, counts)
    else if (held !== undefined) reads.set(h, held)
    else missing.push(h)
  }
  missing.sort()
  for (let i = 0; i < missing.length; i += IN_MAX) {
    const batch = missing.slice(i, i + IN_MAX)
    const read = readBatch(sdk, repo, batch)
    for (const h of batch) reads.set(h, shareInFlight(inFlight, cacheKey(repo, h), () => read.then((m) => m.get(h) ?? NONE)))
  }
  await Promise.all([...reads].map(async ([h, p]) => out.set(h, await p)))
  return out
}

/**
 * One batch of at most {@link IN_MAX} heads: a proved count per outcome, grouped by head (each keyed
 * by the head's bytes, hex); cached.
 */
async function readBatch(sdk: EvoSDK, repo: RepoRef, batch: readonly string[]): Promise<Map<string, OutcomeCounts>> {
  const operands = batch.map(hexToBase64)
  const source = repoSource(repo)
  const [pending, passed, failed] = await Promise.all(
    OUTCOMES.map((outcome) =>
      countDocumentsGrouped(sdk, {
        ...source.repoQuery(DOC.checkRun, {
          where: [
            ['headOid', 'in', operands],
            ['outcome', '==', outcome],
          ],
          orderBy: [['headOid', 'asc']],
        }),
        groupBy: ['headOid'],
      }),
    ),
  )
  const at = Date.now()
  const out = new Map<string, OutcomeCounts>()
  for (const h of batch) {
    const counts = { pending: pending!.get(h) ?? 0, passed: passed!.get(h) ?? 0, failed: failed!.get(h) ?? 0 }
    const key = cacheKey(repo, h)
    cache.delete(key)
    cache.set(key, { at, counts })
    out.set(h, counts)
  }
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(key)
  }
  return out
}

/** The dot GitHub shows: any failure is red, else anything pending is yellow, else green; none for no runs. */
export type CheckDotState = 'failure' | 'pending' | 'success'

export function checkDotState(c: OutcomeCounts): CheckDotState | null {
  if (c.failed > 0) return 'failure'
  if (c.pending > 0) return 'pending'
  return c.passed > 0 ? 'success' : null
}

/** "2 successful, 1 failing checks", "1 pending check"; '' for no runs. */
export function outcomePhrase(c: OutcomeCounts): string {
  const parts: string[] = []
  if (c.passed > 0) parts.push(`${c.passed} successful`)
  if (c.failed > 0) parts.push(`${c.failed} failing`)
  if (c.pending > 0) parts.push(`${c.pending} pending`)
  const total = c.pending + c.passed + c.failed
  return total === 0 ? '' : `${parts.join(', ')} ${total === 1 ? 'check' : 'checks'}`
}

/** Test-only: forget every cached count. */
export function clearOutcomeCache(): void {
  cache.clear()
  inFlight.clear()
}
