/**
 * The open PR page's head probe (#453, qa5 C: a reviewer approved a stale head because the page
 * never noticed the author's push). One light read, ONE composite request (`queryComposite`),
 * that asks only for what is newer than what the page shows:
 *
 * - the PR's `event` and `authorEvent` documents at or after the newest one the page read
 *   (index `target` = `(targetId, $createdAt)`, forge-community): a new `headUpdate` (kind 16)
 *   means the PR head moved. git-remote-dash posts one after a push (`pr_sync.rs`), unless
 *   `dash.prAutoSync=false` or the pusher is not the PR's author;
 * - when the source branch is readable from here (the rule of `readBranchState`: a plain branch
 *   of a public repo), its newest `refUpdate` and `protectedRefUpdate` (index `refState` =
 *   `(repoId, refNameHash, $createdAt)`, forge-core): a newer tip than the page read means new
 *   commits were pushed, whether or not the PR followed them.
 *
 * Every component walks newest first: a composite merges only components that agree on their
 * walk direction, so one descending component makes them all descend (rs-drive
 * `query/composite_document_query/mod.rs`, "Direction"). An unsupported shape falls back to
 * plain queries (`queryComposite`), which answer the same question in up to four requests.
 *
 * The probe never re-reads the thread: it only says that something is newer. The page re-reads
 * when the reader asks it to (Refresh), so a diff never changes under a reviewer's eyes.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isPlainBranchRef, type Event, type RefState } from '../rules'
import { mergedLog } from '../rules/review'
import { bytesToBase64, type DocumentQuery, type OrderByClause, type PlainDocument, type WhereClause } from '../sdk'
import { compositeOf, docsAt, queryComposite, type CompositeQuery, type CompositeResult, type CompositeSub } from '../sdk/composite'
import { DOC, byteFieldToHex, num, str, toEvent, type RepoRef } from './contract'
import { refNameHash } from './push'
import { repoSource } from './source'

/** The `headUpdate` event kind (forge-v2.md §3: kind 16, an `event` or the author's `authorEvent`). */
const HEAD_UPDATE = 'headUpdate'

/**
 * How many of the PR's newer events one probe reads. A page this full is more events in one
 * probe interval than a PR sees; the probe then keeps its mark (and reads them again next time)
 * rather than skip what lay past them. A push is still seen by its branch's ref update.
 */
export const PROBE_EVENTS = 20

/**
 * The newest PR event the page holds: its `$createdAt`, and the ids of every event (both types)
 * created then. A probe asks for `$createdAt >=` it and skips those ids: `>` would miss an event
 * of that same block.
 */
export interface EventMark {
  readonly at: number
  readonly ids: readonly string[]
}

/** The {@link EventMark} of the PR's `event` and `authorEvent` documents as read (0 and none: no events yet). */
export function eventMarkOf(docs: readonly PlainDocument[]): EventMark {
  let at = 0
  for (const d of docs) at = Math.max(at, num(d, '$createdAt'))
  return { at, ids: at === 0 ? [] : docs.filter((d) => num(d, '$createdAt') === at).map((d) => str(d, '$id')) }
}

/** What the page shows, which the probe compares with what the chain holds now. */
export interface ProbeBase {
  readonly repo: RepoRef
  readonly pullId: string
  readonly author: string
  /** The PR head the page shows (`pull.headOid`). */
  readonly headOid: string
  /** The newest PR event the page read (null: none known, the events are not probed). */
  readonly events: EventMark | null
  /**
   * The source branch, when readable from here ({@link probeBranch}): its repo, name, and the state
   * the page read. Null: not probed.
   */
  readonly branch: { readonly repo: RepoRef; readonly refName: string; readonly known: RefState | null } | null
  /** Ref update ids an earlier probe of this page announced: never announced again (see {@link interpretProbe}). */
  readonly announced?: ReadonlySet<string>
}

/**
 * The source branch as a probe reads it, or null when it cannot be read from here: the rule of
 * `readBranchState` (a private repo's ref names are keyed hashes; an imported PR's
 * `refs/mirror/pull/<n>/head` is no plain branch).
 */
export function probeBranch(repo: RepoRef | null, refName: string | null, known: RefState | null): ProbeBase['branch'] {
  if (repo === null || refName === null || repo.visibility === 'private' || !isPlainBranchRef(refName)) return null
  return { repo, refName, known }
}

/** A branch state as a key (the probe starts over when the page reads its branch again). */
export function refStateKey(state: RefState | null): string {
  if (state === null) return 'none'
  if (state.state === 'resolved') return `${state.oid}@${state.createdAt}`
  return state.state === 'unborn' ? 'unborn' : state.heads.map((h) => `${h.oid}@${h.createdAt}`).join('+')
}

/** What a probe found newer than the page. */
export interface NewPush {
  /** Where the PR head or its branch is now: the newest head update's oid, else the branch's new tip. */
  readonly tip: string
  /** The PR's head moved (a new `headUpdate`), not only its branch. */
  readonly headMoved: boolean
  /** The ref update that showed it (to be announced once), if any. */
  readonly refUpdateId: string | null
}

/** One probe's answer: what it found (null: nothing), and the event mark the next probe asks from. */
export interface ProbeOutcome {
  readonly found: NewPush | null
  readonly events: EventMark | null
}

/** Newest first: a probe asks for the newest rows (see the module doc on the walk direction). */
const NEWEST: readonly OrderByClause[] = [['$createdAt', 'desc']]

/** The probe's composite, or null when there is nothing to probe. */
export function headProbeQuery(base: ProbeBase): CompositeQuery | null {
  const parts: { q: DocumentQuery; limit: number }[] = []
  if (base.events !== null) {
    const source = repoSource(base.repo)
    const where: WhereClause[] = [['targetId', '==', base.pullId], ['$createdAt', '>=', base.events.at]]
    const since = { where, orderBy: NEWEST }
    parts.push({ q: source.targetQuery(DOC.event, since), limit: PROBE_EVENTS }, { q: source.targetQuery(DOC.authorEvent, since), limit: PROBE_EVENTS })
  }
  if (base.branch !== null) {
    const source = repoSource(base.branch.repo)
    // The range is what makes the walk descend: Drive walks a query whose clauses are all `==`
    // ascending, whatever its order asks (`pageWalk` in lib/view/discovery.ts), and a sibling
    // that walks the other way than the page is refused ("a sibling sub-query's ordering must
    // match the page's direction"). It also leaves out the updates the page's state came from.
    const where: WhereClause[] = [['refNameHash', '==', bytesToBase64(refNameHash(base.branch.refName))], ['$createdAt', '>', knownAt(base.branch.known)]]
    // One row of each type: the branch's newest update (the page holds the rest).
    parts.push({ q: source.repoQuery(DOC.refUpdate, { where, orderBy: NEWEST }), limit: 1 }, { q: source.repoQuery(DOC.protectedRefUpdate, { where, orderBy: NEWEST }), limit: 1 })
  }
  const [page, ...rest] = parts
  if (page === undefined) return null
  const subs: CompositeSub[] = rest.map(({ q, limit }) => ({
    dataContractId: q.dataContractId,
    documentType: q.documentTypeName,
    where: q.where ?? [],
    orderBy: q.orderBy ?? [],
    limit,
  }))
  return compositeOf(page.q, page.limit, subs)
}

/** The tips (and when their updates were created) the page's branch state came from: none for an unread or unborn branch. */
function knownTips(known: RefState | null): readonly { readonly oid: string; readonly createdAt: number }[] {
  if (known?.state === 'resolved') return [known]
  return known?.state === 'diverged' ? known.heads : []
}

/** When the newest update the page's branch state came from was created (0: none known). */
function knownAt(known: RefState | null): number {
  return Math.max(0, ...knownTips(known).map((t) => t.createdAt))
}

const isZero = (oid: string): boolean => /^0*$/.test(oid)
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Read a probe's answer against what the page shows.
 *
 * - **Events**: an event not in the mark, of kind `headUpdate`, that the review fold would apply
 *   (`foldPrReviewV2`: any `event`; an `authorEvent` only by the PR's author), naming a head other
 *   than the page's: the PR head moved. Otherwise the mark moves up to the newest event read,
 *   unless the page was full (the events past it were not read).
 * - **The branch**: the newer of its two update types' newest. New commits were pushed when it
 *   names a tip (not a deletion) that is neither the PR head nor a tip the page read, and is newer
 *   than the update the page's state came from. An update the resolver ignores (a refused route,
 *   say) would look new on every read: once announced, its id is never announced again.
 */
export function interpretProbe(base: ProbeBase, res: CompositeResult): ProbeOutcome {
  const parts: PlainDocument[][] = [res.page, ...res.subs.map((_, i) => docsAt(res, i))]
  let at = 0
  let events: EventMark | null = base.events
  let headTip: string | null = null
  if (base.events !== null) {
    const known = new Set(base.events.ids)
    const [plain = [], author = []] = parts
    const fresh = (docs: PlainDocument[]): Event[] => docs.filter((d) => !known.has(str(d, '$id'))).flatMap((d) => toEvent(d) ?? [])
    // The fold's newest applied head update, in its order (`mergedLog`: `(createdAt, id)`, an
    // `event` before an `authorEvent` at equal keys): news only when it names another head than
    // the page's (a move away and back again is no move).
    const updates = mergedLog(fresh(plain), fresh(author), base.author).filter((e) => e.kind === HEAD_UPDATE && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test((e.oid ?? '').toLowerCase()))
    const newest = updates.at(-1)
    if (newest !== undefined && !same(newest.oid ?? '', base.headOid)) {
      at = newest.createdAt
      headTip = (newest.oid ?? '').toLowerCase()
    }
    if (headTip === null && plain.length < PROBE_EVENTS && author.length < PROBE_EVENTS) {
      const read = [...plain, ...author]
      const mark = eventMarkOf(read)
      if (mark.at > base.events.at) events = mark
      else if (mark.at === base.events.at) events = { at: mark.at, ids: [...new Set([...base.events.ids, ...mark.ids])] }
    }
  }
  const pushed = base.branch === null ? null : newBranchTip(base, parts.slice(base.events === null ? 0 : 2).flat())
  if (headTip !== null) return { found: { tip: pushed !== null && pushed.at >= at ? pushed.tip : headTip, headMoved: true, refUpdateId: pushed?.id ?? null }, events }
  return { found: pushed === null ? null : { tip: pushed.tip, headMoved: false, refUpdateId: pushed.id }, events }
}

/** The branch's new tip in `rows` (its newest update of either type), or null (see {@link interpretProbe}). */
function newBranchTip(base: ProbeBase, rows: readonly PlainDocument[]): { tip: string; at: number; id: string } | null {
  const latest = [...rows].sort((a, b) => num(b, '$createdAt') - num(a, '$createdAt') || (str(a, '$id') < str(b, '$id') ? 1 : -1))[0]
  if (latest === undefined) return null
  const id = str(latest, '$id')
  const tip = byteFieldToHex(latest, 'newOid').toLowerCase()
  const at = num(latest, '$createdAt')
  if (base.announced?.has(id) === true || isZero(tip) || same(tip, base.headOid)) return null
  if (knownTips(base.branch?.known ?? null).some((t) => same(t.oid, tip) || at <= t.createdAt)) return null
  return { tip, at, id }
}

/**
 * Probe once ({@link headProbeQuery}, {@link interpretProbe}). `onFallback`: the node or SDK
 * refused the composite and plain queries answered.
 */
export async function probeHead(sdk: EvoSDK, base: ProbeBase, opts: { readonly onFallback?: () => void } = {}): Promise<ProbeOutcome> {
  const q = headProbeQuery(base)
  if (q === null) return { found: null, events: base.events }
  return interpretProbe(base, await queryComposite(sdk, q, opts))
}
