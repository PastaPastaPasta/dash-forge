/**
 * The items a board folds (`docs/design/boards.md` §2.3, §2.4): the {@link BoardItem} facts of
 * every issue and PR its sources include and its cards name, read through the Issues and Pull
 * requests list indexes (labels, assignees, milestone, author, state: their folds, not a second
 * copy), then {@link assembleBoard} folds them with `now`.
 *
 * Per source repository, for the kinds its sources name:
 *
 * - every **open** issue or PR (the list's Open tab, page after page);
 * - the **recently closed or merged** ones: the repo's state changes newest first (`transition`
 *   `feed`, keyset pages of 100) name each target's latest move and its `closedAt` (the
 *   `$createdAt` of its latest move into closed or merged, §2.4); the walk stops past the
 *   auto-archive window (`arch` days: older ones are archived unless a card keeps them, and those
 *   are read by id below), or, with `arch` 0, at the {@link CLOSED_PER_REPO} most recently closed.
 *   {@link BoardItemSet.hasOlderClosed} says the walk stopped early; {@link loadOlderClosed}
 *   reads on (a view asking for `is:archived`, or "Show older").
 *
 * Then every item a card names that the sources did not bring: located by id in forge-collab
 * (`issue` or `patch`, any repository), read through its own repository's index, with its
 * `closedAt` from its transitions. One of a private repository this reader holds no session for,
 * or a public repository's members-only one it cannot open, is a placeholder
 * ({@link BoardItemSet.hidden}: "a private item"), placed by its card like any other.
 *
 * A private repository other than the home opens with the session the page holds for it
 * ({@link BoardItemsInput.repos}, {@link BoardItemsInput.sessionOf}: a member who opened it in
 * this tab). A source repository that is private and that this reader holds no session for
 * contributes nothing and is not read (its lists hide every item from a non-member); its items
 * still show as placeholders where a card names them.
 *
 * The reads go through a {@link BoardItemReader} ({@link boardItemReader} is the SDK's), so the
 * assembly is tested without one.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { PrivateSession } from './private-session'
import { foldBoard, type BoardFold, type BoardItem, type BoardSpec, type CardDoc, type ItemKind } from '../rules/boards'
import { compareStrings } from '../rules/oid'
import { ISSUE_CLOSE, ISSUE_LOCK, ISSUE_UNLOCK, PR_CLOSE, PR_DRAFT_CLOSE, PR_LOCK, PR_MERGE, PR_UNLOCK } from '../rules/transition'
import { queryAllDocuments, queryDocumentsWithProof } from '../sdk'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import type { BoardView } from './boards'
import { issueRowsById, queryIssues, type IssueRow, type IssueSelection } from './issue-index'
import { pullRowsById, queryPulls, type PullRow, type PullSelection } from './pull-index'
import { readRepoById, repoRefOf } from './resolveRepo'
import { repoSource } from './source'
import { transitionOf, type TransitionView } from './transitions'

const DAY_MS = 86_400_000
/** With auto-archive off, a source repository's closed items read at first are its most recently closed this many (§2.4). */
export const CLOSED_PER_REPO = 200
/** State-change pages (100 each) one load walks at most per repository. */
export const TRANSITION_PAGES = 20
/** A state-change page. */
const PAGE = 100
/** The transition kinds that move a target into closed or merged, and the kind of item each closes. */
const CLOSES: Readonly<Record<number, ItemKind>> = { [ISSUE_CLOSE]: 'issue', [PR_CLOSE]: 'pr', [PR_MERGE]: 'pr', [PR_DRAFT_CLOSE]: 'pr' }
/** Lock moves change no state: a target's latest state move is read past them. */
const LOCK_KINDS: ReadonlySet<number> = new Set([ISSUE_LOCK, ISSUE_UNLOCK, PR_LOCK, PR_UNLOCK])

/** What a board's item reads need (the SDK's: {@link boardItemReader}). */
export interface BoardItemReader {
  /** Every open issue (`issue`) or PR (`pr`) of `repo`; `complete` false when the list stopped short. */
  openItems(repo: RepoRef, kind: ItemKind): Promise<{ readonly items: readonly BoardItem[]; readonly complete: boolean }>
  /** One page of `repo`'s state changes, newest first, created at or before `before` (null: the newest). */
  transitions(repo: RepoRef, before: number | null): Promise<readonly TransitionView[]>
  /** One page of `repo`'s state changes created at exactly `at`, in `$id` order, after `startAfter` (a block of more than a page). */
  transitionsAt(repo: RepoRef, at: number, startAfter: string | null): Promise<readonly TransitionView[]>
  /** `repo`'s issues and PRs among `ids`, as the lists show them (an id that is neither, or hidden, is left out). */
  itemsById(repo: RepoRef, ids: readonly string[]): Promise<readonly BoardItem[]>
  /** Every transition of `ids` (`perTarget`), for their `closedAt`. */
  transitionsOf(repo: RepoRef, ids: readonly string[]): Promise<readonly TransitionView[]>
  /** The repository and kind of each of `ids` that is an issue or a PR (any repository). */
  locate(ids: readonly string[]): Promise<ReadonlyMap<string, { readonly repoId: string; readonly kind: ItemKind }>>
  /** Repository `repoId`, or null. */
  repo(repoId: string): Promise<RepoRef | null>
}

/** What a board's item assembly starts from. */
export interface BoardItemsInput {
  /** The board's home repository (as the page holds it: with its session, when private). */
  readonly home: RepoRef
  readonly spec: BoardSpec
  readonly cards: readonly CardDoc[]
  readonly now: number
  /**
   * The repositories the page already holds (with their sessions), by id: a source or card
   * repository found here is read as is, so a private one the reader is a member of opens.
   */
  readonly repos?: ReadonlyMap<string, RepoRef>
  /** How a repository is named on its items (`owner/name`, the card's label; display only); default its name. */
  readonly label?: (repo: RepoRef) => string
  /**
   * The session this reader already holds for a private repository other than the home (a
   * member who opened it in this tab), if any: its items then open instead of showing as "a
   * private item" (§2.5). Nothing is read to find one.
   */
  readonly sessionOf?: (repo: RepoRef) => PrivateSession | undefined
}

/** One source repository's closed-item walk. */
export interface ClosedWalk {
  /** Where the next page starts (`$createdAt <=`); null: at the newest change. */
  readonly before: number | null
  /** The walk reached the repo's first change: nothing older is left. */
  readonly done: boolean
  /** Targets whose latest state move the walk has seen (their state is settled by it). */
  readonly seen: ReadonlySet<string>
  /** Transitions already read at the `before` boundary (a `<=` page repeats them). */
  readonly boundary: ReadonlySet<string>
}

/** A board's items, ready to fold. */
export interface BoardItemSet {
  readonly items: readonly BoardItem[]
  /** Items shown as "a private item": a private repository's (no session) or a members-only one this reader cannot open. */
  readonly hidden: ReadonlySet<string>
  /** Card items that are no issue or PR this reader can find (dropped from the board). */
  readonly missing: ReadonlySet<string>
  /** A source's open list stopped short: the board may lack some open items. */
  readonly partial: boolean
  /** Some source repository has closed items older than were read ({@link loadOlderClosed}). */
  readonly hasOlderClosed: boolean
  /** Each source repository's closed walk, by repository id. */
  readonly walks: ReadonlyMap<string, ClosedWalk>
}

/** The source repositories of `spec` and the kinds each is read for. */
function sourceKinds(spec: BoardSpec, home: string): Map<string, Set<ItemKind>> {
  const out = new Map<string, Set<ItemKind>>()
  for (const s of spec.sources) {
    const r = s.r ?? home
    const kinds = out.get(r) ?? new Set<ItemKind>()
    if (s.k !== 'p') kinds.add('issue')
    if (s.k !== 'i') kinds.add('pr')
    out.set(r, kinds)
  }
  return out
}

/** Repository `repoId`: the home, one the page holds, or read; a private one with the session this reader holds for it, if any. */
async function repoOf(reader: BoardItemReader, input: BoardItemsInput, repoId: string): Promise<RepoRef | null> {
  if (repoId === input.home.repoId) return input.home
  const repo = input.repos?.get(repoId) ?? (await reader.repo(repoId))
  if (repo === null || repo.visibility !== 'private' || repo.session !== undefined) return repo
  const session = input.sessionOf?.(repo)
  return session === undefined ? repo : { ...repo, session }
}

/** Whether `repo` is private and this reader holds no session for it: its lists show nothing. */
const sealedFor = (repo: RepoRef): boolean => repo.visibility === 'private' && repo.session === undefined

/** A placeholder for an item this reader cannot open ("a private item"): only what is plaintext about it. */
function placeholder(id: string, repoId: string, kind: ItemKind): BoardItem {
  return { id, number: 0, repoId, kind, state: 'open', createdAt: 0, closedAt: null, title: '', labels: [], assignees: [], milestone: null, author: '' }
}

/**
 * Walk `repo`'s state changes newest first from `walk`, stopping before the first change `stop`
 * refuses (or at the repo's first change, or after {@link TRANSITION_PAGES} pages): each target's
 * latest state move decides whether it is closed (with its `closedAt`). The walk it returns
 * resumes exactly where this one stopped: the next page reads `$createdAt <=` the last change
 * read, skipping those of that time already read.
 */
async function walkClosed(
  reader: BoardItemReader,
  repo: RepoRef,
  walk: ClosedWalk,
  kinds: ReadonlySet<ItemKind>,
  stop: (counted: number, next: TransitionView) => boolean,
): Promise<{ readonly closed: Map<string, number>; readonly walk: ClosedWalk }> {
  const seen = new Set(walk.seen)
  const closed = new Map<string, number>()
  // closed items of the sources' kinds found so far
  let counted = 0
  let before = walk.before
  // the changes read at `before`'s time (a later page at `<=` repeats them)
  let boundary = new Set(walk.boundary)
  /** Take one change; false when `stop` ends the walk before it. */
  const take = (t: TransitionView): boolean => {
    if (stop(counted, t)) return false
    if (t.createdAt !== before) {
      before = t.createdAt
      boundary = new Set()
    }
    boundary.add(t.id)
    if (LOCK_KINDS.has(t.kind) || t.targetId === '' || seen.has(t.targetId)) return true
    seen.add(t.targetId)
    const closes = CLOSES[t.kind]
    if (closes !== undefined) {
      closed.set(t.targetId, t.createdAt)
      if (kinds.has(closes)) counted++
    }
    return true
  }
  const paused = () => ({ closed, walk: { before, done: false, seen, boundary } })
  for (let page = 0; page < TRANSITION_PAGES; page++) {
    const rows = await reader.transitions(repo, before)
    let progressed = false
    for (const t of rows) {
      if (before !== null && t.createdAt === before && boundary.has(t.id)) continue
      if (!take(t)) return paused()
      progressed = true
    }
    if (rows.length < PAGE) return { closed, walk: { before, done: true, seen, boundary } }
    if (progressed || before === null) continue
    // A full page of one time, every row already read: a block of more than a page. Read the rest
    // of that time by `$id`, then step past it (`<=` one millisecond earlier).
    const at: number = before
    let after: string | null = null
    for (;;) {
      const tied = await reader.transitionsAt(repo, at, after)
      for (const t of tied) {
        if (boundary.has(t.id)) continue
        if (!take(t)) return paused()
      }
      if (tied.length < PAGE) break
      after = tied[tied.length - 1]?.id ?? null
    }
    before = at - 1
    boundary = new Set()
  }
  return paused()
}

/** An issue row as the board reads it. */
export function boardItemOfIssue(row: IssueRow, repo: RepoRef, closedAt: number | null, label: string): BoardItem {
  return {
    id: row.id,
    number: row.number,
    repoId: repo.repoId,
    repo: label,
    kind: 'issue',
    state: row.state.open ? 'open' : 'closed',
    createdAt: row.createdAt,
    closedAt: row.state.open ? null : closedAt,
    title: row.title,
    labels: row.state.labels,
    assignees: row.state.assignees,
    milestone: row.milestone ?? null,
    author: row.author,
  }
}

/** A PR row as the board reads it. */
export function boardItemOfPull(row: PullRow, repo: RepoRef, closedAt: number | null, label: string): BoardItem {
  const state = row.state.merged ? 'merged' : row.state.open ? 'open' : 'closed'
  return {
    id: row.id,
    number: row.number,
    repoId: repo.repoId,
    repo: label,
    kind: 'pr',
    state,
    createdAt: row.createdAt,
    closedAt: state === 'open' ? null : closedAt,
    title: row.title,
    labels: row.state.labels,
    assignees: row.state.assignees,
    milestone: row.review.milestone,
    author: row.author,
  }
}

/** Each of `ids`' `closedAt`: the `$createdAt` of its latest move into closed or merged. */
function closedAtOf(transitions: readonly TransitionView[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of transitions) {
    if (CLOSES[t.kind] === undefined) continue
    const prev = out.get(t.targetId)
    if (prev === undefined || t.createdAt > prev) out.set(t.targetId, t.createdAt)
  }
  return out
}

/** `items` with `closedAt` set from `closed` where it was unknown. */
function withClosedAt(items: readonly BoardItem[], closed: ReadonlyMap<string, number>): BoardItem[] {
  return items.map((i) => (i.state === 'open' || i.closedAt !== null || !closed.has(i.id) ? i : { ...i, closedAt: closed.get(i.id) as number }))
}

/**
 * Where a board's first walk stops (§2.4): before the first change older than the auto-archive
 * window (`arch` days: older closes are archived unless a card keeps them, and those are read by
 * id), or, with `arch` 0, once {@link CLOSED_PER_REPO} closed items are found.
 */
function stopFor(arch: number, now: number): (counted: number, next: TransitionView) => boolean {
  return arch > 0 ? (_counted, next) => next.createdAt < now - arch * DAY_MS : stopAtCount
}

/** Stop once {@link CLOSED_PER_REPO} closed items of the sources' kinds are found. */
const stopAtCount = (counted: number): boolean => counted >= CLOSED_PER_REPO

/** The items `cards` name that `items` lacks, read by id in their own repositories (placeholders where they cannot be opened). */
async function cardItems(reader: BoardItemReader, input: BoardItemsInput, have: ReadonlySet<string>): Promise<{ items: BoardItem[]; hidden: Set<string>; missing: Set<string> }> {
  const label = input.label ?? ((r: RepoRef) => r.name)
  const wanted = [...new Set(input.cards.map((c) => c.item))].filter((id) => !have.has(id)).sort(compareStrings)
  const items: BoardItem[] = []
  const hidden = new Set<string>()
  const missing = new Set<string>()
  if (wanted.length === 0) return { items, hidden, missing }
  const located = await reader.locate(wanted)
  const byRepo = new Map<string, string[]>()
  for (const id of wanted) {
    const at = located.get(id)
    if (at === undefined) missing.add(id)
    else byRepo.set(at.repoId, [...(byRepo.get(at.repoId) ?? []), id])
  }
  for (const [repoId, ids] of byRepo) {
    const repo = await repoOf(reader, input, repoId)
    if (repo === null) {
      for (const id of ids) missing.add(id)
      continue
    }
    if (sealedFor(repo)) {
      for (const id of ids) {
        hidden.add(id)
        items.push(placeholder(id, repoId, located.get(id)?.kind ?? 'issue'))
      }
      continue
    }
    const rows = await reader.itemsById(repo, ids)
    const closed = closedAtOf(await reader.transitionsOf(repo, rows.filter((r) => r.state !== 'open').map((r) => r.id)))
    const got = new Set<string>()
    for (const r of withClosedAt(rows, closed)) {
      got.add(r.id)
      items.push(r.repo === undefined ? { ...r, repo: label(repo) } : r)
    }
    for (const id of ids) {
      if (got.has(id)) continue
      // located but not shown by its list: a members-only (or malformed) item this reader cannot open
      hidden.add(id)
      items.push(placeholder(id, repoId, located.get(id)?.kind ?? 'issue'))
    }
  }
  return { items, hidden, missing }
}

/** Whether `row` is a placeholder the lists keep for content this reader cannot open. */
function membersOnlyRow(row: { readonly membersOnly?: true }): boolean {
  return row.membersOnly === true
}

/**
 * Every item of the board `input` describes (see the module header): its sources' open items,
 * their closed ones in the window, and the items its cards name. Ready for {@link assembleBoard}.
 */
export async function loadBoardItems(reader: BoardItemReader, input: BoardItemsInput): Promise<BoardItemSet> {
  const sources = sourceKinds(input.spec, input.home.repoId)
  const byId = new Map<string, BoardItem>()
  const walks = new Map<string, ClosedWalk>()
  let partial = false
  for (const [repoId, kinds] of sources) {
    const repo = await repoOf(reader, input, repoId)
    // a private source without a session: its lists would hide every row, so it is not read
    if (repo === null || sealedFor(repo)) continue
    for (const kind of kinds) {
      const open = await reader.openItems(repo, kind)
      partial ||= !open.complete
      for (const i of open.items) byId.set(i.id, i)
    }
    const { closed, walk } = await walkClosed(reader, repo, { before: null, done: false, seen: new Set(), boundary: new Set() }, kinds, stopFor(input.spec.arch, input.now))
    walks.set(repoId, walk)
    await addClosed(reader, repo, kinds, closed, byId)
  }
  const extra = await cardItems(reader, input, new Set(byId.keys()))
  for (const i of extra.items) byId.set(i.id, i)
  return { items: [...byId.values()], hidden: extra.hidden, missing: extra.missing, partial, hasOlderClosed: [...walks.values()].some((w) => !w.done), walks }
}

/** Read the closed items `closed` names (of the source `kinds`) into `byId`, each with its `closedAt`. */
async function addClosed(reader: BoardItemReader, repo: RepoRef, kinds: ReadonlySet<ItemKind>, closed: ReadonlyMap<string, number>, byId: Map<string, BoardItem>): Promise<void> {
  const ids = [...closed.keys()].filter((id) => !byId.has(id))
  for (const r of withClosedAt(await reader.itemsById(repo, ids), closed)) {
    // the walk said closed; the row's own proved state decides (a reopen the page missed)
    if (kinds.has(r.kind)) byId.set(r.id, r)
  }
}

/**
 * `set` with the next stretch of each source repository's older closed items ({@link
 * CLOSED_PER_REPO} more, or {@link TRANSITION_PAGES} pages): what a view asking for archived
 * items, or "Show older", reads. Unchanged when nothing is older.
 */
export async function loadOlderClosed(reader: BoardItemReader, input: BoardItemsInput, set: BoardItemSet): Promise<BoardItemSet> {
  const sources = sourceKinds(input.spec, input.home.repoId)
  const byId = new Map(set.items.map((i) => [i.id, i]))
  const walks = new Map(set.walks)
  for (const [repoId, walk] of set.walks) {
    if (walk.done) continue
    const repo = await repoOf(reader, input, repoId)
    const kinds = sources.get(repoId)
    if (repo === null || kinds === undefined || sealedFor(repo)) continue
    const { closed, walk: next } = await walkClosed(reader, repo, walk, kinds, stopAtCount)
    walks.set(repoId, next)
    await addClosed(reader, repo, kinds, closed, byId)
  }
  return { ...set, items: [...byId.values()], walks, hasOlderClosed: [...walks.values()].some((w) => !w.done) }
}

/**
 * `set` with the items `cards` name that it lacks (a poll's new cards, a quick add's new issue),
 * read as {@link loadBoardItems} reads card items.
 */
export async function addCardItems(reader: BoardItemReader, input: BoardItemsInput, set: BoardItemSet): Promise<BoardItemSet> {
  const have = new Set([...set.items.map((i) => i.id), ...set.missing])
  if (input.cards.every((c) => have.has(c.item))) return set
  const extra = await cardItems(reader, input, have)
  return {
    ...set,
    items: [...set.items, ...extra.items],
    hidden: new Set([...set.hidden, ...extra.hidden]),
    missing: new Set([...set.missing, ...extra.missing]),
  }
}

/** `set` with `item` in it (replacing the one with its id): an item a write just changed or made. */
export function withItem(set: BoardItemSet, item: BoardItem): BoardItemSet {
  return { ...set, items: [...set.items.filter((i) => i.id !== item.id), item] }
}

/** Board `board` folded over `set` and `cards` at `now` (§2.4); null when its definition did not open. */
export function assembleBoard(board: BoardView, set: BoardItemSet, cards: readonly CardDoc[], now: number): BoardFold | null {
  if (board.spec === null) return null
  return foldBoard({ spec: board.spec, home: board.repoId, items: set.items, cards, now })
}

// ---------------------------------------------------------------------------------------------
// The SDK's reader
// ---------------------------------------------------------------------------------------------

/** Open-list pages one source reads at most (100 each). */
const OPEN_PAGES = 30
/** Times one page is read on when it stopped at its chunk budget. */
const READ_ON = 5

/** Every row of a list's Open tab, page after page (each read on while it stopped at its budget). */
async function allOpen<Row extends { readonly id: string }>(page: (p: number) => Promise<{ readonly rows: readonly Row[]; readonly hasNext: boolean; readonly searchedOf: { readonly more: boolean } | null }>): Promise<{ rows: Row[]; complete: boolean }> {
  const byId = new Map<string, Row>()
  for (let p = 1, tries = 0; p <= OPEN_PAGES; ) {
    const r = await page(p)
    for (const row of r.rows) byId.set(row.id, row)
    if (r.hasNext) {
      p++
      tries = 0
    } else if (r.searchedOf?.more === true && tries < READ_ON) {
      tries++
    } else {
      return { rows: [...byId.values()], complete: r.searchedOf?.more !== true }
    }
  }
  return { rows: [...byId.values()], complete: false }
}

const OPEN_ISSUES: Omit<IssueSelection, 'page'> = { state: 'open', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', pageSize: PAGE }
const OPEN_PULLS: Omit<PullSelection, 'page'> = { state: 'open', labels: [], author: null, assignee: null, sort: 'newest', text: '', pageSize: PAGE }

/**
 * The SDK's {@link BoardItemReader} for the deployment `forge` on `network`: the Issues and Pull
 * requests list indexes (cached per repo for the session, dropped by a write), the `transition`
 * `feed` and `perTarget` indexes, forge-collab by `$id`, and the `repo` document by id. `label`
 * names a repository on its items.
 */
export function boardItemReader(sdk: EvoSDK, forge: ForgeIds, network: Network = DEFAULT_NETWORK, label: (repo: RepoRef) => string = (r) => r.name): BoardItemReader {
  return {
    async openItems(repo, kind) {
      if (kind === 'issue') {
        const { rows, complete } = await allOpen((page) => queryIssues(sdk, repo, { ...OPEN_ISSUES, page }, null, network))
        return { items: rows.filter((r) => !membersOnlyRow(r)).map((r) => boardItemOfIssue(r, repo, null, label(repo))), complete }
      }
      const { rows, complete } = await allOpen((page) => queryPulls(sdk, repo, { ...OPEN_PULLS, page }, null, network))
      return { items: rows.filter((r) => !membersOnlyRow(r)).map((r) => boardItemOfPull(r, repo, null, label(repo))), complete }
    },
    async transitions(repo, before) {
      const { documents } = await queryDocumentsWithProof(sdk, {
        ...repoSource(repo).repoQuery(DOC.transition, { where: before === null ? [] : [['$createdAt', '<=', before]], orderBy: [['$createdAt', 'desc']] }),
        limit: PAGE,
      })
      return documents.map(transitionOf)
    },
    async transitionsAt(repo, at, startAfter) {
      const { documents } = await queryDocumentsWithProof(sdk, {
        ...repoSource(repo).repoQuery(DOC.transition, { where: [['$createdAt', '==', at]], orderBy: [['$createdAt', 'asc']] }),
        limit: PAGE,
        ...(startAfter !== null ? { startAfter } : {}),
      })
      return documents.map(transitionOf)
    },
    async itemsById(repo, ids) {
      const issues = (await issueRowsById(sdk, repo, ids, network)).filter((r) => !membersOnlyRow(r))
      const got = new Set(issues.map((r) => r.id))
      const pulls = (await pullRowsById(sdk, repo, ids.filter((id) => !got.has(id)), network)).filter((r) => !membersOnlyRow(r))
      return [...issues.map((r) => boardItemOfIssue(r, repo, null, label(repo))), ...pulls.map((r) => boardItemOfPull(r, repo, null, label(repo)))]
    },
    async transitionsOf(repo, ids) {
      const out: TransitionView[] = []
      const sorted = [...new Set(ids)].sort()
      for (let i = 0; i < sorted.length; i += PAGE) {
        const batch = sorted.slice(i, i + PAGE)
        const docs = await queryAllDocuments(sdk, repoSource(repo).targetQuery(DOC.transition, { where: [['targetId', 'in', batch]], orderBy: [['targetId', 'asc']] }))
        out.push(...docs.map(transitionOf))
      }
      return out
    },
    async locate(ids) {
      const out = new Map<string, { repoId: string; kind: ItemKind }>()
      // any repository's forge-collab: the network's, which every repository shares
      const anyRepo: RepoRef = { forge, repoId: '', ownerId: '', name: '', visibility: 'public' }
      for (const [type, kind] of [[DOC.issue, 'issue'], [DOC.patch, 'pr']] as const) {
        const todo = ids.filter((id) => !out.has(id))
        for (let i = 0; i < todo.length; i += PAGE) {
          const batch = todo.slice(i, i + PAGE)
          const { documents } = await queryDocumentsWithProof(sdk, { ...repoSource(anyRepo).targetQuery(type, { where: [['$id', 'in', batch]], orderBy: [['$id', 'asc']] }), limit: PAGE })
          for (const d of documents) {
            const id = typeof d['$id'] === 'string' ? d['$id'] : ''
            const repoId = asIdentifierString(d['repoId'])
            if (id !== '' && repoId !== '') out.set(id, { repoId, kind })
          }
        }
      }
      return out
    },
    async repo(repoId) {
      const doc = await readRepoById(sdk, forge, repoId)
      return doc === null ? null : repoRefOf(forge, doc)
    },
  }
}
