/**
 * Boards: reading a repository's boards and cards (`docs/design/boards.md`; forge-meta `board`
 * and `card`, UPDATE-3). The data layer the board pages are built on, in three modules:
 *
 * - **Reads** (here): {@link readBoards} (a repo's boards, newest revision per key over every
 *   member's, deleted dropped), {@link readBoard} (one board's definition and every card, the
 *   `card.recent` index, 100 per page), {@link readCardsSince} (the 20 s poll, §5.7: `$updatedAt
 *   >=` the last read, deduplicated by `$id` with {@link mergeCards}), {@link readItemCards} (an
 *   issue's or PR's sidebar, §5.6: `card.onItem`, only boards whose home is the item's repository
 *   or another repository of the same owner) and {@link itemPlacement} (its status there).
 * - **Items** (`./board-items`): the fold's {@link BoardItem} facts for a board's sources and
 *   cards, from the issue and pull list indexes, then {@link foldBoard} (`lib/rules/boards.ts`).
 * - **Writes** (`./board-writes`): create / save / close / delete a board, and every card write
 *   (move, fields, add, archive, remove, quick add, re-rank, next iteration), each one document
 *   operation, role-checked and refused before signing where the contract or the rules would
 *   refuse it, a card written over a fresh read of the item's newest card (§3.2).
 *
 * A private repository's boards and cards are sealed (`lib/private/board.ts`, private-repos.md
 * §4.6): a reader with the repo's session opens them; without it a board reads with no name or
 * definition and a card with no column, rank or fields. A public repository's sealed ones (a
 * repository made public, §18: opened with its published keys; a later client's members-only
 * boards) read the same way when they do not open: unreadable, never dropped, so newest-wins
 * never brings an older revision back. A document carrying plaintext content beside `enc`, a
 * private one without `enc`, or one whose seal is malformed is skipped by every reader; a write
 * still finds the signer's own document among the raw rows ({@link BoardView.revisions},
 * {@link readItemCardDocs}), so a member is never locked out of replacing it.
 *
 * Which writes a signer may make (`boards.md` §5.1): {@link canPlaceCards} (maintainers, writers,
 * triage) and {@link canEditBoards} (maintainers, writers).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { openBoardDoc, type BoardBind, type BoardFields, type CardFields, type StoredBoardDoc } from '../private'
import { BOARD_CLOSED, BOARD_DELETED, BOARD_OPEN, foldBoard, newestBoards, newestCards, parseSpec, type BoardDoc, type BoardItem, type BoardSpec, type CardDoc, type Placement, type SpecError } from '../rules/boards'
import { compareStrings } from '../rules/oid'
import type { Role } from '../rules/v2'
import { queryAllDocuments, queryDocumentsWithProof, type DocumentQuery, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, num, str, type RepoRef } from './contract'
import { bytesField, idField } from './private-content'
import { readOwnerRepos, repoRefOf } from './resolveRepo'
import { repoSource } from './source'

/** A board's state (§3.1 `state`): open, closed (read-only, listed under Closed) or deleted. */
export type BoardState = 'open' | 'closed' | 'deleted'

const STATE_OF: Readonly<Record<number, BoardState>> = { [BOARD_OPEN]: 'open', [BOARD_CLOSED]: 'closed', [BOARD_DELETED]: 'deleted' }
/** The `board.state` integer of each state. */
export const BOARD_STATE_CODE: Readonly<Record<BoardState, number>> = { open: BOARD_OPEN, closed: BOARD_CLOSED, deleted: BOARD_DELETED }

/** One member's revision of a board: one document per (home repo, key, member), replaced in place. */
export interface BoardRevision {
  readonly id: string
  readonly ownerId: string
  readonly updatedAt: number
}

/** A board as its newest revision defines it. */
export interface BoardView {
  readonly key: number
  /** The home repository's id. */
  readonly repoId: string
  readonly state: BoardState
  /** Null when it could not be read: a private repository's board without the repo's key. */
  readonly name: string | null
  /** The parsed definition; null when it could not be read or was refused ({@link specError}). */
  readonly spec: BoardSpec | null
  /** Why {@link spec} is null: the rules' refusal, or `unreadable` (sealed, no key). */
  readonly specError: SpecError | 'unreadable' | null
  /** The definition is sealed (a private repository's). */
  readonly sealed: boolean
  /** The newest revision (its writer and time: "edited by … "). */
  readonly newest: BoardRevision
  /**
   * Every member's revision document, oldest first, malformed ones included (a save replaces the
   * signer's own, {@link ownRevision}, whatever it holds).
   */
  readonly revisions: readonly BoardRevision[]
}

/**
 * A card as read (the rules' {@link CardDoc}). `unreadable`: a sealed card this reader could not
 * open (no key, a later client's version): its column, rank and fields are unknown, not empty.
 * `revision`: the document's `$revision` when the read (or the write that made it) knows it: what
 * tells a fresh read that lags behind this client's own write (`overIfAhead`, §3.2).
 */
export type BoardCard = CardDoc & { readonly unreadable?: true; readonly revision?: number }

/** A document's `$revision`, when it has one. */
function revisionOf(doc: PlainDocument): number | undefined {
  const v = doc['$revision']
  const n = typeof v === 'bigint' ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** One board and every card on it, as {@link readBoard} reads them. */
export interface BoardRead {
  readonly board: BoardView
  readonly cards: readonly BoardCard[]
  /** The newest `$updatedAt` among the cards (0 when none): the next poll reads from here. */
  readonly since: number
}

/** The signer's own revision of a board, if they wrote one. */
export function ownRevision(board: BoardView, me: string): BoardRevision | null {
  return board.revisions.find((r) => r.ownerId === me) ?? null
}

/** Whether `role` may place cards: move, rank, set fields, add, archive, remove (§5.1). */
export function canPlaceCards(role: Role | null | undefined): boolean {
  return role === 'maintainer' || role === 'writer' || role === 'triage'
}

/** Whether `role` may create, edit, close or delete a board and save views (§5.1). */
export function canEditBoards(role: Role | null | undefined): boolean {
  return role === 'maintainer' || role === 'writer'
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** A u32 integer field (content integers come back as bigint or number), or null. */
function u32Of(doc: PlainDocument, field: string): number | null {
  const v = doc[field]
  const n = typeof v === 'bigint' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}

function present(doc: PlainDocument, field: string): boolean {
  return doc[field] !== undefined && doc[field] !== null
}

/** A stored document's sealed form for `openBoardDoc`, or null when it names no owner. */
function storedOf(doc: PlainDocument, bind: BoardBind, plain: readonly string[]): StoredBoardDoc | null {
  const ownerId = idField(doc, '$ownerId')
  if (ownerId === undefined) return null
  const epoch = u32Of(doc, 'epoch')
  const enc = bytesField(doc, 'enc')
  return { bind, ownerId, ...(epoch !== null ? { epoch } : {}), ...(enc !== undefined ? { enc } : {}), hasPlaintextContent: plain.some((f) => present(doc, f)) }
}

/** The session that opens `repo`'s sealed boards and cards: a member's, or a repository made public's published keys. */
function openerOf(repo: RepoRef) {
  return repo.visibility === 'private' ? repo.session : repo.published
}

/**
 * A `board` document as the rules read it ({@link BoardDoc}), opened where it is sealed; null
 * when malformed (plaintext content beside `enc`, a private board without `enc`, a broken seal),
 * which every reader skips. A sealed board this reader cannot open reads with no name or spec.
 */
export async function boardDocOf(repo: RepoRef, doc: PlainDocument): Promise<(BoardDoc & { readonly sealed: boolean }) | null> {
  const key = u32Of(doc, 'key')
  const state = u32Of(doc, 'state')
  if (key === null || key === 0 || state === null || state > BOARD_DELETED) return null
  const base = { id: str(doc, '$id'), ownerId: str(doc, '$ownerId'), updatedAt: num(doc, '$updatedAt'), key, state }
  if (!present(doc, 'enc')) {
    if (repo.visibility === 'private') return null
    return { ...base, name: typeof doc['name'] === 'string' ? doc['name'] : null, spec: typeof doc['spec'] === 'string' ? doc['spec'] : null, sealed: false }
  }
  const stored = storedOf(doc, { type: 'board', key }, ['name', 'spec'])
  if (stored === null || stored.hasPlaintextContent) return null
  const opener = openerOf(repo)
  if (opener === undefined) return { ...base, name: null, spec: null, sealed: true }
  const opened = await openBoardDoc(opener.ctx, stored)
  if (opened.status === 'malformed') return null
  const fields = opened.status === 'readable' ? (opened.fields as BoardFields) : null
  return { ...base, name: fields?.name ?? null, spec: fields?.spec ?? null, sealed: true }
}

/**
 * A `card` document as the rules read it ({@link CardDoc}), opened where it is sealed: one this
 * reader cannot open keeps its `state`, marked `unreadable`. Null when malformed (as
 * {@link boardDocOf}).
 */
export async function cardDocOf(repo: RepoRef, doc: PlainDocument): Promise<BoardCard | null> {
  const board = u32Of(doc, 'board')
  const state = u32Of(doc, 'state')
  const item = asIdentifierString(doc['item'])
  if (board === null || board === 0 || state === null || state > 2 || item === '') return null
  const revision = revisionOf(doc)
  const base = { id: str(doc, '$id'), ownerId: str(doc, '$ownerId'), updatedAt: num(doc, '$updatedAt'), item, state, ...(revision !== undefined ? { revision } : {}) }
  if (!present(doc, 'enc')) {
    if (repo.visibility === 'private') return null
    const col = u32Of(doc, 'col')
    return { ...base, col: col !== null && col <= 255 ? col : null, rank: typeof doc['rank'] === 'string' ? doc['rank'] : null, f: typeof doc['f'] === 'string' ? doc['f'] : null }
  }
  let itemBytes: Uint8Array
  try {
    itemBytes = decodeIdentifier(item)
  } catch {
    return null
  }
  const stored = storedOf(doc, { type: 'card', board, item: itemBytes }, ['col', 'rank', 'f'])
  if (stored === null || stored.hasPlaintextContent) return null
  const unread: BoardCard = { ...base, col: null, rank: null, f: null, unreadable: true }
  const opener = openerOf(repo)
  if (opener === undefined) return unread
  const opened = await openBoardDoc(opener.ctx, stored)
  if (opened.status === 'malformed') return null
  if (opened.status !== 'readable') return unread
  const fields = opened.fields as CardFields
  return { ...base, col: fields.col ?? null, rank: fields.rank ?? null, f: fields.f ?? null }
}

/** `docs` as cards of `repo`, the malformed dropped. */
async function cardsOf(repo: RepoRef, docs: readonly PlainDocument[]): Promise<BoardCard[]> {
  return (await Promise.all(docs.map((d) => cardDocOf(repo, d)))).filter((c): c is BoardCard => c !== null)
}

/** The views of `repo`'s board documents, newest revision per key ({@link newestBoards}). */
async function boardViews(repo: RepoRef, docs: readonly PlainDocument[], withDeleted: boolean): Promise<BoardView[]> {
  const opened = (await Promise.all(docs.map((d) => boardDocOf(repo, d)))).filter((d): d is NonNullable<typeof d> => d !== null)
  const sealed = new Map(opened.map((d) => [d.id, d.sealed]))
  // every revision document, the skipped ones too: a write replaces the signer's own whatever it holds
  const byKey = new Map<number, BoardRevision[]>()
  for (const d of docs) {
    const key = u32Of(d, 'key')
    if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), { id: str(d, '$id'), ownerId: str(d, '$ownerId'), updatedAt: num(d, '$updatedAt') }])
  }
  return newestBoards(opened, withDeleted).map((d) => {
    const parsed = d.spec === null ? null : parseSpec(d.spec)
    const revisions = (byKey.get(d.key) ?? []).sort((a, b) => a.updatedAt - b.updatedAt || compareStrings(a.id, b.id))
    return {
      key: d.key,
      repoId: repo.repoId,
      state: STATE_OF[d.state] ?? 'open',
      name: d.name,
      spec: parsed !== null && 'spec' in parsed ? parsed.spec : null,
      specError: parsed === null ? 'unreadable' : 'error' in parsed ? parsed.error : null,
      sealed: sealed.get(d.id) === true,
      newest: { id: d.id, ownerId: d.ownerId, updatedAt: d.updatedAt },
      revisions,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Card pages a board read follows at most (100 each: 100,000 cards). */
const CARD_MAX_PAGES = 1000

/**
 * Every board of `repo` (`board.byKey`, `repoId ==`): per key the newest revision over every
 * member's by (`$updatedAt`, `$id`), ascending by key, open and closed; deleted ones (state 2)
 * only with `withDeleted`.
 */
export async function readBoards(sdk: EvoSDK, repo: RepoRef, { withDeleted = false }: { readonly withDeleted?: boolean } = {}): Promise<BoardView[]> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.board, { orderBy: [['key', 'asc'], ['$ownerId', 'asc']] }))
  return boardViews(repo, docs, withDeleted)
}

/**
 * Board `key` of `repo` as its newest revision defines it (every member's revision of it read
 * fresh), or null when it has none. A deleted board reads as deleted (never null), so a page can
 * say so.
 */
export async function readBoardDefinition(sdk: EvoSDK, repo: RepoRef, key: number): Promise<BoardView | null> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.board, { where: [['key', '==', key]], orderBy: [['key', 'asc'], ['$ownerId', 'asc']] }))
  return (await boardViews(repo, docs, true))[0] ?? null
}

/** The `card.recent` query of board `key` of `repo`, oldest change first (from `sinceMs`, inclusive). */
function recentQuery(repo: RepoRef, key: number, sinceMs: number | null) {
  return repoSource(repo).repoQuery(DOC.card, {
    where: [['board', '==', key], ...(sinceMs === null ? [] : [['$updatedAt', '>=', sinceMs] as const])],
    orderBy: [['board', 'asc'], ['$updatedAt', 'asc']],
  })
}

/** The newest `$updatedAt` of `cards`, or 0. */
export function cardsSince(cards: readonly BoardCard[]): number {
  return cards.reduce((m, c) => Math.max(m, c.updatedAt), 0)
}

/**
 * Board `key` of `repo`: its definition and every card on it, every member's (`card.recent`,
 * 100 per page), or null when the board has no revision. Cards of a board whose definition did
 * not open are still read (their states are plaintext).
 */
export async function readBoard(sdk: EvoSDK, repo: RepoRef, key: number): Promise<BoardRead | null> {
  const [board, docs] = await Promise.all([readBoardDefinition(sdk, repo, key), queryAllDocuments(sdk, recentQuery(repo, key, null), { maxPages: CARD_MAX_PAGES })])
  if (board === null) return null
  const cards = mergeCards([], await cardsOf(repo, docs))
  return { board, cards, since: cardsSince(cards) }
}

/**
 * The cards of board `key` written or replaced at or after `sinceMs` (§5.7's poll): `>=`, since
 * several cards can share a block time and the last read may have stopped inside it, so a caller
 * merges them by `$id` ({@link mergeCards}).
 */
export async function readCardsSince(sdk: EvoSDK, repo: RepoRef, key: number, sinceMs: number): Promise<BoardCard[]> {
  return cardsOf(repo, await queryAllDocuments(sdk, recentQuery(repo, key, sinceMs), { maxPages: CARD_MAX_PAGES }))
}

/**
 * `held` with `fresh` merged in by `$id`: a card document is replaced in place (same `$id`, a
 * later `$updatedAt`), so the later of two copies wins; a copy read twice (a poll's `>=`
 * boundary) is kept once. Ordered by (`$updatedAt`, `$id`).
 */
export function mergeCards(held: readonly BoardCard[], fresh: readonly BoardCard[]): BoardCard[] {
  const byId = new Map<string, BoardCard>()
  for (const c of [...held, ...fresh]) {
    const prev = byId.get(c.id)
    if (prev === undefined || c.updatedAt >= prev.updatedAt) byId.set(c.id, c)
  }
  return [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt || compareStrings(a.id, b.id))
}

/** Every member's card for one item on one board, and the `$id` of `me`'s own card document (whatever it holds). */
export interface ItemCardDocs {
  readonly cards: readonly BoardCard[]
  readonly own: string | null
}

/**
 * Every member's card for one item on board `key` of `repo`, read fresh (`card.onItem`, `item ==`
 * then the home repo and board): what a card write applies its change to (§3.2), and the signer
 * `me`'s own card document, found among the raw rows (one this reader skips as malformed is still
 * the one the unique index holds, and the one a write replaces).
 */
export async function readItemCardDocs(sdk: EvoSDK, repo: RepoRef, key: number, itemId: string, me: string): Promise<ItemCardDocs> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.card, {
      where: [
        ['item', '==', itemId],
        ['repoId', '==', repo.repoId],
        ['board', '==', key],
      ],
      orderBy: [['repoId', 'asc'], ['board', 'asc']],
    }),
  )
  const own = docs.find((d) => str(d, '$ownerId') === me)
  return { cards: await cardsOf(repo, docs), own: own === undefined ? null : str(own, '$id') }
}

/** One board an issue or PR is on, for its sidebar (§5.6). */
export interface ItemBoard {
  /** The board's home repository. */
  readonly home: RepoRef
  readonly board: BoardView
  /** Every member's card for the item on this board. */
  readonly cards: readonly BoardCard[]
  /** The newest of them (§2.4), or null. */
  readonly card: BoardCard | null
}

/** Pages of an owner's repositories the sidebar reads (100 each): the homes its boards may live in. */
export const OWNER_REPO_PAGES = 3
/** Pages of cards one `card.onItem` read of the sidebar follows at most (100 each). */
export const ITEM_CARD_PAGES = 3

/** Up to `maxPages` pages of `query` (100 each), page after page: a bounded window, never an error past it. */
async function readPages(sdk: EvoSDK, query: DocumentQuery, maxPages: number): Promise<PlainDocument[]> {
  const out: PlainDocument[] = []
  let startAfter: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const { documents } = await queryDocumentsWithProof(sdk, { ...query, limit: 100, ...(startAfter !== undefined ? { startAfter } : {}) })
    out.push(...documents)
    const last = documents[documents.length - 1]?.['$id']
    if (documents.length < 100 || typeof last !== 'string') break
    startAfter = last
  }
  return out
}

/**
 * The repositories whose boards `repo`'s items show in their sidebar (§5.6): `repo` itself, and
 * its owner's other public repositories (at most {@link OWNER_REPO_PAGES} pages of them; a
 * private one's boards are sealed with a key the item's page does not hold), by id.
 */
async function sidebarHomes(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, RepoRef>> {
  const homes = new Map<string, RepoRef>([[repo.repoId, repo]])
  for (const doc of await readOwnerRepos(sdk, repo.forge, repo.ownerId, OWNER_REPO_PAGES)) {
    if (doc.ownerId === repo.ownerId && doc.visibility !== 'private' && !homes.has(doc.repoId)) homes.set(doc.repoId, repoRefOf(repo.forge, doc))
  }
  return homes
}

/**
 * The boards issue or PR `itemId` of `repo` has a card on, whose home is `repo` or another
 * public repository of the same owner (§5.6: a stranger's board naming the issue is never read,
 * nor a private repository's, sealed with a key this page does not hold). The owner's
 * repositories are read first ({@link sidebarHomes}), then `card.onItem` with `item ==` and
 * `repoId in` them (100 a read, {@link ITEM_CARD_PAGES} pages each), so cards anyone else writes
 * naming the item cost this read nothing. Deleted boards are left out; closed ones are kept
 * (read-only). Ordered by home repository (`repo` first), then key.
 */
export async function readItemCards(sdk: EvoSDK, repo: RepoRef, itemId: string): Promise<ItemBoard[]> {
  const homes = await sidebarHomes(sdk, repo)
  const ids = [...homes.keys()].sort(compareStrings)
  const docs: PlainDocument[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const query = repoSource(repo).targetQuery(DOC.card, { where: [['item', '==', itemId], ['repoId', 'in', ids.slice(i, i + 100)]], orderBy: [['repoId', 'asc'], ['board', 'asc']] })
    docs.push(...(await readPages(sdk, query, ITEM_CARD_PAGES)))
  }
  const byHome = new Map<string, PlainDocument[]>()
  for (const d of docs) {
    const home = asIdentifierString(d['repoId'])
    if (homes.has(home)) byHome.set(home, [...(byHome.get(home) ?? []), d])
  }
  const out: ItemBoard[] = []
  for (const [homeId, homeDocs] of [...byHome].sort(([a], [b]) => (a === repo.repoId ? -1 : b === repo.repoId ? 1 : compareStrings(a, b)))) {
    const home = homes.get(homeId) as RepoRef
    const byKey = new Map<number, PlainDocument[]>()
    for (const d of homeDocs) {
      const key = u32Of(d, 'board')
      if (key !== null && key > 0) byKey.set(key, [...(byKey.get(key) ?? []), d])
    }
    for (const [key, keyDocs] of [...byKey].sort(([a], [b]) => a - b)) {
      const board = await readBoardDefinition(sdk, home, key)
      if (board === null || board.state === 'deleted') continue
      const onBoard = await cardsOf(home, keyDocs)
      out.push({ home, board, cards: onBoard, card: newestCards(onBoard).get(itemId) ?? null })
    }
  }
  return out
}

/**
 * Where `item` shows on `entry`'s board (§2.4): its column, rank, archive state and field values,
 * folded as the board page folds it; null when the board's definition did not open.
 */
export function itemPlacement(entry: ItemBoard, item: BoardItem, now: number): Placement | null {
  if (entry.board.spec === null) return null
  return foldBoard({ spec: entry.board.spec, home: entry.home.repoId, items: [item], cards: entry.cards, now }).items[0] ?? null
}

// ---------------------------------------------------------------------------------------------
// Write generation
// ---------------------------------------------------------------------------------------------

const generations = new Map<string, number>()
const listeners = new Set<() => void>()

let allWrites = 0

/**
 * Note a board or card write to `repo`: the lists of its boards (`useBoards`) and the item
 * sidebars (`useItemBoards`) re-read. (A board page re-reads its own writes by polling at once.)
 */
export function noteBoardWrite(repo: Pick<RepoRef, 'repoId'>): void {
  generations.set(repo.repoId, (generations.get(repo.repoId) ?? 0) + 1)
  allWrites++
  for (const l of listeners) l()
}

/** How many board or card writes to `repo` (none given: to any repository) this session made. */
export function boardWriteGeneration(repo?: Pick<RepoRef, 'repoId'>): number {
  return repo === undefined ? allWrites : (generations.get(repo.repoId) ?? 0)
}

/** Be told of every {@link noteBoardWrite}; returns the unsubscribe. */
export function subscribeBoardWrites(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
