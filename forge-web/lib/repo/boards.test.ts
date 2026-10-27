/**
 * The board data layer (`docs/design/boards.md`): reads (newest revision per key, cards, the
 * poll's `>=` and its dedupe, an item's boards), card writes over a fresh read of the item's
 * newest card (§3.2), ranks on a move (§2.6), refusals before signing, and a private repo's
 * sealed boards and cards round-tripping through the writes and the reads (§3.3).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import { IdSet } from '../private/ids'
import { EpochKeys } from '../private/keys'
import { RoleRefusedError } from '../rules/roles'
import { defaultSpec, foldBoard, parseFieldValues, serializeSpec, type BoardItem, type BoardSpec } from '../rules/boards'
import type { CardPatch } from './board-writes'
import type { RepoRef } from './contract'
import type { PrivateSession } from './private-session'

type Doc = Record<string, unknown>
const id = (n: number): string => base58Encode(new Uint8Array(32).fill(n))
const ME = id(1)
const OTHER = id(2)
const REPO_ID = id(9)
const ITEM = id(20)
const ITEM2 = id(21)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', meta: 'META', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: REPO_ID, ownerId: ME, name: 'repo', visibility: 'public' }
const AUTH = { identityId: ME, network: 'devnet' as const, getSigningKeyWif: () => 'W' }
const sdk = {} as EvoSDK
const SPEC: BoardSpec = defaultSpec(REPO_ID, Date.UTC(2026, 9, 26))

/** The documents queries answer, by type. */
let stored: Record<string, Doc[]> = {}
const created: { type: string; data: Doc; intent?: string }[] = []
const replaced: { type: string; id: string; changes: Doc }[] = []
let role: 'maintainer' | 'writer' | 'triage' | 'reader' = 'writer'
let duplicateOnCreate = false

function matches(d: Doc, [field, op, value]: readonly [string, string, unknown]): boolean {
  const v = d[field]
  if (op === '==') return v === value
  if (op === '>=') return (v as number) >= (value as number)
  if (op === '<=') return (v as number) <= (value as number)
  if (op === 'in') return (value as unknown[]).includes(v)
  throw new Error(`mock: ${op}`)
}
function answer(q: { documentTypeName: string; where?: readonly (readonly [string, string, unknown])[] }): Doc[] {
  return (stored[q.documentTypeName] ?? []).filter((d) => (q.where ?? []).every((w) => matches(d, w)))
}

vi.mock('./role-claim', async (orig) => {
  const { claimedRole } = await import('../rules/roles')
  return {
    ...(await orig<typeof import('./role-claim')>()),
    roleClaim: async (_sdk: unknown, _auth: unknown, _repo: unknown, type: string, data: Record<string, unknown>) => ({ r: claimedRole(type, data, role) }),
  }
})
vi.mock('../sdk', async (orig) => {
  const real = await orig<typeof import('../sdk')>()
  return {
    ...real,
    queryAllDocuments: async (_sdk: unknown, q: { documentTypeName: string; where?: readonly (readonly [string, string, unknown])[] }) => answer(q),
    queryDocumentsWithProof: async (_sdk: unknown, q: { documentTypeName: string; where?: readonly (readonly [string, string, unknown])[] }) => ({ documents: answer(q), proofMetadata: null }),
    createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { documentType: string; data: Doc; intent?: string }) => {
      if (duplicateOnCreate) throw new real.ConsensusRefusal(real.DUPLICATE_UNIQUE_CODE, 'duplicate unique index')
      created.push({ type: p.documentType, data: p.data, ...(p.intent ? { intent: p.intent } : {}) })
      return { documentId: `new${created.length}`, confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    },
    replaceDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { documentType: string; documentId: string; changes: Doc }) => {
      replaced.push({ type: p.documentType, id: p.documentId, changes: p.changes })
      return { documentId: p.documentId, revision: 2n, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    },
  }
})
let writerKeys: EpochKeys | null = null
vi.mock('./private-writes', async (orig) => ({
  ...(await orig<typeof import('./private-writes')>()),
  privateWriter: async () => ({ keys: writerKeys, protectedPatterns: [], isMember: true }),
}))
const repos: Record<string, Doc> = {}
vi.mock('./resolveRepo', async (orig) => ({
  ...(await orig<typeof import('./resolveRepo')>()),
  readRepoById: async (_sdk: unknown, _forge: unknown, repoId: string) => repos[repoId] ?? null,
}))

const boards = await import('./boards')
const writes = await import('./board-writes')

function specJson(s: BoardSpec = SPEC): string {
  const r = serializeSpec(s)
  if ('error' in r) throw new Error(r.error)
  return r.json
}

function boardDoc(over: Doc): Doc {
  return { $id: 'b1', $ownerId: ME, $updatedAt: 100, repoId: REPO_ID, key: 7, name: 'Roadmap', spec: specJson(), state: 0, r: 1, ...over }
}
function cardDoc(over: Doc): Doc {
  return { $id: 'c1', $ownerId: ME, $updatedAt: 100, repoId: REPO_ID, board: 7, item: ITEM, state: 0, r: 1, ...over }
}

beforeEach(() => {
  stored = {}
  created.length = 0
  replaced.length = 0
  role = 'writer'
  duplicateOnCreate = false
  writerKeys = null
})

describe('readBoards', () => {
  it('takes the newest revision per key over every member, drops deleted and malformed ones', async () => {
    stored['board'] = [
      boardDoc({ $id: 'a', key: 7, name: 'Old', $updatedAt: 10 }),
      boardDoc({ $id: 'b', $ownerId: OTHER, key: 7, name: 'New', $updatedAt: 20 }),
      boardDoc({ $id: 'c', key: 8, state: 2, $updatedAt: 30 }),
      boardDoc({ $id: 'd', key: 9, state: 1, $updatedAt: 30 }),
      // a public repo's board carrying enc is malformed here
      boardDoc({ $id: 'e', key: 10, enc: 'AAAA', epoch: 0 }),
    ]
    const list = await boards.readBoards(sdk, REPO)
    expect(list.map((b) => [b.key, b.name, b.state])).toEqual([
      [7, 'New', 'open'],
      [9, 'Roadmap', 'closed'],
    ])
    expect(list[0]?.revisions.map((r) => r.ownerId)).toEqual([ME, OTHER])
    expect(list[0]?.spec?.columns.map((c) => c.name)).toEqual(['Todo', 'In progress', 'Done'])
    expect((await boards.readBoards(sdk, REPO, { withDeleted: true })).map((b) => b.key)).toEqual([7, 8, 9])
  })

  it("lists a public repository's sealed board as unreadable rather than dropping it (newest-wins never goes back)", async () => {
    stored['board'] = [boardDoc({ $id: 'old', $updatedAt: 10, name: 'Old' }), { $id: 'sealed', $ownerId: OTHER, $updatedAt: 20, repoId: REPO_ID, key: 7, state: 0, epoch: 0, enc: 'AAAA', r: 1 }]
    const [b] = await boards.readBoards(sdk, REPO)
    expect(b).toMatchObject({ key: 7, name: null, sealed: true, specError: 'unreadable', newest: { id: 'sealed' } })
  })

  it('reports a definition the rules refuse', async () => {
    stored['board'] = [boardDoc({ spec: '{"v":2}' })]
    const [b] = await boards.readBoards(sdk, REPO)
    expect(b?.spec).toBeNull()
    expect(b?.specError).toBe('version')
  })
})

describe('readBoard and the poll', () => {
  it('reads the definition and every card, and the poll reads >= the last time, deduplicated by $id', async () => {
    stored['board'] = [boardDoc({})]
    stored['card'] = [cardDoc({ $id: 'c1', $updatedAt: 100, col: 1 }), cardDoc({ $id: 'c2', item: ITEM2, $updatedAt: 200, col: 2 })]
    const read = await boards.readBoard(sdk, REPO, 7)
    expect(read?.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(read?.since).toBe(200)
    // a replace of c1 lands, and c3 shares c2's block time
    stored['card'] = [cardDoc({ $id: 'c1', $updatedAt: 300, col: 3 }), cardDoc({ $id: 'c2', item: ITEM2, $updatedAt: 200, col: 2 }), cardDoc({ $id: 'c3', $ownerId: OTHER, $updatedAt: 200, col: 2 })]
    const fresh = await boards.readCardsSince(sdk, REPO, 7, read?.since ?? 0)
    expect(fresh.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3'])
    const merged = boards.mergeCards(read?.cards ?? [], fresh)
    expect(merged.map((c) => [c.id, c.col])).toEqual([
      ['c2', 2],
      ['c3', 2],
      ['c1', 3],
    ])
    // an older copy never replaces a newer one
    expect(boards.mergeCards(merged, [{ ...(merged[2] as (typeof merged)[number]), updatedAt: 1, col: 1 }]).find((c) => c.id === 'c1')?.col).toBe(3)
  })

  it('is null for a board with no revision', async () => {
    expect(await boards.readBoard(sdk, REPO, 7)).toBeNull()
  })
})

describe('readItemCards (§5.6)', () => {
  it("keeps the item's repo and the owner's other public repos, never a stranger's board", async () => {
    const SIBLING = id(10)
    const STRANGER = id(11)
    repos[SIBLING] = { repoId: SIBLING, ownerId: ME, name: 'plan', visibility: 'public' }
    repos[STRANGER] = { repoId: STRANGER, ownerId: OTHER, name: 'theirs', visibility: 'public' }
    stored['board'] = [boardDoc({}), boardDoc({ $id: 'sb', repoId: SIBLING, key: 3, name: 'Plan' }), boardDoc({ $id: 'xb', repoId: STRANGER, key: 4, name: 'Spam' })]
    stored['card'] = [cardDoc({ $id: 'c1', col: 2 }), cardDoc({ $id: 'c2', repoId: SIBLING, board: 3, col: 1 }), cardDoc({ $id: 'c3', repoId: STRANGER, board: 4 })]
    const list = await boards.readItemCards(sdk, REPO, ITEM)
    expect(list.map((e) => [e.home.repoId, e.board.key, e.card?.id])).toEqual([
      [REPO_ID, 7, 'c1'],
      [SIBLING, 3, 'c2'],
    ])
    // a private sibling's boards are sealed with a key this page does not hold: left out
    const SECRET = id(12)
    repos[SECRET] = { repoId: SECRET, ownerId: ME, name: 'secret', visibility: 'private' }
    stored['card'].push(cardDoc({ $id: 'c4', repoId: SECRET, board: 5, enc: 'AAAA', epoch: 0 }))
    expect((await boards.readItemCards(sdk, REPO, ITEM)).map((e) => e.home.repoId)).toEqual([REPO_ID, SIBLING])
    const item: BoardItem = { id: ITEM, number: 1, repoId: REPO_ID, kind: 'issue', state: 'open', createdAt: 1, closedAt: null, title: 't', labels: [], assignees: [], milestone: null, author: ME }
    expect(boards.itemPlacement(list[0] as (typeof list)[number], item, 1000)?.col).toBe(2)
  })
})

const ITEM_REF = { id: ITEM, repoId: REPO_ID }

async function openBoard(over: Doc = {}) {
  stored['board'] = [boardDoc(over)]
  return (await boards.readBoardDefinition(sdk, REPO, 7)) as NonNullable<Awaited<ReturnType<typeof boards.readBoardDefinition>>>
}

describe('writeCard: a fresh read of the newest card, then only the change (§3.2)', () => {
  it("applies the patch over another member's newer card and creates the signer's own", async () => {
    const board = await openBoard()
    stored['card'] = [cardDoc({ $id: 'mine', $ownerId: OTHER, $updatedAt: 50, col: 1 }), cardDoc({ $id: 'theirs', $ownerId: OTHER, $updatedAt: 90, col: 2, rank: 'Vx', f: '{"1":1}' })]
    // ...but `mine` is not the signer's: both are OTHER's, so this is a create
    const out = await writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { fields: { 2: 5 } })
    expect(out.created).toBe(true)
    expect(created).toHaveLength(1)
    const data = created[0]?.data as Doc
    expect(data['col']).toBe(2)
    expect(data['rank']).toBe('Vx')
    expect(parseFieldValues(data['f'] as string, SPEC)).toEqual({ 1: 1, 2: 5 })
    expect(data['state']).toBe(0)
    expect(data['r']).toBe(1)
    expect(data['board']).toBe(7)
    expect(out.card).toMatchObject({ col: 2, rank: 'Vx', item: ITEM })
  })

  it("replaces the signer's own card, removing a cleared field's values", async () => {
    const board = await openBoard()
    stored['card'] = [cardDoc({ $id: 'mine', $updatedAt: 90, col: 2, rank: 'Vx', f: '{"1":1}' })]
    const out = await writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { fields: { 1: null }, col: 3 })
    expect(out.created).toBe(false)
    expect(replaced).toEqual([{ type: 'card', id: 'mine', changes: expect.objectContaining({ col: 3, rank: 'Vx', f: undefined, state: 0, r: 1 }) }])
  })

  it("replaces the signer's own card even when this reader skips it as malformed", async () => {
    const board = await openBoard()
    // plaintext beside enc: malformed, skipped by readers, but still the signer's document
    stored['card'] = [cardDoc({ $id: 'broken', col: 1, enc: 'AAAA', epoch: 0 }), cardDoc({ $id: 'theirs', $ownerId: OTHER, $updatedAt: 200, col: 3 })]
    const out = await writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { rank: 'Vz' })
    expect(out.created).toBe(false)
    expect(replaced[0]).toMatchObject({ id: 'broken', changes: { col: 3, rank: 'Vz', enc: undefined, epoch: undefined } })
  })

  it('reads the definition fresh: a column another member added since is accepted, a board closed since is refused', async () => {
    const stale = await openBoard()
    stored['board'] = [boardDoc({ $id: 'b2', $ownerId: OTHER, $updatedAt: 500, spec: specJson({ ...SPEC, columns: [...SPEC.columns, { id: 9, name: 'Verified' }] }) })]
    await writes.writeCard(sdk, AUTH, REPO, stale, ITEM_REF, { col: 9 })
    expect(created[0]?.data['col']).toBe(9)
    stored['board'] = [boardDoc({ $id: 'b3', $ownerId: OTHER, $updatedAt: 600, state: 1 })]
    await expect(writes.writeCard(sdk, AUTH, REPO, stale, ITEM_REF, { col: 1 })).rejects.toMatchObject({ refusal: 'closed' })
  })

  it('a create that meets the signer\'s card made meanwhile replaces it instead', async () => {
    const board = await openBoard()
    duplicateOnCreate = true
    const read = { n: 0 }
    const original = stored
    stored = new Proxy(original, {
      get(t, k: string) {
        if (k === 'card') return read.n++ === 0 ? [] : [cardDoc({ $id: 'tab2' })]
        return t[k]
      },
    })
    const out = await writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 1 })
    expect(out.created).toBe(false)
    expect(replaced.map((r) => r.id)).toEqual(['tab2'])
  })
})

describe('refused before signing', () => {
  it('a closed board is read-only', async () => {
    const board = await openBoard({ state: 1 })
    await expect(writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 1 })).rejects.toMatchObject({ refusal: 'closed' })
    await expect(writes.saveBoard(sdk, AUTH, REPO, 7, { name: 'x' })).rejects.toMatchObject({ refusal: 'closed' })
    expect(created.length + replaced.length).toBe(0)
  })

  it('a column, rank, field or value the board does not have', async () => {
    const board = await openBoard()
    const patches: CardPatch[] = [{ col: 99 }, { rank: 'V0' }, { fields: { 77: 1 } }, { fields: { 1: 99 } }, { fields: { 3: -1 } }, { state: 3 }]
    for (const patch of patches) {
      await expect(writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, patch)).rejects.toMatchObject({ refusal: 'input' })
    }
    expect(created.length + replaced.length).toBe(0)
  })

  it('triage places cards but does not define boards; a reader does neither', async () => {
    const board = await openBoard()
    role = 'triage'
    await writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 1 })
    expect(created[0]?.data['r']).toBe(2)
    await expect(writes.createBoard(sdk, AUTH, REPO, { name: 'Mine', spec: SPEC })).rejects.toBeInstanceOf(RoleRefusedError)
    role = 'reader'
    await expect(writes.writeCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 1 })).rejects.toBeInstanceOf(RoleRefusedError)
    expect(created).toHaveLength(1)
  })

  it('a board name or definition the schema or the rules refuse', () => {
    expect(() => writes.checkBoardInput({ name: '  ', spec: SPEC })).toThrow(/board name/)
    expect(() => writes.checkBoardInput({ name: 'n'.repeat(64), spec: SPEC })).toThrow(/board name/)
    expect(() => writes.checkBoardInput({ name: 'ok', spec: { ...SPEC, columns: [] } })).toThrow(/columns/)
    expect(writes.checkBoardInput({ name: ' Roadmap ', spec: SPEC }).name).toBe('Roadmap')
  })

  it("a private home's card for another repository's item, until confirmed (§3.3)", async () => {
    const priv: RepoRef = { ...REPO, visibility: 'private' }
    expect(writes.crossRepoCardNeedsConfirm(priv, id(30))).toBe(true)
    expect(writes.crossRepoCardNeedsConfirm(priv, REPO_ID)).toBe(false)
    expect(writes.crossRepoCardNeedsConfirm(REPO, id(30))).toBe(false)
    const board = await openBoard()
    await expect(writes.writeCard(sdk, AUTH, priv, board, { id: ITEM, repoId: id(30) }, { col: 1 })).rejects.toMatchObject({ refusal: 'cross-repo' })
  })
})

describe('moving: ranks between neighbours (§2.6)', () => {
  const col = (...ranks: string[]) => ranks.map((rank, i) => ({ id: id(40 + i), rank }))

  it('top, bottom, between, empty, and the moving card itself left out', () => {
    expect(writes.rankForDrop([], 0)).toEqual({ rank: 'F' })
    const c = col('A', 'V1000000', 'b')
    expect(writes.rankForDrop(c, 0)).toEqual({ rank: '5' })
    expect(writes.rankForDrop(c, 3)).toEqual({ rank: 'n' })
    const mid = writes.rankForDrop(c, 1)
    expect('rank' in mid && mid.rank > 'A' && mid.rank < 'V1000000').toBe(true)
    // the top bracket stays above the sourced pool (V…) even when the first card is in it
    const top = writes.rankForDrop(col('V2', 'V3'), 0)
    expect('rank' in top && top.rank < 'V').toBe(true)
  })

  it('a drop "before X" means before X whether the card came from above or below it', () => {
    const [a, m, b, c] = col('A', 'M', 'b', 'q')
    const column = [a, m, b, c] as { id: string; rank: string }[]
    // M dropped before c (moving down): between b and q, not below q
    const down = writes.rankBefore(column, m!.id, c!.id)
    expect('rank' in down && down.rank > 'b' && down.rank < 'q').toBe(true)
    // c dropped before a (moving up): the top
    expect(writes.rankBefore(column, c!.id, a!.id)).toEqual(writes.rankForDrop([a!, m!, b!], 0))
    // null, or a card not in the column: the bottom
    expect(writes.rankBefore(column, a!.id, null)).toEqual(writes.rankForDrop([m!, b!, c!], 3))
  })

  it('moveCard writes the column and the rank; no room is refused with re-rank before signing', async () => {
    const board = await openBoard()
    const ac = col('A', 'C')
    await writes.moveCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 2 }, ac, ac[1]?.id ?? null)
    expect(created[0]?.data).toMatchObject({ col: 2, rank: 'B' })
    const aa = col('A', 'A')
    await expect(writes.moveCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 2 }, aa, aa[1]?.id ?? null)).rejects.toMatchObject({ refusal: 're-rank', column: 2 })
    const vv = col('V', 'V0')
    await expect(writes.moveCard(sdk, AUTH, REPO, board, ITEM_REF, { col: 2 }, vv, vv[1]?.id ?? null)).rejects.toMatchObject({ refusal: 're-rank' })
    expect(created).toHaveLength(1)
  })

  it('a move on a view grouped by a field sets the field', async () => {
    const board = await openBoard()
    await writes.moveCard(sdk, AUTH, REPO, board, ITEM_REF, { field: 1, value: 2 }, [], null)
    expect(parseFieldValues(created[0]?.data['f'] as string, SPEC)).toEqual({ 1: 2 })
  })

  it('re-rank: evenly spaced ranks below the pool, one write each, priced first', async () => {
    const board = await openBoard()
    stored['card'] = [cardDoc({ $id: 'mine', item: ITEM2 })]
    expect(writes.planCardWrites(stored['card'].map((d) => ({ id: String(d['$id']), ownerId: String(d['$ownerId']), updatedAt: 1, item: String(d['item']), col: null, rank: null, f: null, state: 0 })), ME, [ITEM, ITEM2])).toEqual({ creates: 1, replaces: 1 })
    stored['card'] = []
    const out = await writes.rerankColumn(sdk, AUTH, REPO, board, [ITEM_REF, { id: ITEM2, repoId: REPO_ID }])
    expect(out.failed).toBeNull()
    const ranks = created.map((c) => c.data['rank'] as string)
    expect(ranks).toHaveLength(2)
    expect(ranks[0]! < ranks[1]! && ranks[1]! < 'V').toBe(true)
  })

  it('a bulk write stops at the first failure and says what was skipped', async () => {
    const board = await openBoard()
    role = 'reader'
    const out = await writes.archiveItems(sdk, AUTH, REPO, board, [ITEM_REF, { id: ITEM2, repoId: REPO_ID }])
    expect(out.written).toHaveLength(0)
    expect(out.failed?.item).toBe(ITEM)
    expect(out.skipped).toEqual([ITEM2])
  })
})

describe('boards: create, save, close', () => {
  it('creates under a key derived from the intent, skipping a taken one', async () => {
    const k0 = writes.newBoardKey(REPO, 'intent-1', 0)
    stored['board'] = [boardDoc({ $ownerId: OTHER, key: k0 })]
    const out = await writes.createBoard(sdk, AUTH, REPO, { name: 'Sprint', spec: SPEC, intent: 'intent-1' })
    expect(out.key).toBe(writes.newBoardKey(REPO, 'intent-1', 1))
    expect(out.created).toBe(true)
    expect(created[0]?.data).toMatchObject({ key: out.key, name: 'Sprint', state: 0, r: 1 })
    expect(writes.newBoardKey(REPO)).toBeGreaterThan(0)
  })

  it('a retry of a create whose first attempt landed replaces the signer\'s revision', async () => {
    const k0 = writes.newBoardKey(REPO, 'intent-2', 0)
    stored['board'] = [boardDoc({ $id: 'landed', key: k0, name: 'Sprint' })]
    const out = await writes.createBoard(sdk, AUTH, REPO, { name: 'Sprint', spec: SPEC, intent: 'intent-2' })
    expect(out).toMatchObject({ key: k0, created: false, documentId: 'landed' })
  })

  it("saves over the newest revision, replacing the signer's own or creating it", async () => {
    stored['board'] = [boardDoc({ $id: 'theirs', $ownerId: OTHER, $updatedAt: 50, name: 'Theirs' })]
    await writes.saveBoard(sdk, AUTH, REPO, 7, { spec: { ...SPEC, arch: 30 } })
    expect(created[0]?.data).toMatchObject({ key: 7, name: 'Theirs' })
    expect(JSON.parse(created[0]?.data['spec'] as string).arch).toBe(30)
    stored['board'].push(boardDoc({ $id: 'mine', $updatedAt: 10 }))
    await writes.setBoardState(sdk, AUTH, REPO, 7, 'closed')
    expect(replaced[0]).toMatchObject({ id: 'mine', changes: { state: 1, name: 'Theirs' } })
  })
})

describe('next iteration (§5.4)', () => {
  it("moves the current iteration's open items outside Done", () => {
    const now = Date.UTC(2026, 9, 28)
    const item = (n: number, state: BoardItem['state'] = 'open'): BoardItem => ({ id: id(50 + n), number: n, repoId: REPO_ID, kind: 'issue', state, createdAt: n, closedAt: state === 'open' ? null : 1, title: `#${n}`, labels: [], assignees: [], milestone: null, author: ME })
    const items = [item(1), item(2), item(3, 'closed'), item(4)]
    const cards = [
      { id: 'k1', ownerId: ME, updatedAt: 5, item: id(51), col: 1, rank: null, f: '{"3":0}', state: 0 },
      { id: 'k2', ownerId: ME, updatedAt: 5, item: id(52), col: 3, rank: null, f: '{"3":0}', state: 0 },
      { id: 'k3', ownerId: ME, updatedAt: 5, item: id(53), col: 1, rank: null, f: '{"3":0}', state: 0 },
      { id: 'k4', ownerId: ME, updatedAt: 5, item: id(54), col: 1, rank: null, f: '{"3":1}', state: 0 },
    ]
    const fold = foldBoard({ spec: SPEC, home: REPO_ID, items, cards, now })
    const plan = writes.nextIterationPlan(SPEC, 3, items, fold.items, now)
    expect(plan).toEqual({ next: 1, items: [{ id: id(51), repoId: REPO_ID }] })
  })
})

describe('quick add references', () => {
  it('reads #n, owner/name#n and this app\'s links', () => {
    expect(writes.parseItemReference('#12')).toEqual({ number: 12 })
    expect(writes.parseItemReference('alice/forge#7')).toEqual({ owner: 'alice', name: 'forge', number: 7 })
    expect(writes.parseItemReference('https://git-forge.dashhq.org/repo/issue/?owner=alice&name=forge&number=3')).toEqual({ owner: 'alice', name: 'forge', number: 3 })
    expect(writes.parseItemReference('Fix the build')).toBeNull()
    expect(writes.parseItemReference('https://example.com/a?owner=a&name=b&number=1')).toBeNull()
  })
})

describe('a private repository: sealed boards and cards (§3.3)', () => {
  it('seals on write and opens on read with the session; without it nothing is shown', async () => {
    const repoBytes = new Uint8Array(32).fill(9)
    const keys = await EpochKeys.import(repoBytes, 0, new Uint8Array(32).fill(3))
    writerKeys = keys
    const session = { ctx: { keys: new Map([[0, keys]]), anchors: new Map([[0, { id: new Uint8Array(32), height: 1, statedHeight: 1 }]]), members: new IdSet([]) } } as unknown as PrivateSession
    const priv: RepoRef = { ...REPO, visibility: 'private', session }
    const made = await writes.createBoard(sdk, AUTH, priv, { name: 'Secret plan', spec: SPEC })
    const boardData = created[0]?.data as Doc
    expect(boardData['name']).toBeUndefined()
    expect(boardData['spec']).toBeUndefined()
    expect(boardData['epoch']).toBe(0)
    expect(boardData['enc']).toBeInstanceOf(Uint8Array)
    const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
    stored['board'] = [{ $id: 'sb', $ownerId: ME, $updatedAt: 5, repoId: REPO_ID, key: made.key, state: 0, epoch: 0, enc: toB64(boardData['enc'] as Uint8Array), r: 1 }]
    const [b] = await boards.readBoards(sdk, priv)
    expect(b).toMatchObject({ name: 'Secret plan', sealed: true, state: 'open' })
    expect(b?.spec?.columns).toHaveLength(3)

    await writes.writeCard(sdk, AUTH, priv, b as NonNullable<typeof b>, ITEM_REF, { col: 2, rank: 'Vq', fields: { 2: 3 } })
    const cardData = created[1]?.data as Doc
    expect(['col', 'rank', 'f'].filter((k) => cardData[k] !== undefined)).toEqual([])
    stored['card'] = [{ $id: 'sc', $ownerId: ME, $updatedAt: 6, repoId: REPO_ID, board: made.key, item: ITEM, state: 0, epoch: 0, enc: toB64(cardData['enc'] as Uint8Array), r: 1 }]
    const read = await boards.readBoard(sdk, priv, made.key)
    expect(read?.cards[0]).toMatchObject({ col: 2, rank: 'Vq', f: '{"2":3}' })
    // moved to another item, the seal fails: the card keeps only its state
    stored['card'] = [{ ...(stored['card'][0] as Doc), item: ITEM2 }]
    expect((await boards.readBoard(sdk, priv, made.key))?.cards[0]).toMatchObject({ item: ITEM2, col: null, rank: null, f: null })

    // a reader without the session sees no name or definition
    const locked: RepoRef = { ...REPO, visibility: 'private' }
    const [lockedBoard] = await boards.readBoards(sdk, locked)
    expect(lockedBoard).toMatchObject({ name: null, spec: null, specError: 'unreadable', sealed: true })
    // a private board carrying a plaintext name is malformed and skipped
    stored['board'].push({ ...(stored['board'][0] as Doc), $id: 'bad', key: 99, name: 'leak' })
    expect((await boards.readBoards(sdk, priv)).map((x) => x.key)).toEqual([made.key])
  })
})
