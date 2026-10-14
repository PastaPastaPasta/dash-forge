/**
 * A bot's push access (`./push-grants`; forge-core `push_grants`, `collab::v2::bot_push` and `dg bot
 * allow --push | renew | suspend | resume | revoke --push`) over a mocked SDK: reading a grant as
 * consensus admits it, what the page says of each grant (§10), readers' marks, and every change
 * refused before signing where it must be, writing its grants before the notice that lists them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { BranchKey, DEFAULT_PUSH_POLICY, allowsPush, bytesToHex, pushEntries, pushPolicy, setPush, type AccessNotice, type NoticeEntry } from '../private'
import type { PushGrant } from '../rules/push-grant'
import type { RefUpdate } from '../rules/types'
import type { Membership } from '../rules/v2'
import type { PlainDocument, WriteAuth } from '../sdk'
import type { RepoRef } from './contract'

const m = vi.hoisted(() => ({
  queryAllDocuments: vi.fn(),
  createDocumentIdempotent: vi.fn(),
  deleteDocumentIdempotent: vi.fn(),
  contractHasType: vi.fn(),
  contractHasProperty: vi.fn(),
  readMembershipsFresh: vi.fn(),
  readMembershipsCached: vi.fn(),
  readAccessNotices: vi.fn(),
  readAccessNoticesCached: vi.fn(),
  writeAccessNotice: vi.fn(),
  readHeldBranches: vi.fn(),
  readMembersOnlyNames: vi.fn(),
}))

vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryAllDocuments: m.queryAllDocuments,
  createDocumentIdempotent: m.createDocumentIdempotent,
  deleteDocumentIdempotent: m.deleteDocumentIdempotent,
}))
vi.mock('./contract-shape', () => ({ contractHasType: m.contractHasType, contractHasProperty: m.contractHasProperty }))
vi.mock('./members', () => ({ readMembershipsFresh: m.readMembershipsFresh, readMembershipsCached: m.readMembershipsCached }))
vi.mock('./branch-ring', () => ({ readHeldBranches: m.readHeldBranches }))
vi.mock('./members-branches', () => ({ readMembersOnlyNames: m.readMembersOnlyNames }))
vi.mock('./bot-access', async (orig) => ({
  ...(await orig<typeof import('./bot-access')>()),
  readAccessNotices: m.readAccessNotices,
  readAccessNoticesCached: m.readAccessNoticesCached,
  writeAccessNotice: m.writeAccessNotice,
}))

const pg = await import('./push-grants')

const id = (n: number): string => base58Encode(new Uint8Array(32).fill(n))
const BOT = id(7)
const ME = id(1)
const OTHER = id(2)
const OWNER = id(3)
const REPO = id(9)
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 14)

const repo = { repoId: REPO, ownerId: OWNER, visibility: 'public', forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'G' } } as unknown as RepoRef
const auth = { identityId: ME, network: 'testnet' } as unknown as WriteAuth
const about = { bot: BOT, name: '@ci-bot', display: 'o/r' }

const members: Membership[] = [
  { identity: ME, role: 'maintainer', createdAt: 1 },
  { identity: OTHER, role: 'maintainer', createdAt: 1 },
  { identity: BOT, role: 'bot', createdAt: 1000 },
]

const grant = ({ n, ...over }: Partial<PushGrant> & { readonly n: number }): PushGrant => ({
  id: id(100 + n),
  granter: ME,
  bot: BOT,
  prefix: 'refs/heads/bot/ci-bot/',
  until: NOW + 30 * DAY,
  createdAt: 2000,
  ...over,
})

const grantDoc = (g: PushGrant): PlainDocument => ({
  $id: g.id,
  $ownerId: g.granter,
  $createdAt: g.createdAt,
  botId: g.bot,
  until: g.until,
  ...(g.prefix !== undefined ? { prefix: g.prefix } : {}),
  ...(g.scope !== undefined ? { scope: Uint8Array.from(Buffer.from(g.scope, 'hex')) } : {}),
})

const baseNotice: AccessNotice = { bot: decodeIdentifier(BOT), may: ['post'], askers: 'writers', threads: 'all', processor: null, until: null, revokes: [], note: '', extra: {} }
const entryOf = (n: AccessNotice, at = 3000): NoticeEntry => ({ id: id(50), writer: ME, createdAt: at, packHash: 'ab'.repeat(32), notice: n })
const listing = (gs: readonly PushGrant[]): AccessNotice =>
  setPush(
    baseNotice,
    gs.map((g) => ({ grant: decodeIdentifier(g.id), target: { prefix: g.prefix as string } })),
    DEFAULT_PUSH_POLICY,
  )

function setup(grants: PushGrant[], notice: NoticeEntry | null, supported = true): void {
  m.contractHasType.mockResolvedValue(supported)
  m.contractHasProperty.mockResolvedValue(supported)
  m.readMembershipsFresh.mockResolvedValue(members)
  m.readMembershipsCached.mockResolvedValue(members)
  m.queryAllDocuments.mockImplementation(async (_sdk: unknown, q: { where: unknown[][] }) => {
    const bot = q.where.find((w) => w[0] === 'botId')?.[2]
    return grants.filter((g) => bot === undefined || g.bot === bot).map(grantDoc)
  })
  const all = notice === null ? [] : [notice]
  m.readAccessNotices.mockResolvedValue({ all, current: new Map(notice === null ? [] : [[BOT, notice]]), unreadable: 0 })
  m.readAccessNoticesCached.mockResolvedValue({ all, current: new Map(), unreadable: 0 })
}

let written: number
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  written = 0
  m.createDocumentIdempotent.mockImplementation(async () => ({ documentId: id(200 + ++written), confirmed: true }))
  m.deleteDocumentIdempotent.mockResolvedValue({ confirmed: true })
  m.writeAccessNotice.mockResolvedValue({ ids: ['N'], packHash: 'cd'.repeat(32) })
  m.readHeldBranches.mockResolvedValue(null)
  m.readMembersOnlyNames.mockResolvedValue([])
})

const sdk = {} as never

describe('reading grants', () => {
  it('reads a grant as consensus admits it, and leaves out one it would not', () => {
    const g = grant({ n: 1 })
    expect(pg.grantOfDoc(grantDoc(g))).toEqual(g)
    expect(pg.grantOfDoc({ ...grantDoc(g), scope: new Uint8Array(32) })).toBeNull()
    expect(pg.grantOfDoc({ ...grantDoc(g), until: 2000 })).toBeNull()
    const exact = grant({ n: 2, prefix: undefined, scope: 'ab'.repeat(32) })
    delete (exact as { prefix?: string }).prefix
    expect(pg.grantOfDoc(grantDoc(exact))?.scope).toBe('ab'.repeat(32))
  })

  it('reads nothing where the contract has no grants', async () => {
    setup([grant({ n: 1 })], null, false)
    expect(await pg.readPushGrants(sdk, repo)).toEqual([])
    const state = await pg.readPushState(sdk, repo)
    expect(state.supported).toBe(false)
    expect(m.queryAllDocuments).not.toHaveBeenCalled()
    expect(m.readMembershipsCached).not.toHaveBeenCalled()
    expect((await pg.readBotPushMarks(sdk, repo, [])).marks.size).toBe(0)
    expect((await pg.readPushingBots(sdk, repo)).size).toBe(0)
  })

  it('names a bot\'s grant on its ref update and marks it', () => {
    const g = grant({ n: 1 })
    const push = (over: Partial<RefUpdate>): RefUpdate => ({ id: 'u', refNameHash: '', refName: 'refs/heads/bot/ci-bot/x', newOid: 'aa', author: BOT, createdAt: 3000, botPush: { grant: g.id }, ...over })
    const notices = { all: [entryOf(listing([g]), 2500)] }
    const marks = pg.botPushMarks(
      [push({ id: 'ok' }), push({ id: 'old', botPush: { grant: id(150) } }), push({ id: 'human', botPush: undefined, author: ME })],
      [g, grant({ n: 50, createdAt: 500 })],
      members,
      notices,
      OWNER,
    )
    expect(marks.get('ok')).toBe('granted')
    // a grant older than the bot's current row
    expect(marks.get('old')).toBe('outside')
    expect(marks.has('human')).toBe(false)
    // a suspension in force when it landed
    const suspended = { all: [entryOf(setPush(listing([g]), [], DEFAULT_PUSH_POLICY), 2500)] }
    expect(pg.botPushMarks([push({ id: 'ok' })], [g], members, suspended, OWNER).get('ok')).toBe('outside')
  })
})

describe('what the page says', () => {
  const access = (grants: PushGrant[], notice: AccessNotice | null = listing(grants)): ReturnType<typeof pg.pushAccessOf> =>
    pg.pushAccessOf({ supported: true, grants, members, now: NOW }, BOT, notice === null ? null : entryOf(notice))

  it('lists live prefixes and counts members-only branches', () => {
    const exact = { ...grant({ n: 2, scope: 'ab'.repeat(32) }), prefix: undefined }
    const s = pg.summarizePush(access([grant({ n: 1 }), exact], listing([grant({ n: 1 })])))
    expect(s.prefixes).toEqual([['refs/heads/bot/ci-bot/', NOW + 30 * DAY]])
    expect(s.membersBranches).toBe(1)
    // the exact grant isn't in the notice
    expect(s.notes.map((n) => n.kind)).toEqual(['notInNotice'])
    expect(pg.pushNoteWords(s.notes[0] as never, '@ci-bot', '@m')).toBe("@m let @ci-bot push here; this isn't in @ci-bot's access settings.")
  })

  it('says each grant that needs attention in the design\'s words', () => {
    const due = grant({ n: 1, until: NOW + 9 * DAY - 1 })
    const ended = grant({ n: 2, prefix: 'refs/heads/gh-pages', until: NOW - 1 })
    const gone = grant({ n: 3, prefix: 'refs/heads/docs/', granter: id(4) })
    const older = grant({ n: 4, prefix: 'refs/heads/old/', createdAt: 500 })
    const s = pg.summarizePush(access([due, ended, gone, older], listing([due])))
    const words = s.notes.map((n) => pg.pushNoteWords(n, '@ci-bot', '@m'))
    expect(words).toEqual([
      "@ci-bot's push access to bot/ci-bot/ ends in 9 days.",
      `@ci-bot's push access ended on 13 Oct 2026.`,
      '@ci-bot can no longer push to docs/: @m is no longer a maintainer.',
      "@ci-bot had push access to old/ before it was removed. It won't come back; give it again if you want.",
    ])
    expect(s.renewable).toBe(true)
  })

  it('a newer grant over the same branches says nothing more, and a suspension leads', () => {
    const old = grant({ n: 1, until: NOW - 1, createdAt: 2000 })
    const fresh = grant({ n: 2, createdAt: 2500 })
    const s = pg.summarizePush(access([old, fresh], setPush(listing([fresh]), [], DEFAULT_PUSH_POLICY)))
    expect(s.notes).toEqual([])
    expect(s.suspended).toBe(true)
    expect(s.granters).toEqual([ME])
  })

  it('only a newer usable grant over the same branches replaces an older one', () => {
    const older = grant({ n: 1, createdAt: 2000 })
    // written later by someone who is no longer a maintainer: it hides nothing
    const newer = grant({ n: 2, createdAt: 2500, granter: id(4) })
    const s = pg.summarizePush(access([older, newer], listing([older])))
    expect(s.prefixes).toEqual([['refs/heads/bot/ci-bot/', NOW + 30 * DAY]])
    expect(s.live.map((g) => g.id)).toEqual([older.id])
    expect(s.notes.map((n) => n.kind)).toEqual(['granterGone'])
  })

  it("says an exact grant under an earlier key is stale, and doesn't count it", () => {
    const branches = [{ name: 'refs/heads/fix-auth', current: 'cd'.repeat(32), earlier: ['ab'.repeat(32)], audienceNow: new Set([BOT]) }]
    const staleGrant = { ...grant({ n: 1, scope: 'ab'.repeat(32) }), prefix: undefined }
    const fresh = { ...grant({ n: 2, scope: 'ab'.repeat(32) }), prefix: undefined, scope: 'cd'.repeat(32) }
    const s = pg.summarizePush(access([staleGrant], null), branches)
    expect(s.membersBranches).toBe(0)
    expect(s.live).toEqual([])
    expect(s.notes.map((n) => pg.pushNoteWords(n, '@ci-bot', '@m'))).toEqual(["@ci-bot can no longer push to fix-auth: the branch's key changed."])
    expect(pg.isStale(staleGrant, branches)).toBe(true)
    expect(pg.isStale(fresh, branches)).toBe(false)
    // under the current key it counts, and is named
    expect(pg.summarizePush(access([fresh], null), branches).membersBranches).toBe(1)
  })

  it('names who suspended a bot when giving it push access lets it push again', () => {
    const g = grant({ n: 1 })
    const off = { ...entryOf(setPush(listing([g]), [], DEFAULT_PUSH_POLICY)), writer: OTHER }
    expect(pg.suspendedBy(pg.pushAccessOf({ supported: true, grants: [g], members, now: NOW }, BOT, off))).toBe(OTHER)
    // a bot never given push access isn't suspended
    expect(pg.suspendedBy(pg.pushAccessOf({ supported: true, grants: [], members, now: NOW }, BOT, entryOf(baseNotice)))).toBeNull()
    expect(pg.suspendedBy(pg.pushAccessOf({ supported: true, grants: [g], members, now: NOW }, BOT, entryOf(listing([g]))))).toBeNull()
  })

  it('refuses a public prefix that is or covers a members-only branch, and any prefix it cannot check', () => {
    const prefix = (p: string) => ({ scope: { prefix: p }, label: p })
    const names = ['refs/heads/fix-auth', 'refs/heads/bot/ci-bot/wip']
    expect(pg.membersNameRefusal([prefix('refs/heads/fix-auth')], names)).toBe('fix-auth is a members-only branch: only branches shared with the bot can be given.')
    expect(pg.membersNameRefusal([prefix('refs/heads/fix')], names)).toBe('fix-auth is a members-only branch: only branches shared with the bot can be given.')
    expect(pg.membersNameRefusal([prefix('refs/heads/bot/ci-bot/')], names)).toContain('bot/ci-bot/wip is a members-only branch')
    expect(pg.membersNameRefusal([prefix('refs/heads/docs/')], names)).toBeNull()
    expect(pg.membersNameRefusal([prefix('refs/heads/docs/')], null)).toBe(pg.MEMBERS_UNCHECKED)
    // a branch shared with the bot is given exactly: nothing public names it
    expect(pg.membersNameRefusal([{ scope: { exact: new Uint8Array(32) }, label: 'fix-auth' }], null)).toBeNull()
  })

  it('costs a public notice: push access is never given in a private repo', () => {
    expect(pg.pushChangeCost(1)).toEqual(pg.pushChangeCost(1, 0))
  })

  it('grant words follow the design', () => {
    const until = Date.UTC(2026, 10, 7)
    expect(pg.grantWords('@ci-bot', { scope: { prefix: 'refs/heads/bot/ci-bot/' }, label: 'bot/ci-bot/' }, until)).toBe(
      "@ci-bot will be able to push to branches starting with bot/ci-bot/ until 7 Nov 2026. It can't push to protected branches. Everything it pushes to a public branch is public.",
    )
    expect(pg.grantWords('@ci-bot', { scope: { prefix: 'refs/heads/gh-pages' }, label: 'gh-pages' }, until)).toContain('push to gh-pages (and any branch whose name starts with gh-pages) until 7 Nov 2026')
    expect(pg.grantWords('@ci-bot', { scope: { exact: new Uint8Array(32) }, label: 'fix-auth' }, until)).toBe(
      '@ci-bot can push to fix-auth, a branch shared with it, until 7 Nov 2026. It never gets the key to other members-only content.',
    )
  })

  it('bounds the end date as the CLI does', () => {
    expect(pg.pushUntil(NOW, null)).toBe(NOW + 30 * DAY)
    expect(pg.pushUntil(NOW, NOW - 1)).toEqual({ error: 'That date has passed.' })
    expect(pg.pushUntil(NOW, NOW + 92 * DAY)).toEqual({ error: 'Push access lasts at most 90 days.' })
    // the 90th day's end is brought in, not refused
    expect(pg.pushUntil(NOW, NOW + 91 * DAY - 1)).toBe(NOW + 90 * DAY - 10 * 60_000)
  })
})

describe('changes', () => {
  it('refuses everything before signing where bots can\'t push', async () => {
    setup([], null, false)
    await expect(pg.givePush(sdk, auth, repo, about, { requests: [{ scope: { prefix: 'refs/heads/bot/ci-bot/' }, label: 'bot/ci-bot/' }], until: NOW + DAY, policy: DEFAULT_PUSH_POLICY }, 'i')).rejects.toThrow(
      "Bots can't push to this repo yet.",
    )
    await expect(pg.suspendPush(sdk, auth, repo, about)).rejects.toThrow("Bots can't push to this repo yet.")
    expect(m.createDocumentIdempotent).not.toHaveBeenCalled()
    expect(m.writeAccessNotice).not.toHaveBeenCalled()
  })

  it("refuses give and renew in a private repo before signing", async () => {
    const g = grant({ n: 1 })
    setup([g], entryOf(listing([g])))
    const closed = { ...repo, visibility: 'private' } as RepoRef
    const words = "Bots can't push to o/r, a private repository. Nothing was written."
    await expect(pg.givePush(sdk, auth, closed, about, { requests: [{ scope: { prefix: 'refs/heads/x/' }, label: 'x/' }], until: NOW + DAY, policy: DEFAULT_PUSH_POLICY }, 'i')).rejects.toThrow(words)
    await expect(pg.renewPush(sdk, auth, closed, about, NOW + DAY, 'i')).rejects.toThrow(words)
    expect(m.createDocumentIdempotent).not.toHaveBeenCalled()
    expect(m.writeAccessNotice).not.toHaveBeenCalled()
  })

  it('refuses a prefix naming a members-only branch before signing, and fails closed when it cannot check', async () => {
    const g = grant({ n: 1 })
    setup([g], entryOf(listing([g])))
    const give = (p: string) => pg.givePush(sdk, auth, repo, about, { requests: [{ scope: { prefix: p }, label: p }], until: NOW + DAY, policy: DEFAULT_PUSH_POLICY }, 'i')
    m.readMembersOnlyNames.mockResolvedValue(['refs/heads/fix-auth'])
    await expect(give('refs/heads/fix')).rejects.toThrow('fix-auth is a members-only branch: only branches shared with the bot can be given. Nothing was written.')
    m.readMembersOnlyNames.mockResolvedValue(null)
    await expect(give('refs/heads/docs/')).rejects.toThrow(pg.MEMBERS_UNCHECKED)
    // renewing a prefix checks it again
    m.readMembersOnlyNames.mockResolvedValue(['refs/heads/bot/ci-bot/wip'])
    await expect(pg.renewPush(sdk, auth, repo, about, NOW + DAY, 'i')).rejects.toThrow('bot/ci-bot/wip is a members-only branch')
    expect(m.createDocumentIdempotent).not.toHaveBeenCalled()
    expect(m.writeAccessNotice).not.toHaveBeenCalled()
    // a prefix that covers none is given
    m.readMembersOnlyNames.mockResolvedValue(['refs/heads/fix-auth'])
    await give('refs/heads/docs/')
    expect(m.createDocumentIdempotent).toHaveBeenCalledTimes(1)
  })

  it('refuses someone who is not a maintainer', async () => {
    setup([], entryOf(baseNotice))
    const outsider = { ...auth, identityId: id(8) } as WriteAuth
    await expect(pg.suspendPush(sdk, outsider, repo, about)).rejects.toThrow('Only maintainers')
    // the owner without a maintainer row can suspend, never give
    await expect(pg.givePush(sdk, { ...auth, identityId: OWNER } as WriteAuth, repo, about, { requests: [{ scope: { prefix: 'refs/heads/x/' }, label: 'x/' }], until: NOW + DAY, policy: DEFAULT_PUSH_POLICY }, 'i')).rejects.toThrow(
      'Only maintainers can give a bot push access',
    )
    expect(m.createDocumentIdempotent).not.toHaveBeenCalled()
  })

  it('gives: grants first, then the notice listing them beside the live ones it listed', async () => {
    const kept = grant({ n: 1, granter: OTHER })
    const ended = grant({ n: 2, prefix: 'refs/heads/x/', until: NOW - 1 })
    setup([kept, ended], entryOf(listing([kept, ended])))
    await pg.givePush(sdk, auth, repo, about, { requests: [{ scope: { prefix: 'refs/heads/gh-pages' }, label: 'gh-pages' }], until: NOW + 7 * DAY, policy: { fastForwardOnly: false, deleteOwnOnly: false, openPrNotPush: false } }, 'i')
    const create = m.createDocumentIdempotent.mock.calls[0]?.[2] as { documentType: string; data: Record<string, unknown> }
    expect(create.documentType).toBe('pushGrant')
    expect(create.data.prefix).toBe('refs/heads/gh-pages')
    expect(create.data.until).toBe(NOW + 7 * DAY)
    expect(base58Encode(create.data.botId as Uint8Array)).toBe(BOT)
    expect(base58Encode(create.data.repoId as Uint8Array)).toBe(REPO)
    const notice = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(allowsPush(notice)).toBe(true)
    expect(pushEntries(notice)?.map((e) => base58Encode(e.grant)).sort()).toEqual([kept.id, id(201)].sort())
    expect(pushPolicy(notice).fastForwardOnly).toBe(false)
    expect(bytesToHex(notice.revokes[0] as Uint8Array)).toBe('ab'.repeat(32))
    // what it already allowed stays
    expect(notice.may).toEqual(['post', 'push'])
  })

  it('refuses a bot without a Bot row and an end too far ahead', async () => {
    setup([], null)
    m.readMembershipsFresh.mockResolvedValue(members.filter((x) => x.role !== 'bot'))
    await expect(pg.givePush(sdk, auth, repo, about, { requests: [{ scope: { prefix: 'refs/heads/x/' }, label: 'x/' }], until: NOW + DAY, policy: DEFAULT_PUSH_POLICY }, 'i')).rejects.toThrow("isn't a bot of o/r")
    m.readMembershipsFresh.mockResolvedValue(members)
    await expect(pg.givePush(sdk, auth, repo, about, { requests: [{ scope: { prefix: 'refs/heads/x/' }, label: 'x/' }], until: NOW + 100 * DAY, policy: DEFAULT_PUSH_POLICY }, 'i')).rejects.toThrow('at most 90 days')
    expect(m.createDocumentIdempotent).not.toHaveBeenCalled()
  })

  it('suspends with a notice without push, and resumes with the live grants', async () => {
    const g = grant({ n: 1 })
    setup([g], entryOf(listing([g])))
    await pg.suspendPush(sdk, auth, repo, about)
    const off = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(off.may).toEqual(['post'])
    expect('push' in off.extra).toBe(false)
    setup([g], entryOf(off))
    await expect(pg.suspendPush(sdk, auth, repo, about)).rejects.toThrow("doesn't push to o/r now")
    await pg.resumePush(sdk, auth, repo, about)
    const on = m.writeAccessNotice.mock.calls[1]?.[3] as AccessNotice
    expect(pushEntries(on)?.map((e) => base58Encode(e.grant))).toEqual([g.id])
  })

  it('renews: a new grant per prefix, my old ones deleted, the notice lists the new ones', async () => {
    const mine = grant({ n: 1, until: NOW + 3 * DAY })
    const theirs = grant({ n: 2, granter: OTHER, prefix: 'refs/heads/docs/' })
    const older = grant({ n: 3, prefix: 'refs/heads/old/', createdAt: 500 })
    setup([mine, theirs, older], entryOf(listing([mine, theirs])))
    const got = await pg.renewPush(sdk, auth, repo, about, NOW + 30 * DAY, 'i')
    expect(got).toEqual({ renewed: 2, stillSuspended: false })
    expect(m.createDocumentIdempotent).toHaveBeenCalledTimes(2)
    // only the signer's own old grant is deleted (only its writer can)
    expect(m.deleteDocumentIdempotent.mock.calls.map((c) => (c[2] as { documentId: string }).documentId)).toEqual([mine.id])
    const notice = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(pushEntries(notice)?.map((e) => base58Encode(e.grant)).sort()).toEqual([id(201), id(202)].sort())
  })

  it('removes only my push access, and lists what others gave', async () => {
    const mine = grant({ n: 1 })
    const theirs = grant({ n: 2, granter: OTHER, prefix: 'refs/heads/docs/' })
    setup([mine, theirs], entryOf(listing([mine, theirs])))
    await pg.removeMyPush(sdk, auth, repo, about)
    expect(m.deleteDocumentIdempotent.mock.calls.map((c) => (c[2] as { documentId: string }).documentId)).toEqual([mine.id])
    const notice = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(pushEntries(notice)?.map((e) => base58Encode(e.grant))).toEqual([theirs.id])
    setup([theirs], entryOf(notice))
    await expect(pg.removeMyPush(sdk, auth, repo, about)).rejects.toThrow('You gave @ci-bot no push access')
  })

  it("removing my push access never lifts another maintainer's suspension", async () => {
    const mine = grant({ n: 1 })
    const theirs = grant({ n: 2, granter: OTHER, prefix: 'refs/heads/docs/' })
    setup([mine, theirs], { ...entryOf(setPush(listing([mine, theirs]), [], DEFAULT_PUSH_POLICY)), writer: OTHER })
    await pg.removeMyPush(sdk, auth, repo, about)
    expect(m.deleteDocumentIdempotent.mock.calls.map((c) => (c[2] as { documentId: string }).documentId)).toEqual([mine.id])
    expect(m.writeAccessNotice).not.toHaveBeenCalled()
  })

  it('leaves a stale exact grant out of resume, and renew writes it again under the current key', async () => {
    // fix-auth, shared with the bot, now at its second key generation
    const name = 'refs/heads/fix-auth'
    const keys = [BranchKey.fromBytes(new Uint8Array(32).fill(11)), BranchKey.fromBytes(new Uint8Array(32).fill(12))]
    m.readHeldBranches.mockResolvedValue({ ring: { branches: new Map([[name, { name, keys }]]) }, people: new Map([[name, new Set([BOT])]]), partial: false })
    const [branch] = await pg.readGrantableBranches(sdk, repo)
    if (branch === undefined) throw new Error('no branch')
    expect(branch.earlier).toHaveLength(1)
    const staleGrant: PushGrant = { id: id(101), granter: ME, bot: BOT, scope: branch.earlier[0] as string, until: NOW + 30 * DAY, createdAt: 2000 }
    const theirs = grant({ n: 2, granter: OTHER, prefix: 'refs/heads/docs/' })
    const listed = setPush(
      baseNotice,
      [
        { grant: decodeIdentifier(staleGrant.id), target: { members: Uint8Array.from(Buffer.from(staleGrant.scope as string, 'hex')) } },
        { grant: decodeIdentifier(theirs.id), target: { prefix: theirs.prefix as string } },
      ],
      DEFAULT_PUSH_POLICY,
    )
    // suspended: resume lists the prefix grant alone
    setup([staleGrant, theirs], entryOf(setPush(listed, [], DEFAULT_PUSH_POLICY)))
    await pg.resumePush(sdk, auth, repo, about)
    const resumed = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(pushEntries(resumed)?.map((e) => base58Encode(e.grant))).toEqual([theirs.id])
    // renewing writes it again under the branch's current hash, and deletes the stale one
    setup([staleGrant, theirs], entryOf(listed))
    await pg.renewPush(sdk, auth, repo, about, NOW + 30 * DAY, 'i')
    const creates = m.createDocumentIdempotent.mock.calls.map((c) => (c[2] as { data: Record<string, unknown> }).data)
    expect(creates.map((d) => (d.scope instanceof Uint8Array ? bytesToHex(d.scope) : d.prefix))).toEqual(['refs/heads/docs/', branch.current])
    expect(m.deleteDocumentIdempotent.mock.calls.map((c) => (c[2] as { documentId: string }).documentId)).toEqual([staleGrant.id])
    const renewed = m.writeAccessNotice.mock.calls[1]?.[3] as AccessNotice
    expect(pushEntries(renewed)?.map((e) => base58Encode(e.grant)).sort()).toEqual([id(201), id(202)].sort())
    // removing mine: the stale grant isn't listed with what others gave
    vi.clearAllMocks()
    m.readHeldBranches.mockResolvedValue({ ring: { branches: new Map([[name, { name, keys }]]) }, people: new Map([[name, new Set([BOT])]]), partial: false })
    m.writeAccessNotice.mockResolvedValue({ ids: ['N'], packHash: 'cd'.repeat(32) })
    m.deleteDocumentIdempotent.mockResolvedValue({ confirmed: true })
    const othersStale: PushGrant = { ...staleGrant, id: id(103), granter: OTHER }
    setup([othersStale, grant({ n: 4 }), theirs], entryOf(listed))
    await pg.removeMyPush(sdk, auth, repo, about)
    const rest = m.writeAccessNotice.mock.calls[0]?.[3] as AccessNotice
    expect(pushEntries(rest)?.map((e) => base58Encode(e.grant))).toEqual([theirs.id])
  })
})
