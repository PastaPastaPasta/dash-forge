/**
 * Boards, live on testnet or a devnet (`docs/design/boards.md` §3, forge-meta `board` and `card`,
 * UPDATE-3): the web's data layer (`./boards`, `./board-writes`, `./board-items`) against the real
 * contract, every write through the WriteEngine. SKIPPED by default (real spend: about 0.02 DASH
 * for the owner, a throwaway repository and its writes):
 *
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=testnet \
 *     FORGE_BOARDS_OWNER=<identity.json> FORGE_BOARDS_STRANGER=<identity.json> \
 *     [FORGE_BOARDS_TRIAGE=<identity.json>] [FORGE_BOARDS_RECORD=<deployment record.json>] \
 *     pnpm exec vitest run lib/repo/boards.live.test.ts
 *   (or NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=<name>)
 *
 * FORGE_BOARDS_RECORD names another contract set on the same network (a scratch rehearsal's
 * record, `forge-contracts/evidence/testnet/rehearsal-scratch-record.json`): its ids replace the
 * network's. It needs `board` and `card` in that set's forge-meta (`deploy-v2.mjs --update meta`);
 * until that lands the test says so and ends before it spends.
 *
 *   1. OWNER creates a throwaway public repository (`boards-live-<time>`) and two issues;
 *   2. OWNER creates a board (the Kanban template), saves a rename (a replace), closes it (a card
 *      write is then refused before signing) and reopens it; a second board is created and deleted;
 *   3. OWNER places issue 1 (a card create), moves it (a replace with a rank), sets two fields and
 *      archives it; TRIAGE (granted the triage role here) places issue 2, is refused a board, is
 *      removed, and is then refused a replace of its own card (the gate is checked on every
 *      replace); OWNER moves issue 2 too, and is refused a card naming no issue or PR (`item`'s
 *      `refersTo`);
 *   4. the reads see it all: `readBoards`, `readBoard`, `readCardsSince` (the poll), `readItemCards`
 *      (the issue sidebar), and the fold (`loadBoardItems` + `assembleBoard`) puts each issue where
 *      the newest card says;
 *   5. STRANGER (no membership) writes a card and a board through the data layer, which claims
 *      role 1 for a non-member as for every gated type, and consensus refuses both (the member
 *      gate, 40120). TRIAGE is refused a board by the client before signing, and by consensus when
 *      it signs one anyway (its writer document's role is not the claimed `r`: 40127 or 40120).
 *
 * It prints what each write cost, for docs/economics.md and lib/sdk/cost.ts (`FEE …` lines). The
 * repository is left as it is (documents of a public throwaway repo; nothing to clean up).
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { decodeIdentifier } from '../auth/base58'
import { parseIdentityFileText } from '../auth'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { forgeV2Ids, type DeploymentFile, type ForgeIds } from '../deployments'
import { resetMemoryStores } from '../idb'
import { RoleRefusedError } from '../rules/roles'
import { CARD_ARCHIVED, defaultSpec, serializeSpec } from '../rules/boards'
import { ConsensusRefusal, GATE_REFUSED_CODE, createDocumentIdempotent, evoSdkService, type WriteAuth } from '../sdk'
import { readIdentityBalance } from '../sdk/write'
import { assembleBoard, boardItemReader, loadBoardItems } from './board-items'
import { BoardWriteError, createBoard, moveCard, saveBoard, setBoardState, writeCard, archiveItems, newBoardKey } from './board-writes'
import { itemPlacement, readBoard, readBoardDefinition, readBoards, readCardsSince, readItemCards } from './boards'
import { boardsDeployed } from './boards-deployed'
import { DOC, type RepoRef } from './contract'
import { invalidateMembers, readRoleOracle } from './members'
import { isMemberGateRefusal } from './role-claim'
import { acceptInvite, createIssue, createRepo, grantMember, revokeMember } from './writes'

const network = DEFAULT_NETWORK
const env = (k: string): string => process.env[k] ?? ''
const OWNER_FILE = env('FORGE_BOARDS_OWNER')
const STRANGER_FILE = env('FORGE_BOARDS_STRANGER')
const TRIAGE_FILE = env('FORGE_BOARDS_TRIAGE')
const RECORD_FILE = env('FORGE_BOARDS_RECORD')
// Never on mainnet: it spends real credits.
const LIVE = process.env['FORGE_LIVE'] === '1' && network !== 'mainnet' && [OWNER_FILE, STRANGER_FILE].every((f) => f !== '' && existsSync(f))

function authOf(file: string): WriteAuth {
  const parsed = parseIdentityFileText(readFileSync(file, 'utf8'))
  return { identityId: parsed.identityId, network, getSigningKeyWif: () => parsed.signingKeyWif }
}

/** The contract set under test: FORGE_BOARDS_RECORD's (a scratch set), else the network's. */
function forgeUnderTest(): ForgeIds {
  const forge = RECORD_FILE !== '' ? forgeV2Ids(JSON.parse(readFileSync(RECORD_FILE, 'utf8')) as DeploymentFile) : NETWORKS[network].v2
  if (forge === null || forge.meta === undefined) throw new Error(`no four-contract forge-v2 set ${RECORD_FILE !== '' ? `in ${RECORD_FILE}` : `on ${network}`}`)
  return forge
}

/** Credits to DASH, for the printed lines. */
const dash = (credits: bigint): string => (Number(credits) / 1e11).toFixed(6)
const say = (line: string): void => void process.stdout.write(`${line}\n`)
/** `pred` as a rejection matcher that says which consensus refusal it saw, for the record. */
const refusal =
  (label: string, pred: (e: unknown) => boolean) =>
  (e: unknown): boolean => {
    const ok = pred(e)
    if (ok) say(`${label}: refused at consensus (${(e as ConsensusRefusal).code}: ${(e as Error).message.slice(0, 160)})`)
    return ok
  }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Read `read` until `done` holds (a node that has not applied the last block yet answers the state before it). */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, tries = 15): Promise<T> {
  let v = await read()
  for (let i = 0; i < tries && !done(v); i++) {
    await sleep(2000)
    v = await read()
  }
  return v
}

describe.skipIf(!LIVE)('live boards (forge-meta board and card)', () => {
  it(
    'a member defines a board and places cards; the reads and the fold agree; a stranger and triage are refused at consensus',
    async () => {
      const forge = forgeUnderTest()
      await evoSdkService.initialize({ network, contractIds: [], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      if (!(await boardsDeployed(sdk, forge.meta))) {
        say(`SKIPPED: forge-meta ${forge.meta} has no board and card yet (deploy-v2.mjs --update meta is pending). Nothing was spent.`)
        return
      }
      resetMemoryStores()
      const OWNER = authOf(OWNER_FILE)
      const STRANGER = authOf(STRANGER_FILE)
      const TRIAGE = TRIAGE_FILE !== '' && existsSync(TRIAGE_FILE) ? authOf(TRIAGE_FILE) : null

      /** What `step` cost `who`, once the balance settles. */
      const measure = async <T>(who: WriteAuth, label: string, step: () => Promise<T>): Promise<T> => {
        const before = await readIdentityBalance(sdk, who.identityId)
        const out = await step()
        let after = before
        for (let i = 0; i < 15; i += 1) {
          await sleep(2000)
          const now = await readIdentityBalance(sdk, who.identityId)
          if (now === after && now !== before) break
          after = now
        }
        say(`FEE ${label}: ${before - after} credits (${dash(before - after)} DASH)`)
        return out
      }

      // 1. A throwaway public repository and two issues.
      const name = `boards-live-${Date.now().toString(36)}`
      const created = await createRepo(sdk, OWNER, forge, { name })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: OWNER.identityId, name, visibility: 'public' }
      say(`repo ${name} ${repo.repoId} on forge-meta ${forge.meta}`)
      const one = await createIssue(sdk, OWNER, repo, { title: 'boards live: first', body: '' })
      const two = await createIssue(sdk, OWNER, repo, { title: 'boards live: second', body: '' })
      const item1 = { id: one.documentId, repoId: repo.repoId }
      const item2 = { id: two.documentId, repoId: repo.repoId }

      // 2. A board: create, rename (replace), close, reopen; a second one created and deleted.
      const spec = defaultSpec(repo.repoId, Date.now())
      const board = await measure(OWNER, 'board create (the repo’s first)', () => createBoard(sdk, OWNER, repo, { name: 'Live board', spec }))
      expect(board.created).toBe(true)
      const key = board.key
      const other = await measure(OWNER, 'board create (a later one)', () => createBoard(sdk, OWNER, repo, { name: 'Second board', spec }))
      const saved = await measure(OWNER, 'board save (rename: a replace)', () => saveBoard(sdk, OWNER, repo, key, { name: 'Live board, renamed' }))
      expect(saved).toMatchObject({ created: false, documentId: board.documentId })
      await measure(OWNER, 'board close (a replace)', () => setBoardState(sdk, OWNER, repo, key, 'closed'))
      const closed = await eventually(() => readBoardDefinition(sdk, repo, key), (b) => b?.state === 'closed')
      expect(closed).toMatchObject({ state: 'closed', name: 'Live board, renamed' })
      // a closed board is read-only: refused before anything is signed
      await expect(writeCard(sdk, OWNER, repo, closed!, item1, { col: 1 })).rejects.toSatisfy((e: unknown) => e instanceof BoardWriteError && e.refusal === 'closed')
      await measure(OWNER, 'board reopen (a replace)', () => setBoardState(sdk, OWNER, repo, key, 'open'))
      await measure(OWNER, 'board delete (state 2, a replace)', () => setBoardState(sdk, OWNER, repo, other.key, 'deleted'))
      const boards = await eventually(() => readBoards(sdk, repo), (bs) => bs.length === 1 && bs[0]?.state === 'open')
      expect(boards.map((b) => [b.key, b.name, b.state])).toEqual([[key, 'Live board, renamed', 'open']])
      expect((await readBoards(sdk, repo, { withDeleted: true })).find((b) => b.key === other.key)?.state).toBe('deleted')
      const view = (await readBoardDefinition(sdk, repo, key))!
      expect(view.spec).toEqual(spec)
      expect(view.revisions).toHaveLength(1)

      // 3. Cards: place, move (with a rank), set fields, archive.
      const placed = await measure(OWNER, 'card create (the board’s first, the item’s first)', () => writeCard(sdk, OWNER, repo, view, item1, { col: 1 }))
      expect(placed.created).toBe(true)
      const moved = await measure(OWNER, 'card move (column and rank: a replace)', () => moveCard(sdk, OWNER, repo, view, item1, { col: 2 }, [], null))
      expect(moved).toMatchObject({ created: false, card: { id: placed.card.id, col: 2 } })
      const rank = moved.card.rank
      expect(rank).not.toBeNull()
      await measure(OWNER, 'card set fields (a replace)', () => writeCard(sdk, OWNER, repo, view, item1, { fields: { 1: 1, 2: 3 } }))
      const read = await eventually(() => readBoard(sdk, repo, key), (r) => r?.cards[0]?.f !== null && r?.cards[0]?.f !== undefined)
      expect(read?.cards).toHaveLength(1)
      expect(read?.cards[0]).toMatchObject({ id: placed.card.id, ownerId: OWNER.identityId, item: item1.id, col: 2, rank, f: '{"1":1,"2":3}', state: 0 })
      const since = read!.since
      const archived = await measure(OWNER, 'card archive (a replace)', () => archiveItems(sdk, OWNER, repo, view, [item1]))
      expect(archived.failed).toBeNull()
      // the poll: what changed at or after the last read
      const polled = await eventually(() => readCardsSince(sdk, repo, key, since), (cs) => cs.some((c) => c.state === CARD_ARCHIVED))
      expect(polled.find((c) => c.id === placed.card.id)).toMatchObject({ state: CARD_ARCHIVED, col: 2, rank, f: '{"1":1,"2":3}' })

      // Triage places cards (r 2), never boards; then the owner moves the same item (the newest card wins).
      if (TRIAGE !== null) {
        await acceptInvite(sdk, TRIAGE, repo)
        await grantMember(sdk, OWNER, repo, TRIAGE.identityId, 'triage')
        await eventually(
          async () => {
            invalidateMembers(repo, network)
            return (await readRoleOracle(sdk, repo, network)).currentRole(TRIAGE.identityId)
          },
          (r) => r === 'triage',
        )
        const triaged = await measure(TRIAGE, 'card create (triage, the item’s first)', () => writeCard(sdk, TRIAGE, repo, view, item2, { col: 2 }))
        expect(triaged.created).toBe(true)
        await expect(createBoard(sdk, TRIAGE, repo, { name: 'Triage board', spec })).rejects.toBeInstanceOf(RoleRefusedError)
        const triageBoard = createDocumentIdempotent(sdk, TRIAGE, {
          contractId: forge.meta!,
          documentType: DOC.board,
          data: { repoId: decodeIdentifier(repo.repoId), key: newBoardKey(repo), state: 0, name: 'Triage board', spec: (serializeSpec(spec) as { json: string }).json, r: 1 },
        })
        await expect(triageBoard).rejects.toSatisfy(refusal('triage: a board signed anyway', isMemberGateRefusal))
        // The gate is checked again on every replace: once the owner removes the triage member,
        // its own card can no longer be replaced.
        await revokeMember(sdk, OWNER, repo, TRIAGE.identityId, 'triage')
        await eventually(
          async () => {
            invalidateMembers(repo, network)
            return (await readRoleOracle(sdk, repo, network)).currentRole(TRIAGE.identityId)
          },
          (r) => r !== 'triage',
        )
        await measure(TRIAGE, 'card replace by a removed member, refused (processing fee)', () =>
          expect(writeCard(sdk, TRIAGE, repo, view, item2, { col: 1 })).rejects.toSatisfy(refusal('removed triage: a replace of its own card', isMemberGateRefusal)),
        )
        await measure(OWNER, 'card create (owner, an item that has a card)', () => writeCard(sdk, OWNER, repo, view, item2, { col: 3 }))
      } else {
        say('SKIPPED triage: no FORGE_BOARDS_TRIAGE identity; the owner places issue 2')
        await measure(OWNER, 'card create (the item’s first)', () => writeCard(sdk, OWNER, repo, view, item2, { col: 3 }))
      }

      // A card names an issue or a PR (`item` refersTo forge-collab's issue or patch): a member's card
      // naming anything else (here the repository document's id) is refused at consensus.
      await measure(OWNER, 'card naming no issue or PR, refused (processing fee)', () =>
        expect(writeCard(sdk, OWNER, repo, view, { id: repo.repoId, repoId: repo.repoId }, { col: 1 })).rejects.toSatisfy(
          refusal('a card naming the repository document', (e) => e instanceof ConsensusRefusal),
        ),
      )

      // 4. The reads and the fold.
      const all = await eventually(() => readBoard(sdk, repo, key), (r) => (r?.cards.length ?? 0) === (TRIAGE !== null ? 3 : 2))
      expect(all?.board).toMatchObject({ key, name: 'Live board, renamed', state: 'open' })
      const input = { home: repo, spec, cards: all!.cards, now: Date.now() }
      const items = await loadBoardItems(boardItemReader(sdk, forge, network), input)
      expect(new Set(items.items.map((i) => i.id))).toEqual(new Set([item1.id, item2.id]))
      const fold = assembleBoard(all!.board, items, all!.cards, input.now)!
      const at = (id: string) => fold.items.find((p) => p.id === id)
      expect(at(item1.id)).toMatchObject({ on: true, sourced: true, col: 2, rank, archived: 'card', fields: { '1': 1, '2': 3 } })
      expect(at(item2.id)).toMatchObject({ on: true, col: 3, archived: null })
      // archived items are hidden from the columns; issue 2 is in Done
      expect(fold.columns.find((c) => c.id === 3)?.items).toEqual([item2.id])
      expect(fold.columns.flatMap((c) => c.items)).not.toContain(item1.id)
      // the issue sidebar: the boards issue 1 is on, with its status there
      const sidebar = await readItemCards(sdk, repo, item1.id)
      expect(sidebar.map((e) => e.board.key)).toEqual([key])
      const issue1 = items.items.find((i) => i.id === item1.id)!
      expect(itemPlacement(sidebar[0]!, issue1, input.now)).toMatchObject({ col: 2, archived: 'card' })

      // 5. A stranger: the client claims role 1 for an identity with no membership (as for every
      // gated type: `claimedRole`), so the write is signed and the member gate refuses it.
      const gate = (e: unknown): boolean => e instanceof ConsensusRefusal && e.code === GATE_REFUSED_CODE
      await measure(STRANGER, 'stranger card, refused (processing fee)', () => expect(writeCard(sdk, STRANGER, repo, view, item1, { col: 1 })).rejects.toSatisfy(refusal('stranger: a card', gate)))
      await measure(STRANGER, 'stranger board, refused (processing fee)', () => expect(createBoard(sdk, STRANGER, repo, { name: 'Stranger board', spec })).rejects.toSatisfy(refusal('stranger: a board', gate)))
      // nothing of the stranger's landed
      const after = await readBoard(sdk, repo, key)
      expect(after?.cards.some((c) => c.ownerId === STRANGER.identityId)).toBe(false)
      expect((await readBoards(sdk, repo, { withDeleted: true })).every((b) => b.revisions.every((r) => r.ownerId !== STRANGER.identityId))).toBe(true)
    },
    30 * 60_000,
  )
})
