/**
 * Bot access's service (`./bot-access`; forge-core `collab::v2::bots`) over a mocked SDK: every
 * refusal is thrown before anything is written, a request is written before its `read` letter,
 * which names the request as its job and carries the request's own key, notices are written by
 * maintainers only (two copies in a private repo), and a notice counts only from a maintainer.
 */

import * as secp from '@noble/secp256k1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { bytesToHex, decodeKeyLetter, encodeNotice, readLetterFromTyped, type AccessNotice } from '../private'
import type { PlainDocument, WriteAuth } from '../sdk'
import type { RepoRef } from './contract'
import { encodeHeader } from '../private/pack'
import type { PackManifest } from './packs'

const m = vi.hoisted(() => ({
  queryDocuments: vi.fn(),
  queryAllDocuments: vi.fn(),
  readManifestsOfKind: vi.fn(),
  readMaintainers: vi.fn(),
  readViewerPermissions: vi.fn(),
  putPlatformChunks: vi.fn(),
  writePackManifest: vi.fn(),
  writeRepoDoc: vi.fn(),
  privateWriter: vi.fn(),
  loadStoredArtifactBytes: vi.fn(),
  fetchIdentityKeys: vi.fn(),
  encryptionKeyState: vi.fn(),
  openContent: vi.fn(),
  readObjKey: vi.fn(),
  sealLetterArtifact: vi.fn(),
  sealPack: vi.fn(),
  contractHasProperty: vi.fn(),
  /** Copies of what each letter sealed (the service wipes its own plaintext). */
  sealed: [] as Uint8Array[],
}))

vi.mock('../sdk', async (orig) => ({ ...(await orig<typeof import('../sdk')>()), queryDocuments: m.queryDocuments, queryAllDocuments: m.queryAllDocuments }))
vi.mock('./packs', () => ({ readManifestsOfKind: m.readManifestsOfKind }))
vi.mock('./contract-shape', () => ({ contractHasProperty: m.contractHasProperty }))
vi.mock('./members', () => ({ readMaintainers: m.readMaintainers, readViewerPermissions: m.readViewerPermissions }))
vi.mock('./push', () => ({ putPlatformChunks: m.putPlatformChunks, writePackManifest: m.writePackManifest }))
vi.mock('./writes', () => ({ writeRepoDoc: m.writeRepoDoc }))
vi.mock('./private-writes', () => ({ privateWriter: m.privateWriter }))
vi.mock('../view/browse-source', () => ({ loadStoredArtifactBytes: m.loadStoredArtifactBytes }))
vi.mock('../auth/encryption-key', async (orig) => ({
  ...(await orig<typeof import('../auth/encryption-key')>()),
  fetchIdentityKeys: m.fetchIdentityKeys,
  encryptionKeyState: m.encryptionKeyState,
  usableEncryptionKey: (keys: readonly unknown[]) => keys[0] ?? null,
  isUsableEncryptionKey: () => true,
}))
vi.mock('../auth/vault', async (orig) => ({
  ...(await orig<typeof import('../auth/vault')>()),
  storedEncryptionKeyIds: async () => [1],
  withEncryptionKeys: async (_n: unknown, _id: unknown, use: (keys: { keyId: number; secret: Uint8Array }[]) => Promise<unknown>) => use([{ keyId: 1, secret: SECRET }]),
}))
vi.mock('../private', async (orig) => ({
  ...(await orig<typeof import('../private')>()),
  openContent: m.openContent,
  readObjKey: m.readObjKey,
  sealLetterArtifact: m.sealLetterArtifact,
  sealPack: m.sealPack,
  openPack: async (sealed: Uint8Array) => sealed.slice(9),
}))
vi.mock('./private-content', async (orig) => {
  const real = await orig<typeof import('./private-content')>()
  return {
    ...real,
    // the header the read path builds, reduced to what these tests read
    storedPrivateDoc: (type: string, doc: PlainDocument) => {
      const enc = real.bytesField(doc, 'enc')
      return enc === undefined ? null : { type, vis: 'public', ownerId: new Uint8Array(32), epoch: 0, id: decodeIdentifier(String(doc['$id'])), enc }
    },
  }
})

const SECRET = new Uint8Array(32).fill(1)
const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const REPO = id(10)
const OWNER = id(11)
const MAINT = id(12)
const WRITER = id(13)
const BOT = id(14)
const PR = id(15)
const EVENT = id(16)
const STRANGER = id(17)
const ME_KEY = { keyId: 1, data: bytesToHex(secp.getPublicKey(SECRET, true)) }
const BOT_KEY = { keyId: 1, data: bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(2), true)) }

const { AskRefusedError, planAsk, readAccessNotices, withPostAccess, writeAccessNotice, writeAsk } = await import('./bot-access')

const session = {
  id: 's1',
  ctx: {},
  resolution: { keys: new Map([[0, { rawPackKey: async () => new Uint8Array(32).fill(5) }]]) },
}
const publicRepo = { forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY' }, repoId: REPO, ownerId: OWNER, name: 'r', visibility: 'public', lane: session } as unknown as RepoRef
const privateRepo = { ...publicRepo, visibility: 'private', session } as unknown as RepoRef
const auth = { identityId: WRITER, network: 'testnet', getSigningKeyWif: () => '' } as unknown as WriteAuth
const sdk = {} as never

const notice = (over: Partial<AccessNotice> = {}): AccessNotice => ({
  bot: decodeIdentifier(BOT),
  may: ['post', 'readOnRequest'],
  askers: 'writers',
  threads: 'all',
  processor: 'Example AI',
  until: null,
  revokes: [],
  note: '',
  extra: {},
  ...over,
})
const manifest = (documentId: string, uploader: string, createdAt: number): PackManifest =>
  ({ packHash: 'ab'.repeat(32), kind: 11, sizeBytes: 512, objectCount: 0, chunkCount: 1, storage: 0, uris: [], tips: [], supersedes: [], createdAt, documentId, uploader }) as PackManifest

const MEMBERS_ENC = new Uint8Array([3, ...new Uint8Array(60)])
const LETTER_ENC = new Uint8Array([4, 1, ...new Uint8Array(60)])

interface World {
  notices: { readonly id: string; readonly writer: string; readonly notice: AccessNotice }[]
  root: PlainDocument
  comments: PlainDocument[]
  roles: Record<string, 'maintainer' | 'writer' | 'triage'>
  unreadable: Set<string>
  botKey: boolean
  /** Opened bodies by post id (default "text"). */
  bodies: Record<string, string>
  /** The members-only long bodies stored (kind 70), by their packHash. */
  longs: string[]
}
let world: World

function setWorld(over: Partial<World> = {}): void {
  world = {
    notices: [{ id: 'N1', writer: MAINT, notice: notice() }],
    root: { $id: PR, $ownerId: WRITER, repoId: REPO, sourceRepoId: REPO, enc: MEMBERS_ENC },
    comments: [{ $id: id(20), $ownerId: WRITER, repoId: REPO, targetId: PR, enc: MEMBERS_ENC }],
    roles: { [MAINT]: 'maintainer', [WRITER]: 'writer' },
    unreadable: new Set(),
    botKey: true,
    bodies: {},
    longs: [],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setWorld()
  // sakura's contracts: no members-only envelope of a private repository's own (D38)
  m.contractHasProperty.mockResolvedValue(false)
  m.readManifestsOfKind.mockImplementation(async (_s: unknown, _r: unknown, kind: number) =>
    kind === 11 ? world.notices.map((n, i) => manifest(n.id, n.writer, 100 + i)) : kind === 70 ? world.longs.map((h, i) => ({ ...manifest(`L${i}`, WRITER, 1), kind: 70, packHash: h })) : [],
  )
  m.loadStoredArtifactBytes.mockImplementation(async (_s: unknown, r: RepoRef, man: PackManifest) => {
    if (man.kind === 70) return encodeHeader(0, 10, new Uint8Array(16).fill(3))
    const plain = encodeNotice((world.notices.find((n) => n.id === man.documentId) as World['notices'][number]).notice)
    // a private repo stores the members' copy under the members key (`sealPack` below)
    return r.visibility === 'private' ? new Uint8Array([0x44, 0x46, 0x50, 0x4b, 1, 0, 0, 0, 0, ...plain]) : plain
  })
  m.readMaintainers.mockImplementation(async () => Object.entries(world.roles).filter(([, r]) => r === 'maintainer').map(([k]) => k))
  m.readViewerPermissions.mockImplementation(async (_s: unknown, _r: unknown, who: string) => {
    const role = world.roles[who]
    return role === undefined ? null : { member: true, maintain: role === 'maintainer', role }
  })
  m.queryDocuments.mockImplementation(async (_s: unknown, q: { documentTypeName: string }) =>
    q.documentTypeName === 'event' ? [{ $id: EVENT, $ownerId: WRITER, repoId: REPO, targetId: PR, enc: MEMBERS_ENC }] : [world.root],
  )
  m.queryAllDocuments.mockImplementation(async (_s: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'comment' ? world.comments : []))
  m.openContent.mockImplementation(async (doc: { id: Uint8Array }) =>
    world.unreadable.has(base58Encode(doc.id)) ? { status: 'unreadable', reason: 'noKey' } : { status: 'readable', fields: { body: world.bodies[base58Encode(doc.id)] ?? 'text' } },
  )
  m.readObjKey.mockImplementation(async (_k: unknown, doc: { id: Uint8Array }) => new Uint8Array(32).fill(doc.id[0] as number))
  m.fetchIdentityKeys.mockImplementation(async (_s: unknown, who: string) => (who === BOT ? (world.botKey ? [BOT_KEY] : []) : [ME_KEY]))
  m.encryptionKeyState.mockImplementation(async () => 'open')
  m.writeRepoDoc.mockImplementation(async () => ({ documentId: EVENT, confirmed: true }))
  m.putPlatformChunks.mockImplementation(async () => ({ locator: 'loc', chunkCount: 1 }))
  m.writePackManifest.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { kind: number }) => ({ documentId: `M${input.kind}-${m.writePackManifest.mock.calls.length}` }))
  m.sealed.length = 0
  m.sealLetterArtifact.mockImplementation(async (...args: unknown[]) => {
    const plain = new Uint8Array(args[5] as Uint8Array)
    m.sealed.push(plain)
    return new Uint8Array(plain)
  })
  m.sealPack.mockImplementation(async (_k: unknown, plain: Uint8Array) => new Uint8Array([0x44, 0x46, 0x50, 0x4b, 1, 0, 0, 0, 0, ...plain]))
  m.privateWriter.mockImplementation(async () => ({ keys: {} }))
})

const about = { target: { kind: 'pr' as const, id: PR, number: 42 }, bot: BOT, name: '@ci-bot', display: 'o/r' }
const ask = { ...about, task: 'fix the failing test' }

/** `run` is refused with `message`, and nothing is written. */
async function refused(run: () => Promise<unknown>, message: RegExp | string): Promise<void> {
  await expect(run()).rejects.toThrow(message)
  expect(m.writeRepoDoc).not.toHaveBeenCalled()
  expect(m.putPlatformChunks).not.toHaveBeenCalled()
  expect(m.writePackManifest).not.toHaveBeenCalled()
}

describe('asking a bot: refusals before anything is written', () => {
  it('is E813 when the bot has no access', async () => {
    setWorld({ notices: [] })
    await expect(planAsk(sdk, auth, publicRepo, about)).rejects.toBeInstanceOf(AskRefusedError)
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), '@ci-bot has no access in o/r')
  })

  it('refuses a thread the asker cannot read first, then a message to specific people, then the access', async () => {
    setWorld({ notices: [], unreadable: new Set([PR]) })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), "You can't read #42, so you can't ask @ci-bot to work on it.")
    setWorld({ notices: [], root: { $id: PR, $ownerId: WRITER, repoId: REPO, sourceRepoId: REPO, enc: LETTER_ENC } })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), "#42 is a message to specific people: @ci-bot can't be asked about it.")
  })

  it("refuses to hand a private repository's posts to a bot that reads on request", async () => {
    await refused(() => writeAsk(sdk, auth, privateRepo, ask), "@ci-bot can't be given this private repository's posts yet: older items in this repo can't be shared one at a time")
  })

  it("asks about a private repository's thread on the mainnet contract, whose posts have keys of their own", async () => {
    m.contractHasProperty.mockResolvedValue(true)
    await expect(writeAsk(sdk, auth, privateRepo, ask)).resolves.toBeDefined()
    expect(m.writeRepoDoc).toHaveBeenCalled()
  })

  it("refuses a fork's members-only pull request", async () => {
    setWorld({ root: { $id: PR, $ownerId: WRITER, repoId: REPO, sourceRepoId: id(30), enc: MEMBERS_ENC } })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), "#42 comes from a fork or from someone outside the members: its members-only content can't be shared with @ci-bot")
  })

  it("refuses an outsider's members-only pull request", async () => {
    setWorld({ root: { $id: PR, $ownerId: STRANGER, repoId: REPO, sourceRepoId: REPO, enc: MEMBERS_ENC } })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), '#42 comes from a fork or from someone outside the members')
  })

  it('refuses a thread too large to share at once', async () => {
    const many = Array.from({ length: 600 }, (_, i) => {
      const b = new Uint8Array(32)
      b[0] = 0x80 | (i >> 8)
      b[1] = i & 0xff
      return { $id: base58Encode(b), $ownerId: WRITER, repoId: REPO, targetId: PR, enc: MEMBERS_ENC }
    })
    setWorld({ comments: many })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), '#42 is too large to share with a bot at once (601 posts)')
  })

  it('refuses when the bot has no encryption key, or the tab is locked', async () => {
    setWorld({ botKey: false })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), '@ci-bot has no encryption key')
    setWorld()
    m.encryptionKeyState.mockImplementation(async () => 'locked')
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), 'Unlock this tab')
  })

  it('refuses a triage member with E813', async () => {
    setWorld({ roles: { [MAINT]: 'maintainer', [WRITER]: 'triage' } })
    await refused(() => writeAsk(sdk, auth, publicRepo, ask), "@ci-bot can't be asked by people with Triage access in o/r")
  })
})

describe('asking a bot: what is written', () => {
  it('writes the request first, then a letter naming it that carries its own key', async () => {
    const asked = await writeAsk(sdk, auth, publicRepo, ask)
    expect(asked.event).toBe(EVENT)
    expect(asked.letter).not.toBeNull()
    expect(m.writeRepoDoc).toHaveBeenCalledTimes(1)
    const event = m.writeRepoDoc.mock.calls[0] as unknown[]
    expect(event[3]).toBe('event')
    expect(event[4]).toMatchObject({ kind: 27, targetNumber: 42, value: 'fix the failing test' })
    expect(m.writeRepoDoc.mock.invocationCallOrder[0]).toBeLessThan(m.putPlatformChunks.mock.invocationCallOrder[0] as number)
    expect((m.writePackManifest.mock.calls[0] as unknown[])[3]).toMatchObject({ kind: 10 })
    // sealed to the asker (slot 0) and the bot
    const sealCall = m.sealLetterArtifact.mock.calls[0] as unknown[]
    expect((sealCall[4] as { identityId: Uint8Array }[]).map((r) => base58Encode(r.identityId))).toEqual([WRITER, BOT])
    const typed = decodeKeyLetter(m.sealed[0] as Uint8Array)
    if (typed === null) throw new Error('a well-formed letter')
    const letter = await readLetterFromTyped(typed)
    if (letter === null) throw new Error('a read letter')
    expect(base58Encode(letter.job)).toBe(EVENT)
    expect(letter.target).toEqual({ pr: 42 })
    expect(letter.docs.map((d) => base58Encode(d.id)).sort()).toEqual([PR, id(20), EVENT].sort())
  })

  it("hands on the file key of a long post's full text, and counts the ones it can't", async () => {
    const stored = 'a'.repeat(64)
    const missing = 'b'.repeat(64)
    const trailer = (h: string): string => `the start\n<!-- forge:body sha256=${h} bytes=9000 -->`
    setWorld({ bodies: { [PR]: trailer(stored), [id(20)]: trailer(missing) }, longs: [stored] })
    expect(await planAsk(sdk, auth, publicRepo, about)).toMatchObject({ shortened: 1 })
    await writeAsk(sdk, auth, publicRepo, ask)
    const typed = decodeKeyLetter(m.sealed[0] as Uint8Array)
    const letter = typed === null ? null : await readLetterFromTyped(typed)
    expect(letter?.packs.map((pk) => [bytesToHex(pk.packHash), pk.key.every((b) => b === 5)])).toEqual([[stored, true]])
  })

  it("gives a fork's public pull request no letter", async () => {
    setWorld({ root: { $id: PR, $ownerId: WRITER, repoId: REPO, sourceRepoId: id(30) }, comments: [] })
    const p = await planAsk(sdk, auth, publicRepo, about)
    expect(p).toMatchObject({ foreign: true, letter: false })
    const asked = await writeAsk(sdk, auth, publicRepo, ask)
    expect(asked.letter).toBeNull()
    expect(m.writeRepoDoc).toHaveBeenCalledTimes(1)
    expect(m.putPlatformChunks).not.toHaveBeenCalled()
  })

  it('plans a letter on a members-only thread even when none of its posts can be shared', async () => {
    setWorld({ comments: [{ $id: id(21), $ownerId: WRITER, repoId: REPO, targetId: PR, enc: LETTER_ENC }] })
    m.readObjKey.mockImplementation(async () => null)
    const p = await planAsk(sdk, auth, publicRepo, about)
    expect(p).toMatchObject({ letter: true, shared: { thread: 0, comments: 0 }, leftOut: ['unreadable', 'letter'] })
  })
})

describe('writing a notice', () => {
  const opts = { name: '@ci-bot', display: 'o/r' }
  const asMaint = { ...auth, identityId: MAINT }

  it('refuses anyone but a maintainer or the owner, and access for the owner or a human member', async () => {
    await refused(() => writeAccessNotice(sdk, auth, publicRepo, notice(), opts), 'Only maintainers can change what a bot may do')
    await refused(() => writeAccessNotice(sdk, asMaint, publicRepo, notice({ bot: decodeIdentifier(OWNER) }), opts), 'owns o/r: access is for bots')
    await refused(() => writeAccessNotice(sdk, asMaint, publicRepo, notice({ bot: decodeIdentifier(WRITER) }), opts), 'is a member of o/r with Write access: access is for bots')
  })

  it('writes one plaintext copy in a public repo and two in a private one', async () => {
    const one = await writeAccessNotice(sdk, asMaint, publicRepo, notice(), opts)
    expect(one.ids).toHaveLength(1)
    vi.clearAllMocks()
    m.putPlatformChunks.mockImplementation(async () => ({ locator: 'loc', chunkCount: 1 }))
    m.writePackManifest.mockImplementation(async () => ({ documentId: 'M' }))
    const two = await writeAccessNotice(sdk, asMaint, privateRepo, notice(), opts)
    expect(two.ids).toHaveLength(2)
    expect(m.writePackManifest).toHaveBeenCalledTimes(2)
    expect(m.sealPack).toHaveBeenCalledTimes(1)
    expect(m.sealLetterArtifact).toHaveBeenCalledTimes(1)
  })

  it("takes a keyless bot's access away in a private repo with the members' copy only", async () => {
    setWorld({ botKey: false })
    const got = await writeAccessNotice(sdk, asMaint, privateRepo, notice({ may: [] }), opts)
    expect(got.ids).toHaveLength(1)
    expect(m.sealLetterArtifact).not.toHaveBeenCalled()
  })
})

describe('reading notices', () => {
  it("ignores a notice from someone who isn't a maintainer", async () => {
    setWorld({
      notices: [
        { id: 'N1', writer: MAINT, notice: notice({ may: ['post'] }) },
        { id: 'N2', writer: STRANGER, notice: notice({ may: ['post', 'readOnRequest'] }) },
      ],
    })
    const read = await readAccessNotices(sdk, publicRepo)
    expect(read.all).toHaveLength(2)
    expect(read.current.get(BOT)?.id).toBe('N1')
  })
})

describe("bots' post keys follow their access", () => {
  it('sends one only to a bot whose live notice allows members-only replies', async () => {
    expect(await withPostAccess(sdk, publicRepo, [BOT])).toEqual([])
    setWorld({ notices: [{ id: 'N1', writer: MAINT, notice: notice({ may: ['post', 'postMembersOnly'] }) }] })
    expect(await withPostAccess(sdk, publicRepo, [BOT])).toEqual([BOT])
    setWorld({ notices: [{ id: 'N1', writer: MAINT, notice: notice({ may: ['post', 'postMembersOnly'], until: 1 }) }] })
    expect(await withPostAccess(sdk, publicRepo, [BOT])).toEqual([])
    setWorld({ notices: [{ id: 'N1', writer: WRITER, notice: notice({ may: ['post', 'postMembersOnly'] }) }] })
    expect(await withPostAccess(sdk, publicRepo, [BOT])).toEqual([])
  })
})
