/**
 * Check runs on members-only branches, as a member reads them (`docs/security/private-repos.md`
 * §19.9; mixed-visibility DESIGN §4.3 "CI on a members branch"): such a run is reported on the
 * commit's blind under an opaque 16-character name, with its log sealed at `logUrl`. A member whose
 * session verified that blind ({@link blindBook}, which keeps the blind's salt) reads the run's real
 * name, and its log, by opening the log: fetched like any run's log ({@link fetchVerifiedLog}),
 * checked against `logSha256`, then opened with the blind's check keys. The header must name a
 * check that hashes to the run's name and a commit whose blind is the run's head, so a log moved to
 * another run or commit does not open there.
 *
 * Everyone else, and a member for a blind their session did not verify, keeps the opaque name. A
 * log that is missing, fails its hash or does not open leaves it too. Parity: `dg ci status` /
 * `dg ci log` (`crates/dg/src/ci.rs`, `members_run_log`).
 *
 * The opened names and logs live with the members-key session that opened them (a lock or a key
 * change drops them with the session's context), like its blinds.
 */

import type { OpenContext } from '../private'
import { hexToBytes } from '../private/bytes'
import { CheckKeys, isOpaqueName } from '../private/members-check'
import { fetchVerifiedLog, safeLogUrl, type CheckRun } from './checks'
import { blindBook, type BlindBook } from './members-blinds'

/** A members-only run, opened: the check's real name and its log. */
export interface OpenedRun {
  readonly name: string
  /** The log's text (the opened bytes, decoded). */
  readonly log: string
  /** How many bytes were read: what `logSha256` covers. */
  readonly bytes: number
}

/** The fields a run is opened from. */
export type MembersRunInput = Pick<CheckRun, 'id' | 'name' | 'headOid' | 'logUrl' | 'logSha256'>

/** Whether `run` is one `book` can open: an opaque name, on a blind the session verified, with a log. */
export function isMembersRun(run: MembersRunInput, book: BlindBook): boolean {
  return isOpaqueName(run.name) && run.headOid !== undefined && run.headOid !== '' && book.saltOf(run.headOid) !== undefined
}

/**
 * Open the members-only run `run` with the salt of its blind: null when it has no log this page can
 * read, the bytes do not hash to `logSha256`, or the log does not open as this run's.
 */
export async function openMembersRun(run: MembersRunInput, salt: Uint8Array, fetchImpl?: typeof fetch, pageHost?: string): Promise<OpenedRun | null> {
  const blind = (run.headOid ?? '').toLowerCase()
  if (!isOpaqueName(run.name) || blind === '' || run.logSha256 === '' || safeLogUrl(run.logUrl, pageHost) === null) return null
  try {
    const fetched = await fetchVerifiedLog(run, fetchImpl, pageHost)
    if (!fetched.verified) return null
    const opened = await (await CheckKeys.of(salt)).openLog(hexToBytes(blind), run.name, fetched.raw)
    return { name: opened.name, log: new TextDecoder().decode(opened.log), bytes: fetched.bytes }
  } catch {
    return null
  }
}

// Per members-key session: each run's opening, by run, head and log hash (a later report of the
// run records a new log). A run that did not open is not kept, so the next read tries again.
const opened = new WeakMap<OpenContext, Map<string, Promise<OpenedRun | null>>>()

function cacheOf(ctx: OpenContext): Map<string, Promise<OpenedRun | null>> {
  let cache = opened.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    opened.set(ctx, cache)
  }
  return cache
}

/**
 * The runs of `runs` a member resolves under the session `ctx`, by run id: each opaque-named run on
 * a blind the session verified, opened (null: its name is not available). Other runs are absent.
 */
export async function resolveMembersRuns(ctx: OpenContext, runs: readonly MembersRunInput[], fetchImpl?: typeof fetch, pageHost?: string): Promise<Map<string, OpenedRun | null>> {
  const book = blindBook(ctx)
  const cache = cacheOf(ctx)
  const out = new Map<string, OpenedRun | null>()
  await Promise.all(
    runs.filter((r) => isMembersRun(r, book)).map(async (r) => {
      const key = `${r.id}\0${(r.headOid ?? '').toLowerCase()}\0${r.logSha256.toLowerCase()}`
      let pending = cache.get(key)
      if (pending === undefined) {
        pending = openMembersRun(r, book.saltOf(r.headOid as string) as Uint8Array, fetchImpl, pageHost)
        cache.set(key, pending)
      }
      const got = await pending
      if (got === null && cache.get(key) === pending) cache.delete(key)
      out.set(r.id, got)
    }),
  )
  return out
}
