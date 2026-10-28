'use client'

/**
 * Boards in React (`docs/design/boards.md`), on the data layer of `lib/repo/boards.ts`,
 * `board-items.ts` and `board-writes.ts`:
 *
 * - {@link useBoards}: a repository's boards (open and closed), re-read after any board write
 *   this session made, with the viewer's {@link BoardCan} and `create`.
 * - {@link useBoard}: one board: its definition, every card, its items and the fold (§2.4) at
 *   `now`. While the tab is visible it polls the cards changed since its last read every
 *   {@link BOARD_POLL_MS} (§5.7; `>=` and deduplicated by `$id`), reads the items new cards name,
 *   and re-reads the definition when the tab is shown or focused; `refresh` re-reads everything.
 *   Its writes apply at once (an optimistic card over the fold, §5.2), and are taken back with the
 *   reason ({@link BoardHookState.refusal}) when the write is refused; a landed write is re-read
 *   by the next poll, run at once.
 * - {@link useItemBoards}: the boards an issue or PR is on, for its sidebar (§5.6), with its
 *   placement on each and the writes that change it there.
 *
 * Every write needs a signed-in viewer (`signer`) and the role the contract admits:
 * {@link BoardCan.place} (maintainers, writers, triage) for cards, {@link BoardCan.edit}
 * (maintainers, writers) for boards; a closed board is read-only. The UI offers only what these
 * allow; the writes refuse the rest before signing (`BoardWriteError`, `RoleRefusedError`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync, type AsyncState } from '@/hooks/use-async'
import { useViewerRole } from '@/hooks/use-repo-chrome'
import { useSdk } from '@/hooks/use-sdk'
import {
  addCardItems,
  addItems,
  archiveItems,
  assembleBoard,
  boardItemReader,
  boardWriteGeneration,
  boardsDeployed,
  knownBoardsDeployed,
  subscribeBoardsDeployed,
  canEditBoards,
  canPlaceCards,
  cardsSince,
  createBoard,
  itemPlacement,
  loadBoardItems,
  loadOlderClosed,
  mergeCards,
  moveCard,
  moveOpenToNextIteration,
  nextIterationPlan,
  patchedCard,
  quickAddIssue,
  rankBefore,
  readBoard,
  readBoardDefinition,
  readBoards,
  readCardsSince,
  readItemCards,
  removeItems,
  repoContractIds,
  repoKey,
  rerankColumn,
  saveBoard,
  setBoardState,
  subscribeBoardWrites,
  unarchiveItems,
  withItem,
  writeCard,
  type BoardCard,
  type BoardChange,
  type BoardItemSet,
  type BoardItemsInput,
  type BoardState,
  type BoardView,
  type BoardWritten,
  type BulkWritten,
  type CardItem,
  type CardPatch,
  type CardWriteOptions,
  type CardWritten,
  type ItemBoard,
  type MoveTarget,
  type QuickAdded,
  type RankedCard,
  type RepoRef,
} from '@/lib/repo'
import { newestCards, type BoardFold, type BoardItem, type BoardSpec, type Placement } from '@/lib/rules/boards'
import type { Role } from '@/lib/rules/v2'
import type { WriteAuth } from '@/lib/sdk'
import { errorMessage } from '@/lib/utils'

/** How often a visible board reads the cards changed since its last read (§5.7). */
export const BOARD_POLL_MS = 20_000
/** Showing or focusing the tab re-reads, but not sooner than this after the last read. */
export const BOARD_FOCUS_THROTTLE_MS = 5_000

/** What the viewer may do here (§5.1). */
export interface BoardCan {
  /** Move, rank, set fields, add, archive, remove items (maintainers, writers, triage; signed in; the board open). */
  readonly place: boolean
  /** Create, edit, close, delete boards and save views (maintainers, writers; signed in). */
  readonly edit: boolean
}

function canOf(role: Role | null, signedIn: boolean, board: BoardView | null): BoardCan {
  const open = board === null || board.state === 'open'
  return { place: signedIn && open && canPlaceCards(role), edit: signedIn && canEditBoards(role) }
}

/**
 * `a` with the items, hidden and missing ids of `b` it lacks (its walks and flags kept): two reads
 * of one board's items that may have crossed.
 */
function unionItems(a: BoardItemSet | null, b: BoardItemSet | null): BoardItemSet | null {
  if (a === null || b === null) return a ?? b
  const have = new Set(a.items.map((i) => i.id))
  return {
    ...a,
    items: [...a.items, ...b.items.filter((i) => !have.has(i.id))],
    hidden: new Set([...a.hidden, ...b.hidden]),
    missing: new Set([...a.missing, ...b.missing]),
  }
}

/** Re-render on every board write this session made to `repo` (none given: to any repository). */
function useBoardWriteGeneration(repo?: RepoRef): number {
  return useSyncExternalStore(subscribeBoardWrites, () => boardWriteGeneration(repo), () => 0)
}

/** The signer and SDK a write needs, or the refusal a signed-out (or not yet connected) viewer gets. */
function needWriter(sdk: ReturnType<typeof useSdk>['sdk'], signer: WriteAuth | null): { sdk: NonNullable<typeof sdk>; signer: WriteAuth } {
  // copy-lint-ignore: the action's own button is hidden for a signed-out viewer; this is the guard
  if (sdk === null || signer === null) throw new Error('Sign in to change this board.')
  return { sdk, signer }
}

/**
 * Whether the network `forge` names has boards (`boardsDeployed`: its forge-meta declares `board`
 * and `card`): null until known (the contract is read once a session, usually from the SDK's
 * cache), false on a three-contract set or before the update.
 */
export function useBoardsDeployed(forge: { readonly meta?: string | undefined } | null | undefined): boolean | null {
  const meta = forge?.meta
  const { sdk, ready } = useSdk()
  const known = useKnownBoardsDeployed(meta)
  const state = useAsync(() => boardsDeployed(sdk!, meta), [ready, meta ?? ''], { enabled: ready && sdk !== null && known === undefined })
  return known ?? state.data ?? null
}

/** The answer {@link useBoardsDeployed} read this session, without reading anything (a shell drawn before the SDK loads). */
export function useKnownBoardsDeployed(meta: string | undefined): boolean | undefined {
  return useSyncExternalStore(subscribeBoardsDeployed, () => knownBoardsDeployed(meta), () => undefined)
}

/** A repository's boards (open and closed; deleted left out), and what the viewer may do. */
export function useBoards(repo: RepoRef): AsyncState<BoardView[]> & {
  readonly role: Role | null
  readonly can: BoardCan
  /** Create a board (§2.1); its key is in the result. */
  readonly create: (input: { readonly name: string; readonly spec: BoardSpec; readonly intent?: string }) => Promise<BoardWritten>
} {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const { role } = useViewerRole(repo)
  const generation = useBoardWriteGeneration(repo)
  const state = useAsync(() => readBoards(sdk!, repo), [ready, repoKey(repo), network, generation], { enabled: ready && sdk !== null })
  const create = useCallback(
    (input: { readonly name: string; readonly spec: BoardSpec; readonly intent?: string }) => {
      const w = needWriter(sdk, signer)
      return createBoard(w.sdk, w.signer, repo, input)
    },
    [sdk, signer, repo],
  )
  return { ...state, role, can: canOf(role, signer !== null, null), create }
}

/** A refused write, taken back (§5.2: the card goes back with the reason). */
export interface BoardRefusalNote {
  /** The items it was for. */
  readonly items: readonly string[]
  readonly message: string
  readonly error: unknown
}

/**
 * What {@link useBoard} returns. Its functions are made afresh each render (like `useAsync`'s
 * data): call them from handlers, never list them in an effect's dependencies.
 */
export interface BoardHookState {
  /** The board's definition (null until read, or when it has none: {@link notFound}). */
  readonly board: BoardView | null
  /** Every card, every member's, with the pending writes' optimistic cards over them. */
  readonly cards: readonly BoardCard[]
  readonly items: BoardItemSet | null
  /** Where every item shows (§2.4), folded at {@link now}; null until read or when the definition did not open. */
  readonly fold: BoardFold | null
  /** The fold's clock (moved on by every poll). */
  readonly now: number
  readonly loading: boolean
  readonly error: string | null
  /** The board has no revision (a wrong key, or not visible yet). */
  readonly notFound: boolean
  readonly role: Role | null
  readonly can: BoardCan
  /** Items with a write in flight (shown with their optimistic placement). */
  readonly pending: ReadonlySet<string>
  /** The last refused write, taken back; cleared by the next write or {@link dismissRefusal}. */
  readonly refusal: BoardRefusalNote | null
  dismissRefusal(): void
  /** Re-read the definition, every card and the items. */
  refresh(): void
  /** Read the older closed items too (`is:archived`, "Show older"), when {@link BoardItemSet.hasOlderClosed}. */
  loadOlderClosed(): Promise<void>
  /** One card write (a column, a rank, field values, a state), over a fresh read of the item's newest card (§3.2). */
  write(item: CardItem, patch: CardPatch, opts?: CardWriteOptions): Promise<CardWritten>
  /**
   * Drop `item` in `target` just before item `before` of `column` (the target column's cards in
   * rank order, the moving card may be among them; null: at the bottom) (§5.2); refused with
   * `re-rank` when no rank fits.
   */
  move(item: CardItem, target: MoveTarget, column: readonly RankedCard[], before: string | null, opts?: CardWriteOptions): Promise<CardWritten>
  add(items: readonly CardItem[], col?: number, opts?: CardWriteOptions): Promise<BulkWritten>
  archive(items: readonly CardItem[], opts?: CardWriteOptions): Promise<BulkWritten>
  unarchive(items: readonly CardItem[], opts?: CardWriteOptions): Promise<BulkWritten>
  remove(items: readonly CardItem[], opts?: CardWriteOptions): Promise<BulkWritten>
  /** Re-rank a column (its cards in shown order): price it first with `planCardWrites` and `priceBoardWrites`. */
  rerank(items: readonly CardItem[], opts?: CardWriteOptions): Promise<BulkWritten>
  /** Carry the current iteration's unfinished items of iteration field `fieldId` into the next (§5.4). */
  moveOpenToNextIteration(fieldId: number, opts?: CardWriteOptions): Promise<BulkWritten>
  /** Quick add (§5.3): a new issue in the home repository (or `target`), placed in `col` with `fields` set, in one card. */
  quickAdd(input: {
    readonly title: string
    readonly col: number
    readonly column?: readonly RankedCard[]
    readonly fields?: CardPatch['fields']
    readonly target?: RepoRef
    readonly intent?: string
    readonly confirmCrossRepo?: boolean
  }): Promise<QuickAdded>
  /** Save the board's name or definition (views included). */
  save(change: BoardChange, opts?: { readonly intent?: string }): Promise<BoardWritten>
  /** Open, close or delete the board. */
  setState(state: BoardState, opts?: { readonly intent?: string }): Promise<BoardWritten>
}

interface Held {
  readonly key: string
  readonly board: BoardView | null
  readonly cards: readonly BoardCard[]
  readonly items: BoardItemSet | null
  readonly since: number
  readonly notFound: boolean
}

/** An optimistic card's `$updatedAt`: newer than any read, so the fold takes it as the item's newest. */
const PENDING_AT = Number.MAX_SAFE_INTEGER
/** A landed write's optimistic card is shown until a poll reads the card, or this long at most. */
const LANDED_HOLD_MS = 60_000

/** An item's optimistic card: while its write is in flight, then until a poll reads what landed. */
interface Pending {
  readonly card: BoardCard
  /** Which write set it (a later write on the item replaces it; an earlier one's end leaves it alone). */
  readonly token: number
  /** The landed card document, and when it landed; null while the write is in flight. */
  readonly landed: { readonly id: string; readonly at: number } | null
}

let tokens = 0

/** The cards a write's outcome (one card's, or several's) landed. */
function writtenCards(out: unknown): BoardCard[] {
  const cards: BoardCard[] = []
  const one = (w: unknown): void => {
    const card = (w as Partial<CardWritten> | null)?.card
    if (card != null && typeof card.item === 'string' && typeof card.id === 'string') cards.push(card)
  }
  one(out)
  for (const w of (out as Partial<BulkWritten> | null)?.written ?? []) one(w)
  return cards
}

/** The card document each item's write landed in, from a write's outcome. */
function landedOf(out: unknown): Map<string, string> {
  return new Map(writtenCards(out).map((c) => [c.item, c.id]))
}

/** Whether `held` already shows what `p` landed (the same document with the same content). */
function caughtUp(p: Pending, held: readonly BoardCard[]): boolean {
  if (p.landed === null) return false
  if (Date.now() - p.landed.at > LANDED_HOLD_MS) return true
  const id = p.landed.id
  return held.some((c) => c.id === id && c.col === p.card.col && c.rank === p.card.rank && c.f === p.card.f && c.state === p.card.state)
}

/** {@link useCardQueue}'s queue. */
interface CardQueue {
  /**
   * Run `start` once the writes in flight on `keys` end, with each key's last landed card
   * (`overs`); then remember the cards it landed, under `keyOf(card)` (default the card's item).
   */
  run<T>(keys: readonly string[], start: (overs: ReadonlyMap<string, BoardCard>) => Promise<T>, keyOf?: (card: BoardCard) => string): Promise<T>
  /** Remember a card a write outside the queue landed (a quick add's). */
  land(key: string, card: BoardCard): void
}

/**
 * Each item's card writes in turn, and the card each one landed (§3.2). A card write reads the
 * item's newest card and replaces the signer's whole card, so a write built on a read that does
 * not show this client's previous write of the item would undo it: an edit started while the
 * previous one is in flight, or just after it landed (a read that lags, as {@link LANDED_HOLD_MS}
 * allows for). Here a write waits for the writes in flight on its items, then gets each item's
 * last landed card (`overs`, for {@link LANDED_HOLD_MS}), which `writeCard` applies its patch over
 * while the fresh read does not show it yet (`overIfAhead`); a bulk write gets them too. A failed
 * write leaves the last landed card as it was.
 */
function useCardQueue(): CardQueue {
  const chains = useRef(new Map<string, Promise<void>>())
  const landed = useRef(new Map<string, { readonly card: BoardCard; readonly at: number }>())
  return useMemo<CardQueue>(
    () => ({
      run<T>(keys: readonly string[], start: (overs: ReadonlyMap<string, BoardCard>) => Promise<T>, keyOf: (card: BoardCard) => string = (c) => c.item): Promise<T> {
        const before = keys.flatMap((k) => chains.current.get(k) ?? [])
        const out = (async () => {
          await Promise.all(before)
          const now = Date.now()
          // a landed card older than the hold is no help (a read shows it by then): drop them all
          for (const [k, l] of landed.current) if (now - l.at > LANDED_HOLD_MS) landed.current.delete(k)
          const overs = new Map<string, BoardCard>()
          for (const k of keys) {
            const l = landed.current.get(k)
            if (l !== undefined) overs.set(k, l.card)
          }
          return start(overs)
        })()
        const done = out.then(
          (o) => {
            for (const c of writtenCards(o)) landed.current.set(keyOf(c), { card: c, at: Date.now() })
          },
          () => undefined,
        )
        for (const k of keys) {
          chains.current.set(k, done)
          void done.then(() => {
            if (chains.current.get(k) === done) chains.current.delete(k)
          })
        }
        return out
      },
      land(key: string, card: BoardCard): void {
        landed.current.set(key, { card, at: Date.now() })
      },
    }),
    [],
  )
}

/**
 * Board `key` of `repo` (see the module header). `options.label` names a repository on its
 * items (`owner/name`, default its name); `options.repos` are the repositories the page already
 * holds, with their sessions, and `options.sessionOf` the session the viewer already holds for
 * another private repository (a private source or card repository the viewer is a member of:
 * its items open, §2.5).
 */
export function useBoard(
  repo: RepoRef,
  key: number,
  options: { readonly label?: (repo: RepoRef) => string; readonly repos?: ReadonlyMap<string, RepoRef>; readonly sessionOf?: BoardItemsInput['sessionOf'] } = {},
): BoardHookState {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  const { role } = useViewerRole(repo)
  const holdKey = `${network}:${repoKey(repo)}:${key}`
  // A page may rebuild its RepoRef every render: the reads key on `holdKey`, and take the latest one.
  const repoRef = useRef(repo)
  repoRef.current = repo
  const forgeKey = Object.values(repo.forge).join(',')
  const [held, setHeld] = useState<Held | null>(null)
  const heldRef = useRef(held)
  heldRef.current = held
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [overlay, setOverlay] = useState<ReadonlyMap<string, Pending>>(new Map())
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const queue = useCardQueue()
  const [refusal, setRefusal] = useState<BoardRefusalNote | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const reader = useMemo(
    () => (sdk === null ? null : boardItemReader(sdk, repoRef.current.forge, network, (r) => (optionsRef.current.label ?? ((x: RepoRef) => x.name))(r))),
    // `forgeKey` names the deployment the reader reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sdk, forgeKey, network],
  )
  const inputOf = useCallback(
    (board: BoardView, cards: readonly BoardCard[]): BoardItemsInput => {
      const o = optionsRef.current
      return { home: repoRef.current, spec: board.spec as BoardSpec, cards, now: Date.now(), ...(o.repos ? { repos: o.repos } : {}), ...(o.label ? { label: o.label } : {}), ...(o.sessionOf ? { sessionOf: o.sessionOf } : {}) }
    },
    [],
  )

  // The full read: the definition, every card, the items.
  useEffect(() => {
    if (!ready || sdk === null || reader === null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const read = await readBoard(sdk, repoRef.current, key)
        if (cancelled) return
        if (read === null) {
          setHeld({ key: holdKey, board: null, cards: [], items: null, since: 0, notFound: true })
          return
        }
        const items = read.board.spec === null ? null : await loadBoardItems(reader, inputOf(read.board, read.cards))
        if (cancelled) return
        setHeld({ key: holdKey, board: read.board, cards: read.cards, items, since: read.since, notFound: false })
        setNow(Date.now())
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // `holdKey` names the repo (its sessions), the board and the network
  }, [ready, sdk, reader, holdKey, nonce, inputOf, key])

  /** Read the cards changed since the last read, and the items new ones name. */
  const poll = useCallback(async (): Promise<void> => {
    const h = heldRef.current
    if (sdk === null || reader === null || h === null || h.key !== holdKey || h.board === null) return
    const fresh = await readCardsSince(sdk, repoRef.current, key, h.since)
    const cards = mergeCards(h.cards, fresh)
    const read = h.items === null || h.board.spec === null ? null : await addCardItems(reader, inputOf(h.board, cards), h.items)
    // merged into what is held now: an older-closed read or a quick add that landed meanwhile stays
    setHeld((cur) => (cur === null || cur.key !== holdKey ? cur : { ...cur, cards: mergeCards(cur.cards, fresh), items: unionItems(cur.items, read), since: Math.max(cur.since, cardsSince(fresh)) }))
    setNow(Date.now())
  }, [sdk, reader, key, holdKey, inputOf])

  /** Re-read the definition (a member saved it, or closed the board). */
  const rereadDefinition = useCallback(async (): Promise<void> => {
    if (sdk === null) return
    const board = await readBoardDefinition(sdk, repoRef.current, key)
    setHeld((cur) => (cur === null || cur.key !== holdKey ? cur : { ...cur, board, notFound: board === null }))
  }, [sdk, key, holdKey])

  // §5.7: poll every 20 s while visible; on show or focus re-read the definition and poll.
  useEffect(() => {
    if (!ready || sdk === null) return
    let cancelled = false
    let last = Date.now()
    let inFlight = false
    const tick = async (definition: boolean): Promise<void> => {
      if (cancelled || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      last = Date.now()
      try {
        if (definition) await rereadDefinition()
        await poll()
      } catch {
        // a failed poll is no news: the next one asks again
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(() => void tick(false), BOARD_POLL_MS)
    const onShown = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - last >= BOARD_FOCUS_THROTTLE_MS) void tick(true)
    }
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('focus', onShown)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('focus', onShown)
    }
  }, [ready, sdk, poll, rereadDefinition])

  const current = held !== null && held.key === holdKey ? held : null
  const board = current?.board ?? null
  // A landed write's optimistic card goes once a poll shows it.
  useEffect(() => {
    const heldCards = current?.cards ?? []
    if ([...overlay.values()].some((p) => caughtUp(p, heldCards))) {
      setOverlay((cur) => new Map([...cur].filter(([, p]) => !caughtUp(p, heldCards))))
    }
  }, [current, overlay])
  const cards = useMemo(() => (overlay.size === 0 ? (current?.cards ?? []) : [...(current?.cards ?? []), ...[...overlay.values()].map((p) => p.card)]), [current, overlay])
  const fold = useMemo(() => (board === null || current?.items == null ? null : assembleBoard(board, current.items, cards, now)), [board, current, cards, now])
  const can = canOf(role, signer !== null, board)

  /**
   * Run a write for `items`: show `patchOf(item)` over the item's newest card at once, sign, then
   * poll (the landed card replaces the optimistic one); on a refusal take it back with the reason.
   */
  const run = useCallback(
    async <T>(items: readonly CardItem[], patchOf: ((item: CardItem) => CardPatch) | null, write: (w: { sdk: NonNullable<typeof sdk>; signer: WriteAuth; board: BoardView; overs: ReadonlyMap<string, BoardCard> }) => Promise<T>): Promise<T> => {
      const w = needWriter(sdk, signer)
      const h = heldRef.current
      if (h === null || h.board === null) throw new Error('This board has not loaded yet.')
      const b = h.board
      setRefusal(null)
      const token = ++tokens
      if (patchOf !== null && b.spec !== null) {
        const spec = b.spec
        const newest = newestCards(h.cards)
        setOverlay((cur) => {
          const next = new Map(cur)
          for (const item of items) {
            try {
              // over an earlier write still shown (in flight, or landed and not yet polled): it is the item's newest
              const c = patchedCard(spec, cur.get(item.id)?.card ?? newest.get(item.id) ?? null, patchOf(item))
              next.set(item.id, { card: { id: `pending:${item.id}`, ownerId: w.signer.identityId, updatedAt: PENDING_AT, item: item.id, ...c }, token, landed: null })
            } catch {
              // a patch the board refuses is refused again by the write, with its reason
            }
          }
          return next
        })
      }
      /** Settle this write's optimistic cards: keep a landed one until a poll shows it, take the rest back. */
      const settle = (landed: ReadonlyMap<string, string>): void =>
        setOverlay((cur) => {
          const next = new Map(cur)
          for (const item of items) {
            const p = next.get(item.id)
            if (p === undefined || p.token !== token) continue
            const id = landed.get(item.id)
            if (id === undefined) next.delete(item.id)
            else next.set(item.id, { ...p, landed: { id, at: Date.now() } })
          }
          return next
        })
      try {
        const out = await queue.run(
          items.map((i) => i.id),
          (overs) => write({ ...w, board: b, overs }),
        )
        settle(landedOf(out))
        await poll().catch(() => undefined)
        const failed = (out as Partial<BulkWritten>)?.failed
        if (failed != null) setRefusal({ items: [failed.item], message: errorMessage(failed.error), error: failed.error })
        return out
      } catch (e) {
        settle(new Map())
        setRefusal({ items: items.map((i) => i.id), message: errorMessage(e), error: e })
        throw e
      }
    },
    [sdk, signer, poll, queue],
  )

  return {
    board,
    cards,
    items: current?.items ?? null,
    fold,
    now,
    loading: loading && current === null,
    error,
    notFound: current?.notFound ?? false,
    role,
    can,
    pending: new Set([...overlay].filter(([, p]) => p.landed === null).map(([id]) => id)),
    refusal,
    dismissRefusal: () => setRefusal(null),
    refresh: () => setNonce((n) => n + 1),
    async loadOlderClosed() {
      const h = heldRef.current
      if (reader === null || h === null || h.board === null || h.items === null || !h.items.hasOlderClosed) return
      const older = await loadOlderClosed(reader, inputOf(h.board, h.cards), h.items)
      // the walks are the older read's; any item a poll added meanwhile stays
      setHeld((cur) => (cur === null || cur.key !== h.key ? cur : { ...cur, items: unionItems(older, cur.items) }))
    },
    write: (item, patch, opts) => run([item], () => patch, (w) => writeCard(w.sdk, w.signer, repo, w.board, item, patch, { ...opts, overs: w.overs })),
    move: (item, target, column, before, opts) => {
      // the rank shown at once is the one the write computes; a refusal (re-rank) takes it back
      const r = rankBefore(column, item.id, before)
      const rank = 'rank' in r ? { rank: r.rank } : {}
      const optimistic = (): CardPatch => ('col' in target ? { col: target.col, ...rank } : { fields: { [target.field]: target.value }, ...rank })
      return run([item], optimistic, (w) => moveCard(w.sdk, w.signer, repo, w.board, item, target, column, before, { ...opts, overs: w.overs }))
    },
    add: (items, col, opts) => run(items, () => ({ state: 0, ...(col !== undefined ? { col } : {}) }), (w) => addItems(w.sdk, w.signer, repo, w.board, items, col, { ...opts, overs: w.overs })),
    archive: (items, opts) => run(items, () => ({ state: 1 }), (w) => archiveItems(w.sdk, w.signer, repo, w.board, items, { ...opts, overs: w.overs })),
    unarchive: (items, opts) => run(items, () => ({ state: 0 }), (w) => unarchiveItems(w.sdk, w.signer, repo, w.board, items, { ...opts, overs: w.overs })),
    remove: (items, opts) => run(items, () => ({ state: 2 }), (w) => removeItems(w.sdk, w.signer, repo, w.board, items, { ...opts, overs: w.overs })),
    rerank: (items, opts) => run(items, null, (w) => rerankColumn(w.sdk, w.signer, repo, w.board, items, { ...opts, overs: w.overs })),
    moveOpenToNextIteration: (fieldId, opts) => {
      const h = heldRef.current
      if (h === null || h.board?.spec == null || h.items === null || fold === null) return Promise.reject(new Error('This board has not loaded yet.'))
      const t = Date.now()
      const plan = nextIterationPlan(h.board.spec, fieldId, h.items.items, fold.items, t)
      const items = h.items.items
      const placements = fold.items
      return run(plan?.items ?? [], plan === null ? null : () => ({ fields: { [fieldId]: plan.next } }), (w) => moveOpenToNextIteration(w.sdk, w.signer, repo, w.board, fieldId, items, placements, t, { ...opts, overs: w.overs }))
    },
    quickAdd: async (input) => {
      const out = await run([], null, (w) => quickAddIssue(w.sdk, w.signer, repo, w.board, input))
      // the next edit of the new item builds on its card, whatever the reads show yet
      if (out.card !== null) queue.land(out.item.id, out.card.card)
      // the new issue is on the board at once, whatever the lists have read yet, labelled as the board labels its repository
      const item = { ...out.item, repo: (optionsRef.current.label ?? ((x: RepoRef) => x.name))(input.target ?? repoRef.current) }
      setHeld((cur) => (cur === null || cur.items === null ? cur : { ...cur, items: withItem(cur.items, item) }))
      return { ...out, item }
    },
    save: async (change, opts) => {
      const w = needWriter(sdk, signer)
      const out = await saveBoard(w.sdk, w.signer, repo, key, change, opts)
      await rereadDefinition().catch(() => undefined)
      return out
    },
    setState: async (state, opts) => {
      const w = needWriter(sdk, signer)
      const out = await setBoardState(w.sdk, w.signer, repo, key, state, opts)
      await rereadDefinition().catch(() => undefined)
      return out
    },
  }
}

/** One board an issue or PR is on, with where it shows there (null: the definition did not open). */
export interface ItemBoardPlacement extends ItemBoard {
  readonly placement: Placement | null
}

/**
 * The boards `item` of `repo` is on (§5.6: home is `repo` or another repository of its owner),
 * with its placement on each, and the writes that change its status and fields there (each the
 * home repository's members only, as on the board).
 */
export function useItemBoards(repo: RepoRef, item: BoardItem | null): AsyncState<ItemBoardPlacement[]> & {
  /** Write `patch` to the item's card on `entry`'s board. */
  readonly write: (entry: ItemBoard, patch: CardPatch, opts?: CardWriteOptions) => Promise<CardWritten>
  /** Put the item on `board` of `repo` (an active card, in `col` when given). */
  readonly addTo: (board: BoardView, col?: number, opts?: CardWriteOptions) => Promise<CardWritten>
} {
  const { sdk, ready, network } = useSdk(repoContractIds(repo))
  const { signer } = useAuth()
  // a board of another of the owner's repositories counts too
  const generation = useBoardWriteGeneration()
  const state = useAsync(
    async () => {
      const entries = await readItemCards(sdk!, repo, item!.id)
      const now = Date.now()
      return entries.map((e) => ({ ...e, placement: itemPlacement(e, item!, now) }))
    },
    [ready, repoKey(repo), network, item?.id ?? '', item?.state ?? '', generation],
    { enabled: ready && sdk !== null && item !== null },
  )
  // A re-read (after any board write) keeps the last list up meanwhile: the sidebar's controls,
  // and the error a refused write shows on its board, stay mounted.
  const held = useRef<{ readonly id: string; readonly data: ItemBoardPlacement[] } | null>(null)
  if (state.data !== null && item !== null) held.current = { id: item.id, data: state.data }
  const data = state.data ?? (item !== null && held.current?.id === item.id ? held.current.data : null)
  const queue = useCardQueue()
  /** Write `patch` to the item's card on `board` of `home`, queued per (board, item): the same item on two boards is two cards. */
  const queued = useCallback(
    (home: RepoRef, board: BoardView, patch: CardPatch, opts?: CardWriteOptions) => {
      const w = needWriter(sdk, signer)
      if (item === null) return Promise.reject(new Error('No item.'))
      const key = `${home.repoId}:${board.key}:${item.id}`
      return queue.run(
        [key],
        (overs) => writeCard(w.sdk, w.signer, home, board, { id: item.id, repoId: item.repoId }, patch, { ...opts, ...(overs.has(key) ? { over: overs.get(key) } : {}) }),
        () => key,
      )
    },
    [sdk, signer, item, queue],
  )
  const write = useCallback((entry: ItemBoard, patch: CardPatch, opts?: CardWriteOptions) => queued(entry.home, entry.board, patch, opts), [queued])
  const addTo = useCallback((board: BoardView, col?: number, opts?: CardWriteOptions) => queued(repo, board, { state: 0, ...(col !== undefined ? { col } : {}) }, opts), [queued, repo])
  return { ...state, data, write, addTo }
}
