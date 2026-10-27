/**
 * Board and card writes (`docs/design/boards.md` §3, §5): every one a single document operation
 * on forge-meta, the signer's role checked first (`roleClaim`: a board claims `r` 1, a card 1 or
 * 2; a refusal drops the cached membership, `refreshRoleOnRefusal`), and refused before signing
 * where the contract or the board rules would refuse it ({@link BoardWriteError}): a role that
 * may not, a name or definition the schema refuses, a closed or deleted board (read-only), a
 * column, rank or field value the board does not have, a rank with no room (`re-rank`).
 *
 * Both types are one mutable document per member (§3: a board per (home repo, key, member), a
 * card per (item, home repo, board, member)), so a write replaces the signer's own document when
 * they have one and creates it otherwise. A card carries a member's whole view of the item, and
 * the newest card over every member's wins whole (§2.4), so {@link writeCard} reads the item's
 * newest card immediately before signing and applies only its own change to it (§3.2): two
 * members editing different fields both land unless their writes cross within the read-to-sign
 * latency.
 *
 * A private repository's board (`name`, `spec`) and card (`col`, `rank`, `f`) are sealed into
 * `enc` under the current epoch (`lib/private/board.ts`, private-repos.md §4.6); every save
 * re-seals the whole payload. A card from a private home repository naming another repository's
 * item publishes that the home repository tracks it (§3.3): {@link writeCard} refuses it unless
 * the caller confirmed ({@link crossRepoCardNeedsConfirm}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'

import { decodeIdentifier } from '../auth/base58'
import { sealBoardDoc, type BoardFields, type CardFields } from '../private'
import {
  CARD_ACTIVE,
  CARD_ARCHIVED,
  CARD_REMOVED,
  NAME_MAX,
  SPEC_MAX_BYTES,
  bottomRank,
  fieldById,
  fieldValueOk,
  isExplicitRank,
  iterationAt,
  newestCards,
  parseFieldValues,
  rankBetween,
  rerank,
  serializeFieldValues,
  serializeSpec,
  topRank,
  type BoardItem,
  type BoardSpec,
  type FieldValue,
  type Placement,
  type RankError,
  type SpecError,
} from '../rules/boards'
import { ConsensusRefusal, DUPLICATE_UNIQUE_CODE, contentHash, createDocumentIdempotent, queryDocumentsWithProof, replaceDocumentIdempotent, type ReplaceResult, type WriteAuth, type WriteResult } from '../sdk'
import { BASE_PATH, expandShortPath } from '../short-url'
import { utf8Length } from '../view/issue-query'
import { BOARD_STATE_CODE, noteBoardWrite, ownRevision, readBoardDefinition, readItemCardDocs, type BoardCard, type BoardState, type BoardView } from './boards'
import { DOC, type RepoRef } from './contract'
import { keyedContentKey } from './members-writes'
import { privateWriter, sealedIntent } from './private-writes'
import { refreshRoleOnRefusal, roleClaim } from './role-claim'
import { contractOf, repoSource } from './source'
import { createIssue } from './writes'

/** Why a board write was refused before anything was signed. */
export type BoardRefusal =
  /** The board is closed or deleted: read-only until reopened. */
  | 'closed'
  /** The board's definition did not open or parse: nothing on it can be checked. */
  | 'unreadable'
  /** The name, definition, column, rank or a field value is not one the schema or the board admits. */
  | 'input'
  /** No rank fits between the neighbours: re-rank the column first (§2.6). */
  | 're-rank'
  /** A private home repository's card naming another repository's item, not confirmed (§3.3). */
  | 'cross-repo'
  /** No such board. */
  | 'missing'

/** A board write refused before signing, with the reason shown as is. */
export class BoardWriteError extends Error {
  constructor(
    readonly refusal: BoardRefusal,
    message: string,
    /** For `re-rank`: the column (or grouping value) to re-rank. */
    readonly column?: number,
  ) {
    super(message)
    this.name = 'BoardWriteError'
  }
}

const SPEC_PROBLEM: Readonly<Record<SpecError, string>> = {
  json: 'the board definition is not valid JSON',
  version: 'the board definition is of a version this build does not write',
  size: `a board definition is at most ${SPEC_MAX_BYTES} bytes`,
  desc: 'a board description is at most 1024 characters',
  columns: 'a board has 1 to 20 columns',
  column: 'a column needs a unique name of 1-63 characters and an id of 1-255',
  def: 'the default column is not one of the board’s columns',
  done: 'the Done column is not one of the board’s columns',
  sources: 'a board has at most 5 sources',
  source: 'a source names issues, pull requests or both, with a query of at most 512 characters',
  fields: 'a board has at most 12 fields',
  field: 'a field needs a unique name and an id of 1-255, and may not be named like a query key',
  options: 'a select field has 1-30 options with unique names',
  views: 'a board has at most 8 views',
  view: 'a view’s grouping, swimlanes, sort and columns must name the board’s own fields',
  arch: 'auto-archive is 0 to 3650 days',
}

/** The `board.name` schema: 1-63 characters, at most 252 bytes, no control character, something visible. */
const BOARD_NAME = /^[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/u

/**
 * The name and canonical definition JSON a board write stores, or the refusal: a name the schema
 * refuses, or a definition the board rules refuse (`serializeSpec`, which also keeps it within
 * 4096 bytes).
 */
export function checkBoardInput(input: { readonly name: string; readonly spec: BoardSpec }): { readonly name: string; readonly spec: string } {
  const name = input.name.trim()
  if (name === '' || [...name].length > NAME_MAX || utf8Length(name) > 252 || !BOARD_NAME.test(name)) {
    throw new BoardWriteError('input', 'a board name is 1-63 characters, with no control characters')
  }
  const out = serializeSpec(input.spec)
  if ('error' in out) throw new BoardWriteError('input', SPEC_PROBLEM[out.error])
  return { name, spec: out.json }
}

/**
 * The text a board write of `input` stores, in bytes (its trimmed name and canonical definition):
 * what `priceBoardWrites` prices it by, since a board's definition is priced per byte. A
 * definition that does not serialize counts as the largest one.
 */
export function boardTextBytes(input: { readonly name: string; readonly spec: BoardSpec }): number {
  const out = serializeSpec(input.spec)
  return utf8Length(input.name.trim()) + ('json' in out ? utf8Length(out.json) : SPEC_MAX_BYTES)
}

function refuseUnlessOpen(board: BoardView): void {
  if (board.state !== 'open') throw new BoardWriteError('closed', board.state === 'deleted' ? 'this board was deleted' : 'this board is closed: reopen it to change it')
}

/** A board key (1 … 2³²−1) from `bytes`. */
function keyOf(bytes: Uint8Array): number {
  const k = (((bytes[0] as number) << 24) | ((bytes[1] as number) << 16) | ((bytes[2] as number) << 8) | (bytes[3] as number)) >>> 0
  return k === 0 ? 1 : k
}

/**
 * A new board's key (§2.1): a random u32, drawn from `crypto`; with an `intent`, derived from it
 * and the repository (`sha256`), so a retry of one create names the same board and the write
 * engine replays it rather than making a second.
 */
export function newBoardKey(repo: Pick<RepoRef, 'repoId'>, intent?: string, attempt = 0): number {
  if (intent === undefined) return keyOf(crypto.getRandomValues(new Uint8Array(4)))
  return keyOf(sha256(new TextEncoder().encode(`dash-forge board key\u0000${repo.repoId}\u0000${intent}\u0000${attempt}`)))
}

/** Every board revision (by anyone) that names key `key` of `repo`: none when the key is free. */
async function keyTaken(sdk: EvoSDK, repo: RepoRef, key: number): Promise<readonly { readonly id: string; readonly ownerId: string }[]> {
  const { documents } = await queryDocumentsWithProof(sdk, { ...repoSource(repo).repoQuery(DOC.board, { where: [['key', '==', key]], orderBy: [['key', 'asc'], ['$ownerId', 'asc']] }), limit: 100 })
  return documents.map((d) => ({ id: String(d['$id'] ?? ''), ownerId: String(d['$ownerId'] ?? '') }))
}

/** The fields a board write carries: plaintext, or sealed under the repository's current epoch. */
async function boardPayload(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, key: number, fields: BoardFields, intent?: string): Promise<{ readonly data: Record<string, unknown>; readonly intent?: string; readonly contentKey?: string }> {
  if (repo.visibility !== 'private') return { data: { name: fields.name, spec: fields.spec }, ...(intent ? { intent } : {}) }
  const w = await privateWriter(sdk, auth, repo)
  const enc = await sealBoardDoc(w.keys, decodeIdentifier(auth.identityId), { type: 'board', key }, fields)
  const sealedFor = sealedIntent(intent, w.keys)
  return { data: { epoch: w.keys.epoch, enc }, ...(sealedFor ? { intent: sealedFor } : {}), contentKey: await keyedContentKey(w.keys, contentHash(DOC.board, { repoId: repo.repoId, key, ...fields })) }
}

/** The outcome of a board write. */
export interface BoardWritten {
  readonly key: number
  readonly documentId: string
  /** A new document (the signer's first revision of this board), or a replace of theirs. */
  readonly created: boolean
  readonly result: WriteResult | ReplaceResult
}

/**
 * Write the signer's revision of board `key`: replace their own document when they have one
 * (`own`), else create one. `state` is plaintext; the name and definition sealed in a private
 * repository.
 */
async function writeBoardRevision(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  key: number,
  fields: BoardFields,
  state: BoardState,
  own: { readonly id: string } | null,
  intent?: string,
): Promise<BoardWritten> {
  const contractId = contractOf(repo.forge, DOC.board)
  const base = { repoId: decodeIdentifier(repo.repoId), key, state: BOARD_STATE_CODE[state] }
  const claim = await roleClaim(sdk, auth, repo, DOC.board, base)
  const payload = await boardPayload(sdk, auth, repo, key, fields, intent)
  try {
    if (own !== null) {
      // A replace re-states every content field: a sealed revision drops the plaintext ones and back.
      const changes = repo.visibility === 'private' ? { ...payload.data, name: undefined, spec: undefined, state: base.state, ...claim } : { ...payload.data, enc: undefined, epoch: undefined, state: base.state, ...claim }
      const result = await refreshRoleOnRefusal(repo, auth, DOC.board, () => replaceDocumentIdempotent(sdk, auth, { contractId, documentType: DOC.board, documentId: own.id, changes, repo: repo.repoId, expectRepoId: repo.repoId }))
      return { key, documentId: own.id, created: false, result }
    }
    const result = await refreshRoleOnRefusal(repo, auth, DOC.board, () =>
      createDocumentIdempotent(sdk, auth, {
        contractId,
        documentType: DOC.board,
        data: { ...base, ...payload.data, ...claim },
        ...(payload.intent ? { intent: payload.intent } : {}),
        ...(payload.contentKey ? { contentKey: payload.contentKey } : {}),
      }),
    )
    return { key, documentId: result.documentId, created: true, result }
  } finally {
    noteBoardWrite(repo)
  }
}

/**
 * Create a board in `repo` (§2.1): a new key, unused by any revision (checked before signing;
 * with `intent`, derived from it so a retry names the same board), and the signer's first
 * revision of it. Maintainers and writers only.
 */
export async function createBoard(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: { readonly name: string; readonly spec: BoardSpec; readonly intent?: string }): Promise<BoardWritten> {
  const fields = checkBoardInput(input)
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = newBoardKey(repo, input.intent, attempt)
    const taken = await keyTaken(sdk, repo, key)
    if (taken.length === 0) return writeBoardRevision(sdk, auth, repo, key, fields, 'open', null, input.intent)
    // a retry of this create whose first attempt landed: its own revision holds the key
    const own = taken[0]
    if (input.intent !== undefined && taken.length === 1 && own?.ownerId === auth.identityId) return writeBoardRevision(sdk, auth, repo, key, fields, 'open', own, input.intent)
  }
  // copy-lint-ignore: 2^32 keys and eight draws: never seen in practice
  throw new Error('could not find an unused board key; try again')
}

/** What {@link saveBoard} changes: the name, the definition, or both. */
export interface BoardChange {
  readonly name?: string
  readonly spec?: BoardSpec
}

/**
 * Save a change to board `key` (its name or definition, views included): read its newest
 * revision fresh, apply the change, and replace the signer's own revision (or create one).
 * Refused for a closed or deleted board, or one whose definition did not open.
 */
export async function saveBoard(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, key: number, change: BoardChange, { intent }: { readonly intent?: string } = {}): Promise<BoardWritten> {
  const board = await readBoardDefinition(sdk, repo, key)
  if (board === null) throw new BoardWriteError('missing', 'no such board')
  refuseUnlessOpen(board)
  if (board.spec === null || board.name === null) throw new BoardWriteError('unreadable', "this board's definition can't be read here, so it can't be edited")
  const fields = checkBoardInput({ name: change.name ?? board.name, spec: change.spec ?? board.spec })
  return writeBoardRevision(sdk, auth, repo, key, fields, 'open', ownRevision(board, auth.identityId), intent)
}

/**
 * Open, close (read-only, listed under Closed) or delete board `key` (§3.1 `state`): a new
 * revision with the newest one's name and definition. A writer may close or delete a
 * maintainer's board, as with labels. A deleted board stays deleted.
 */
export async function setBoardState(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, key: number, state: BoardState, { intent }: { readonly intent?: string } = {}): Promise<BoardWritten> {
  const board = await readBoardDefinition(sdk, repo, key)
  if (board === null) throw new BoardWriteError('missing', 'no such board')
  if (board.state === 'deleted') throw new BoardWriteError('closed', 'this board was deleted')
  if (board.spec === null || board.name === null) throw new BoardWriteError('unreadable', "this board's definition can't be read here, so it can't be changed")
  const fields = checkBoardInput({ name: board.name, spec: board.spec })
  return writeBoardRevision(sdk, auth, repo, key, fields, state, ownRevision(board, auth.identityId), intent)
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

/** The item a card names: its id, and its repository (for the cross-repository confirm, §3.3). */
export interface CardItem {
  readonly id: string
  readonly repoId: string
}

/** What a card write changes; everything else is carried over from the item's newest card. */
export interface CardPatch {
  /** The column id; 0 for "No status". */
  readonly col?: number
  /** An explicit rank (§2.6). */
  readonly rank?: string
  /** Field values by field id: a value sets it, null clears it. */
  readonly fields?: Readonly<Record<number, FieldValue | null>>
  /** 0 active, 1 archived, 2 removed (`CARD_*`). */
  readonly state?: number
}

/** A card write's options. */
export interface CardWriteOptions {
  readonly intent?: string
  /** The signer confirmed a private home repository's card for another repository's item (§3.3). */
  readonly confirmCrossRepo?: boolean
  /**
   * The card this client's previous write of the item just made (its write queue, `useBoard`):
   * the patch applies over it rather than over the fresh read, which may not show that write yet
   * (§3.2: a member's own back-to-back edits must not undo each other).
   */
  readonly over?: BoardCard
}

/** The outcome of a card write. */
export interface CardWritten {
  /**
   * The card as written, for an optimistic view: its `updatedAt` is this client's clock, not the
   * block time, so never merge it into read cards (`mergeCards`); the next poll reads the real one.
   */
  readonly card: BoardCard
  readonly created: boolean
  readonly result: WriteResult | ReplaceResult
}

/**
 * Whether a card for `item` on a board of `home` must be confirmed first (§3.3): `item` is
 * plaintext and indexed, so a private repository's card naming another repository's item tells
 * everyone that the private repository tracks it.
 */
export function crossRepoCardNeedsConfirm(home: Pick<RepoRef, 'repoId' | 'visibility'>, itemRepoId: string): boolean {
  return home.visibility === 'private' && itemRepoId !== home.repoId
}

/** Refuse an unconfirmed card from a private `home` for another repository's item (§3.3). */
function refuseUnlessConfirmed(home: Pick<RepoRef, 'repoId' | 'visibility'>, itemRepoId: string, confirmed: boolean | undefined): void {
  if (crossRepoCardNeedsConfirm(home, itemRepoId) && confirmed !== true) {
    throw new BoardWriteError('cross-repo', 'This board is in a private repository. Placing an item of another repository on it shows everyone that this repository tracks that item.')
  }
}

/** Refuse a patch the board or the schema would refuse. */
function checkPatch(spec: BoardSpec, patch: CardPatch): void {
  if (patch.col !== undefined && patch.col !== 0 && !spec.columns.some((c) => c.id === patch.col)) throw new BoardWriteError('input', 'that column is not on this board')
  if (patch.rank !== undefined && !isExplicitRank(patch.rank)) throw new BoardWriteError('input', 'a rank is 1-63 rank digits, not ending in 0')
  if (patch.state !== undefined && ![CARD_ACTIVE, CARD_ARCHIVED, CARD_REMOVED].includes(patch.state)) throw new BoardWriteError('input', 'a card is active, archived or removed')
  for (const [id, v] of Object.entries(patch.fields ?? {})) {
    const field = fieldById(spec, Number(id))
    if (field === undefined) throw new BoardWriteError('input', 'that field is not on this board')
    if (v !== null && !fieldValueOk(field, v)) throw new BoardWriteError('input', `that is not a valid value for ${field.name}`)
  }
}

/**
 * The card `patch` makes over `base` (the item's newest card, any member's, or none): its column,
 * rank and state replaced where given, its field values merged (a null clears one).
 */
export function patchedCard(spec: BoardSpec, base: BoardCard | null, patch: CardPatch): { readonly col: number | null; readonly rank: string | null; readonly f: string | null; readonly state: number } {
  const values: Record<string, FieldValue> = { ...parseFieldValues(base?.f ?? null, spec) }
  for (const [id, v] of Object.entries(patch.fields ?? {})) {
    if (v === null) delete values[id]
    else values[id] = v
  }
  const f = serializeFieldValues(values, spec)
  if ('error' in f) throw new BoardWriteError('input', 'these field values are over 2048 bytes')
  const rank = patch.rank ?? (base !== null && isExplicitRank(base.rank) ? base.rank : null)
  return { col: patch.col ?? base?.col ?? null, rank, f: f.json === '{}' ? null : f.json, state: patch.state ?? base?.state ?? CARD_ACTIVE }
}

/**
 * Write the signer's card for `item` on `board` of `repo` (§3.2): refused for a closed board, a
 * patch the board does not admit, or (unconfirmed) a private home's cross-repository item; then
 * the item's cards are read fresh, `patch` is applied to the newest, and the signer's own card is
 * replaced (or created: a create that meets the signer's card made meanwhile, in another tab,
 * replaces it instead).
 */
export async function writeCard(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, item: CardItem, patch: CardPatch, opts: CardWriteOptions = {}): Promise<CardWritten> {
  // What the page's copy of the board refuses is refused at once; the fresh read below decides.
  refuseUnlessOpen(board)
  refuseUnlessConfirmed(repo, item.repoId, opts.confirmCrossRepo)
  const ids = { repoId: decodeIdentifier(repo.repoId), board: board.key, item: decodeIdentifier(item.id) }
  // The role and (private) the write epoch first: the item's cards are read as late as possible.
  const claim = await roleClaim(sdk, auth, repo, DOC.card, ids)
  const writer = repo.visibility === 'private' ? await privateWriter(sdk, auth, repo) : null
  // The definition read with the cards: a field, option or column another member added since the
  // page read it is kept (the values a stale definition does not know would be dropped), and a
  // board closed meanwhile is read-only.
  const [fresh, { cards, own: ownId }] = await Promise.all([readBoardDefinition(sdk, repo, board.key), readItemCardDocs(sdk, repo, board.key, item.id, auth.identityId)])
  if (fresh === null) throw new BoardWriteError('missing', 'no such board')
  refuseUnlessOpen(fresh)
  const spec = fresh.spec
  if (spec === null) throw new BoardWriteError('unreadable', "this board's definition can't be read here, so its cards can't be changed")
  checkPatch(spec, patch)
  // A newest card this reader cannot open holds values it cannot carry over: the newest it can open is the base.
  const next = patchedCard(spec, opts.over ?? newestCards(cards.filter((c) => c.unreadable !== true)).get(item.id) ?? null, patch)
  const contractId = contractOf(repo.forge, DOC.card)
  const base = { ...ids, state: next.state }
  const fields: CardFields = { ...(next.col !== null ? { col: next.col } : {}), ...(next.rank !== null ? { rank: next.rank } : {}), ...(next.f !== null ? { f: next.f } : {}) }
  let content: Record<string, unknown> = { ...fields }
  let intent = opts.intent
  let contentKey: string | undefined
  if (writer !== null) {
    content = { epoch: writer.keys.epoch, enc: await sealBoardDoc(writer.keys, decodeIdentifier(auth.identityId), { type: 'card', board: board.key, item: ids.item }, fields) }
    intent = sealedIntent(intent, writer.keys)
    contentKey = await keyedContentKey(writer.keys,contentHash(DOC.card, { repoId: repo.repoId, board: board.key, item: item.id, state: next.state, ...fields }))
  }
  const replace = (documentId: string): Promise<ReplaceResult> => {
    // every content field re-stated: an absent one is removed (a cleared rank or field values)
    const plain = repo.visibility === 'private' ? { col: undefined, rank: undefined, f: undefined } : { col: next.col ?? undefined, rank: next.rank ?? undefined, f: next.f ?? undefined, enc: undefined, epoch: undefined }
    return refreshRoleOnRefusal(repo, auth, DOC.card, () => replaceDocumentIdempotent(sdk, auth, { contractId, documentType: DOC.card, documentId, changes: { ...plain, ...content, state: next.state, ...claim }, repo: repo.repoId, expectRepoId: repo.repoId }))
  }
  const written = (documentId: string, created: boolean, result: WriteResult | ReplaceResult): CardWritten => ({
    card: { id: documentId, ownerId: auth.identityId, updatedAt: Date.now(), item: item.id, col: next.col, rank: next.rank, f: next.f, state: next.state },
    created,
    result,
  })
  try {
    if (ownId !== null) return written(ownId, false, await replace(ownId))
    try {
      const result = await refreshRoleOnRefusal(repo, auth, DOC.card, () =>
        createDocumentIdempotent(sdk, auth, { contractId, documentType: DOC.card, data: { ...base, ...content, ...claim }, ...(intent ? { intent } : {}), ...(contentKey ? { contentKey } : {}) }),
      )
      return written(result.documentId, true, result)
    } catch (e) {
      if (!(e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE)) throw e
      // the signer's card for this item appeared since the read (another tab): replace it
      const mine = (await readItemCardDocs(sdk, repo, board.key, item.id, auth.identityId)).own
      if (mine === null) throw e
      return written(mine, false, await replace(mine))
    }
  } finally {
    noteBoardWrite(repo)
  }
}

// ---------------------------------------------------------------------------------------------
// Moving and ranking (§2.6, §5.2)
// ---------------------------------------------------------------------------------------------

/** A card in a column's shown order, as a move reads it: its item and its effective rank (the fold's). */
export interface RankedCard {
  readonly id: string
  readonly rank: string
}

const RANK_PROBLEM: Readonly<Record<RankError, string>> = {
  invalid: 'the neighbouring ranks are not ranks',
  order: 'the neighbours are out of order: reload the board',
  're-rank': 'There is no room left between these cards. Re-rank this column first.',
}

/**
 * The rank that drops a card at position `index` (0 = the top) of `column`, the column's cards in
 * rank order without the one moving (§2.6): the top is `topRank` (above the sourced pool), the
 * bottom `bottomRank` (below it), elsewhere `rankBetween` the two neighbours.
 */
export function rankForDrop(column: readonly RankedCard[], index: number): { readonly rank: string } | { readonly error: RankError } {
  const at = Math.max(0, Math.min(Math.floor(index), column.length))
  if (column.length === 0) return topRank(null)
  if (at === 0) return topRank(column[0]?.rank ?? null)
  if (at === column.length) return bottomRank(column[column.length - 1]?.rank ?? null)
  return rankBetween(column[at - 1]?.rank ?? null, column[at]?.rank ?? null)
}

/** Where a move puts the card: a column, or (a view grouped by a field, §4.1) a field's value. */
export type MoveTarget = { readonly col: number } | { readonly field: number; readonly value: FieldValue | null }

/**
 * The rank that drops `item` just before item `before` of `column` (the target column's cards in
 * rank order; the moving card itself may be among them and is left out), or at its bottom when
 * `before` is null (or not in it): what a drop "above card X" asks for, whatever the card's
 * place before the move.
 */
export function rankBefore(column: readonly RankedCard[], item: string, before: string | null): { readonly rank: string } | { readonly error: RankError } {
  const others = column.filter((c) => c.id !== item)
  const at = before === null ? -1 : others.findIndex((c) => c.id === before)
  return rankForDrop(others, at < 0 ? others.length : at)
}

/**
 * Move `item` to `target`, just before item `before` of `column` (the target column's cards in
 * rank order; null: at the bottom; see {@link rankBefore}): one card write with the new column
 * (or field value) and rank. Refused before signing with `re-rank` when no rank fits
 * ({@link rerankColumn}).
 */
export async function moveCard(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  board: BoardView,
  item: CardItem,
  target: MoveTarget,
  column: readonly RankedCard[],
  before: string | null,
  opts: CardWriteOptions = {},
): Promise<CardWritten> {
  const r = rankBefore(column, item.id, before)
  if ('error' in r) throw new BoardWriteError(r.error === 're-rank' ? 're-rank' : 'input', RANK_PROBLEM[r.error], 'col' in target ? target.col : undefined)
  const patch: CardPatch = 'col' in target ? { col: target.col, rank: r.rank } : { fields: { [target.field]: target.value }, rank: r.rank }
  return writeCard(sdk, auth, repo, board, item, patch, opts)
}

/** The outcome of a write to several cards: each item's, in order; the first failure stops the rest. */
export interface BulkWritten {
  readonly written: readonly CardWritten[]
  /** The item whose write failed, and why; null when every write landed. */
  readonly failed: { readonly item: string; readonly error: unknown } | null
  /** Items not written because an earlier write failed. */
  readonly skipped: readonly string[]
}

/** Write `patchOf(item)` to each of `items` in turn, stopping at the first failure. */
async function writeEach(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], patchOf: (item: CardItem, i: number) => CardPatch, opts: CardWriteOptions): Promise<BulkWritten> {
  const written: CardWritten[] = []
  for (const [i, item] of items.entries()) {
    try {
      written.push(await writeCard(sdk, auth, repo, board, item, patchOf(item, i), { ...opts, ...(opts.intent ? { intent: `${opts.intent}:${item.id}` } : {}) }))
    } catch (error) {
      return { written, failed: { item: item.id, error }, skipped: items.slice(i + 1).map((x) => x.id) }
    }
  }
  return { written, failed: null, skipped: [] }
}

/** How many of the writes to `items` create a card (the signer has none for it) and how many replace one: what is priced first. */
export function planCardWrites(cards: readonly BoardCard[], me: string, items: readonly string[]): { readonly creates: number; readonly replaces: number } {
  const mine = new Set(cards.filter((c) => c.ownerId === me).map((c) => c.item))
  const creates = items.filter((id) => !mine.has(id)).length
  return { creates, replaces: items.length - creates }
}

/**
 * Re-rank a column (§2.6): `items`, the column's cards in their shown order, get evenly spaced
 * ranks between `0` and `V` (`rerank`), one write each (a create for each item the signer has no
 * card for, priced first with {@link planCardWrites}).
 */
export async function rerankColumn(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], opts: CardWriteOptions = {}): Promise<BulkWritten> {
  const r = rerank(items.length)
  if ('error' in r) throw new BoardWriteError('input', 'too many cards to re-rank at once')
  return writeEach(sdk, auth, repo, board, items, (_item, i) => ({ rank: r.ranks[i] as string }), opts)
}

/** Put `items` on the board (§5.3): an active card each, in column `col` when given. */
export function addItems(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], col?: number, opts: CardWriteOptions = {}): Promise<BulkWritten> {
  return writeEach(sdk, auth, repo, board, items, () => ({ state: CARD_ACTIVE, ...(col !== undefined ? { col } : {}) }), opts)
}

/** Archive `items` (hidden unless a view asks for `is:archived`, §2.4). */
export function archiveItems(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], opts: CardWriteOptions = {}): Promise<BulkWritten> {
  return writeEach(sdk, auth, repo, board, items, () => ({ state: CARD_ARCHIVED }), opts)
}

/** Restore archived `items` (an active card each). */
export function unarchiveItems(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], opts: CardWriteOptions = {}): Promise<BulkWritten> {
  return writeEach(sdk, auth, repo, board, items, () => ({ state: CARD_ACTIVE }), opts)
}

/** Remove `items` from the board, even where a source includes them (§2.4). */
export function removeItems(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, board: BoardView, items: readonly CardItem[], opts: CardWriteOptions = {}): Promise<BulkWritten> {
  return writeEach(sdk, auth, repo, board, items, () => ({ state: CARD_REMOVED }), opts)
}

/**
 * The items "move open items to the next iteration" moves (§5.4): every open item on the board
 * (not archived) whose iteration field `fieldId` is the current iteration at `now`, outside the
 * Done column; and that next iteration's index. Nothing when there is no current iteration.
 */
export function nextIterationPlan(spec: BoardSpec, fieldId: number, items: readonly BoardItem[], placements: readonly Placement[], now: number): { readonly next: number; readonly items: readonly CardItem[] } | null {
  const field = fieldById(spec, fieldId)
  if (field === undefined || field.type !== 'iter') return null
  const current = iterationAt(field, now)
  if (current === null || current + 1 > 65535) return null
  const byId = new Map(items.map((i) => [i.id, i]))
  const moving: CardItem[] = []
  for (const p of placements) {
    const item = byId.get(p.id)
    if (item === undefined || item.state !== 'open' || !p.on || p.archived !== null) continue
    if (spec.done !== 0 && p.col === spec.done) continue
    if (p.fields[String(fieldId)] !== current) continue
    moving.push({ id: item.id, repoId: item.repoId })
  }
  return { next: current + 1, items: moving }
}

/** Carry the current iteration's unfinished items into the next (§5.4): {@link nextIterationPlan}, one write each. */
export async function moveOpenToNextIteration(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  board: BoardView,
  fieldId: number,
  items: readonly BoardItem[],
  placements: readonly Placement[],
  now: number,
  opts: CardWriteOptions = {},
): Promise<BulkWritten> {
  if (board.spec === null) throw new BoardWriteError('unreadable', "this board's definition can't be read here")
  const plan = nextIterationPlan(board.spec, fieldId, items, placements, now)
  if (plan === null) throw new BoardWriteError('input', 'there is no current iteration to move items from')
  return writeEach(sdk, auth, repo, board, plan.items, () => ({ fields: { [fieldId]: plan.next } }), opts)
}

/** The outcome of {@link quickAddIssue}: the new issue, as the board reads it, and its card (null when only the issue landed). */
export interface QuickAdded {
  readonly item: BoardItem
  readonly card: CardWritten | null
  /** Why the card was not written after the issue was (the issue exists; place it again). */
  readonly cardError: unknown
}

/**
 * Quick add (§5.3): a title makes a real issue in `target` (the home repository, or a source
 * repository from the menu) with the issue create everyone uses, then places it in column `col`
 * at the bottom of `column` (the column's cards in rank order). Two writes; a card that fails
 * after the issue landed is reported, not thrown, so the issue is not made twice.
 */
export async function quickAddIssue(
  sdk: EvoSDK,
  auth: WriteAuth,
  home: RepoRef,
  board: BoardView,
  input: { readonly title: string; readonly col: number; readonly column?: readonly RankedCard[]; readonly target?: RepoRef; readonly intent?: string; readonly confirmCrossRepo?: boolean },
): Promise<QuickAdded> {
  refuseUnlessOpen(board)
  if (board.spec === null) throw new BoardWriteError('unreadable', "this board's definition can't be read here")
  checkPatch(board.spec, { col: input.col })
  const target = input.target ?? home
  refuseUnlessConfirmed(home, target.repoId, input.confirmCrossRepo)
  const title = input.title.trim()
  if (title === '') throw new BoardWriteError('input', 'an issue needs a title')
  const issue = await createIssue(sdk, auth, target, { title, body: '', ...(input.intent ? { intent: input.intent } : {}) })
  const item: BoardItem = { id: issue.documentId, number: issue.number, repoId: target.repoId, repo: target.name, kind: 'issue', state: 'open', createdAt: Date.now(), closedAt: null, title, labels: [], assignees: [], milestone: null, author: auth.identityId }
  const column = input.column ?? []
  const rank = column.length === 0 ? null : rankBefore(column, '', null)
  try {
    const card = await writeCard(sdk, auth, home, board, item, { col: input.col, ...(rank !== null && 'rank' in rank ? { rank: rank.rank } : {}) }, { ...(input.intent ? { intent: `${input.intent}:card` } : {}), confirmCrossRepo: true })
    return { item, card, cardError: null }
  } catch (cardError) {
    return { item, card: null, cardError }
  }
}

/**
 * An existing item a quick add names (§5.3): `#12`, `owner/name#12`, or an issue, PR or number
 * link of this app, as a route (`/repo/issue/?owner=…&name=…&number=12`, `target-href.ts`) or as
 * the short URL the address bar shows (`/owner/name/issues/12`, `/owner/name/pull/7/files`,
 * `lib/short-url.ts`), under the build's base path if it has one; null for a title. The owner and
 * name are as written (an owner's DPNS name or identity id), resolved by the caller.
 */
export function parseItemReference(text: string): { readonly owner?: string; readonly name?: string; readonly number: number } | null {
  const t = text.trim()
  let m = /^#(\d{1,10})$/.exec(t)
  if (m) return { number: Number(m[1]) }
  m = /^([^\s/#]+)\/([^\s/#]+)#(\d{1,10})$/.exec(t)
  if (m) return { owner: m[1] as string, name: m[2] as string, number: Number(m[3]) }
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return null
  }
  // GitHub's own issue URLs have the short URL's shape: not this app's.
  if (/^(www\.)?github\.com$/i.test(url.hostname)) return null
  const route = new URL(expandShortPath(url.pathname, BASE_PATH) ?? `${url.pathname}${url.search}`, url)
  const path = BASE_PATH !== '' && route.pathname.startsWith(`${BASE_PATH}/`) ? route.pathname.slice(BASE_PATH.length) : route.pathname
  if (!/^\/repo\/(issue|pull|number)\/?$/.test(path)) return null
  const owner = route.searchParams.get('owner')
  const name = route.searchParams.get('name')
  const n = route.searchParams.get('number')
  if (owner === null || name === null || n === null || !/^\d{1,10}$/.test(n)) return null
  return { owner, name, number: Number(n) }
}

/** Issue or PR number `number` of `repo` (the `number` index of each), or null. */
export async function resolveItemByNumber(sdk: EvoSDK, repo: RepoRef, number: number): Promise<{ readonly id: string; readonly kind: 'issue' | 'pr' } | null> {
  for (const [type, kind] of [[DOC.issue, 'issue'], [DOC.patch, 'pr']] as const) {
    const { documents } = await queryDocumentsWithProof(sdk, { ...repoSource(repo).repoQuery(type, { where: [['number', '==', number]], orderBy: [['number', 'asc']] }), limit: 1 })
    const id = documents[0]?.['$id']
    if (typeof id === 'string') return { id, kind }
  }
  return null
}
