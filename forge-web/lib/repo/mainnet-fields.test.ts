/**
 * The mainnet fields (mixed-visibility phase M-B part 2), against both contract shapes: the
 * committed three-contract set (what sakura registered: none of the fields) and a fresh
 * `build.py --mainnet` build. On the first a writer writes exactly what it wrote before; on the
 * second it writes each field, and what it writes is judged by the mainnet contracts offline
 * (`lib/sdk/rc1-validate.ts` with `contractsDir`). Parity: forge-core `rules::aud` and the
 * `Collab` writers; the pure rules are pinned by the `aud__*` vectors (`lib/rules/conformance.test.ts`).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Audience, Role } from '../rules/v2'

/** The signer's role, as the membership read answers it. */
let role: Role | null = 'writer'
/** The stored issues and PRs a write reads, by `<type>/<id>`. */
const stored: Record<string, Record<string, unknown>> = {}
/** What the parent read answers on a contract without `tAud`. */
let parent: Audience = 'public'
/** Whether a maintainer's bundle made the target public. */
let bundled = false
const creates: { documentType: string; data: Record<string, unknown> }[] = []

vi.mock('../view/retry', () => ({ retryWhileMissing: vi.fn(async (f: () => Promise<unknown>) => f()) }))
vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), readRoleOracle: async () => ({ currentRole: () => role }) }))
vi.mock('./members-writes', async (orig) => ({
  ...(await orig<typeof import('./members-writes')>()),
  storedOnce: async (_s: unknown, _r: unknown, type: string, id: string) => stored[`${type}/${id}`] ?? null,
  storedTargetOnce: async (_s: unknown, _r: unknown, id: string) => stored[`issue/${id}`] ?? stored[`patch/${id}`] ?? null,
  targetAudience: async () => parent,
  knownAudience: () => undefined,
  madePublicByBundle: async () => bundled,
}))
vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  createDocumentIdempotent: vi.fn(async (_sdk: unknown, _a: unknown, p: { documentType: string; data: Record<string, unknown> }) => {
    creates.push({ documentType: p.documentType, data: p.data })
    return { documentId: '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
  }),
}))

import { base58Encode } from '../auth/base58'
import { makePublicChanges } from '../rules/make-public'
import { ConsensusRefusal, type WriteAuth } from '../sdk'
import { rc1Contracts, validateRc1, validateRc1Replace, type Rc1ContractName } from '../sdk/rc1-validate'
import { writeFailure } from '../view/write-errors'
import type { RepoRef } from './contract'
import { resetContractShapes } from './contract-shape'
import { manifestMaintKinds, restateContentFields, withContentFields, withoutUndeclaredVis } from './mainnet-fields'
import { makePublicKeepsFields } from './make-public-writes'
import { wellFormedAs } from './private-content'
import { PrivateWriteError } from './private-writes'
import { recordPolicyBypass } from './review-writes'
import { roleClaim } from './role-claim'
import { LetterRefusedError } from './letter-writes'
import { OWNER_ROW_STAYS, eventWrite, refuseOwnVerdict, refuseOwnerRow, requirePublicFor } from './writes'

const MAINNET = mkdtempSync(join(tmpdir(), 'forge-mainnet-'))
execFileSync('python3', [resolve(process.cwd(), '..', 'forge-contracts', 'schema', 'build.py'), '--mainnet', '--out', MAINNET])

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const ALICE = b58(id(0x41))
const BOB = b58(id(0x42))
const SAKURA_FORGE = { core: b58(id(0x01)), collab: b58(id(0x02)), community: b58(id(0x03)), group: b58(id(0x04)) }
const MAINNET_FORGE = { core: b58(id(0x05)), collab: b58(id(0x06)), community: b58(id(0x07)), group: b58(id(0x08)), meta: b58(id(0x09)) }
const META = JSON.parse(readFileSync(join(MAINNET, 'forge-meta.json'), 'utf8')) as { documentSchemas: unknown }

/** An SDK whose `contracts.fetch` answers `forge`'s contracts from `dir` (the committed set by default). */
function sdkOf(forge: typeof SAKURA_FORGE & { meta?: string }, dir?: string): EvoSDK {
  const name = (cid: string): Rc1ContractName => (cid === forge.core ? 'forge-core' : cid === forge.collab ? 'forge-collab' : 'forge-community')
  return {
    contracts: { fetch: async (cid: string) => ({ schemas: cid === forge.meta ? META.documentSchemas : rc1Contracts(dir)[name(cid)].documentSchemas }) },
  } as unknown as EvoSDK
}
const sakura = sdkOf(SAKURA_FORGE)
const mainnet = sdkOf(MAINNET_FORGE, MAINNET)
const repoOf = (forge: typeof SAKURA_FORGE, visibility: 'public' | 'private' = 'public'): RepoRef => ({ forge, repoId: b58(id(0x31)), ownerId: ALICE, name: 'mixed', visibility })
const SAKURA = repoOf(SAKURA_FORGE)
const MAIN = repoOf(MAINNET_FORGE)
const auth: WriteAuth = { identityId: BOB, network: 'devnet', getSigningKeyWif: () => 'x' }

const MEMBERS_ENC = Uint8Array.from([0x03, ...new Uint8Array(95).fill(7)])
const LETTER_ENC = Uint8Array.from([0x04, 1, ...new Uint8Array(158).fill(7)])
const TARGET = b58(id(0x51))

/** A members-only comment as its writer signs it (sealed, with its proof). */
const membersComment = (): Record<string, unknown> => ({ repoId: id(0x31), targetId: id(0x51), enc: MEMBERS_ENC, epoch: 0, vis: 'public', asMember: id(0x42) })

beforeEach(() => {
  role = 'writer'
  parent = 'public'
  bundled = false
  creates.length = 0
  for (const k of Object.keys(stored)) delete stored[k]
  resetContractShapes()
})

describe('aud and mRole on issues, PRs, comments and reviews (L1, L2)', () => {
  it('sakura: a create carries neither field', async () => {
    const doc = membersComment()
    expect(await withContentFields(sakura, auth, SAKURA, 'comment', doc)).toEqual(doc)
  })

  it("mainnet: aud from enc's class, mRole the signer's writer row role; the contract accepts it", async () => {
    role = 'triage'
    const doc = await withContentFields(mainnet, auth, MAIN, 'comment', membersComment())
    expect(doc).toMatchObject({ aud: 1, mRole: 2 })
    expect(await validateRc1('comment', doc, { contractsDir: MAINNET, owner: BOB })).toEqual({ ok: true })
    // aud 1 without the proof: the contract's own rule refuses it (judged before signing too, R-07)
    const { asMember: _a, mRole: _m, ...unproved } = doc
    const verdict = await validateRc1('comment', unproved, { contractsDir: MAINNET, owner: BOB })
    expect(verdict.ok ? [] : verdict.errors.join(' ')).toMatch(/audMember/)
  })

  it('mainnet: a letter is aud 2; a maintainer writes no mRole; public content no aud; a config framing is refused', async () => {
    expect(await withContentFields(mainnet, auth, MAIN, 'comment', { ...membersComment(), enc: LETTER_ENC })).toMatchObject({ aud: 2, mRole: 1 })
    role = 'maintainer'
    const maint = await withContentFields(mainnet, auth, MAIN, 'issue', { enc: MEMBERS_ENC, asMember: id(0x42) })
    expect(maint['aud']).toBe(1)
    expect('mRole' in maint).toBe(false)
    role = 'writer'
    // a member's public post on a locked thread: its proof restates the role, no aud
    const locked = await withContentFields(mainnet, auth, MAIN, 'comment', { body: 'hi', asMember: id(0x42) })
    expect('aud' in locked).toBe(false)
    expect(locked['mRole']).toBe(1)
    expect(await withContentFields(mainnet, auth, MAIN, 'comment', { body: 'hi' })).toEqual({ body: 'hi' })
    await expect(withContentFields(mainnet, auth, MAIN, 'comment', { enc: Uint8Array.from([0x02, 1, 2]), asMember: id(0x42) })).rejects.toThrow(/nothing was written/)
    // an event is no content type: unchanged
    expect(await withContentFields(mainnet, auth, MAIN, 'event', { value: 'bug' })).toEqual({ value: 'bug' })
  })

  it('sakura: a replace restates nothing and reads nothing', async () => {
    const read = vi.fn(async () => null)
    expect(await restateContentFields(sakura, auth, SAKURA, 'comment', { body: 'x' }, read)).toEqual({ body: 'x' })
    expect(read).not.toHaveBeenCalled()
  })

  it('mainnet: every replace restates them from the stored document with the changes applied', async () => {
    role = 'triage'
    const storedDoc = { ...membersComment(), aud: 1, mRole: 2 }
    // an author's make public drops enc, so aud; the proof stays, so the role is restated
    const made = await restateContentFields(mainnet, auth, MAIN, 'comment', { body: 'now public', enc: undefined, epoch: undefined }, async () => storedDoc)
    expect('aud' in made && made['aud'] === undefined).toBe(true)
    expect(made['mRole']).toBe(2)
    // a re-seal names enc and the proof itself: nothing is read
    const read = vi.fn(async () => storedDoc)
    expect(await restateContentFields(mainnet, auth, MAIN, 'comment', { enc: MEMBERS_ENC, epoch: 1, asMember: id(0x42) }, read)).toMatchObject({ aud: 1, mRole: 2 })
    expect(read).not.toHaveBeenCalled()
    // a former member drops the proof: and its role
    role = null
    const dropped = await restateContentFields(mainnet, auth, MAIN, 'comment', { body: 'x', asMember: undefined }, async () => storedDoc)
    expect(dropped).toMatchObject({ aud: 1 })
    expect('mRole' in dropped && dropped['mRole'] === undefined).toBe(true)
  })
})

describe('make public keeps the inline path and branch names where the contract lets it (L1)', () => {
  it('sakura loses the path; mainnet sets it in the replace that drops aud, which the contract accepts once', async () => {
    expect(await makePublicKeepsFields(sakura, SAKURA, 'comment')).toBe(false)
    expect(await makePublicKeepsFields(mainnet, MAIN, 'comment')).toBe(true)
    const plan = makePublicChanges('comment', { body: 'nit', path: 'src/lib.rs' }, true)
    expect(plan).toMatchObject({ set: { body: 'nit', path: 'src/lib.rs' }, lost: [] })
    role = 'writer'
    const before = { ...membersComment(), aud: 1, mRole: 1 }
    const changes = await restateContentFields(mainnet, auth, MAIN, 'comment', { body: 'nit', path: 'src/lib.rs', enc: undefined, epoch: undefined }, async () => before)
    const after: Record<string, unknown> = { ...before }
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) delete after[k]
      else after[k] = v
    }
    expect(await validateRc1Replace('comment', before, after, { contractsDir: MAINNET, owner: BOB })).toEqual({ ok: true })
    // once public, the path is fixed again
    const verdict = await validateRc1Replace('comment', after, { ...after, path: 'src/main.rs' }, { contractsDir: MAINNET, owner: BOB })
    expect(verdict.ok ? [] : verdict.errors.join(' ')).toMatch(/40128/)
  })

  it("a pull request's branch names stay unset on every contract (a members-only branch's name is keyed)", async () => {
    expect(await makePublicKeepsFields(mainnet, MAIN, 'patch')).toBe(false)
    expect(await makePublicKeepsFields(sakura, SAKURA, 'patch')).toBe(false)
  })
})

describe('tAud on events and author events (M3, M4)', () => {
  const label = { targetId: id(0x51), targetNumber: 1, kind: 4, value: 'bug' }
  const retarget = { targetId: id(0x51), targetNumber: 1, kind: 8, value: 'refs/heads/release' }

  it('sakura: the value follows the target as before, and no tAud is written', async () => {
    parent = 'members'
    expect(await eventWrite(sakura, SAKURA, 'event', label)).toEqual({ audience: 'members', tAud: null })
    await expect(eventWrite(sakura, SAKURA, 'authorEvent', retarget)).rejects.toBeInstanceOf(PrivateWriteError)
    parent = 'specificPeople'
    await expect(eventWrite(sakura, SAKURA, 'event', label)).rejects.toBeInstanceOf(LetterRefusedError)
    // a value-less event reads nothing
    parent = 'members'
    expect(await eventWrite(sakura, SAKURA, 'event', { targetId: id(0x51), targetNumber: 1, kind: 11 })).toEqual({ audience: 'public', tAud: null })
  })

  it("mainnet: tAud is the target's stored aud; a value is sealed on a members-only target, plaintext on a public one", async () => {
    stored[`issue/${TARGET}`] = { $id: TARGET, enc: MEMBERS_ENC, aud: 1, asMember: BOB }
    expect(await eventWrite(mainnet, MAIN, 'event', label)).toEqual({ audience: 'members', tAud: 1 })
    expect(await eventWrite(mainnet, MAIN, 'event', { targetId: id(0x51), targetNumber: 1, kind: 11 })).toEqual({ audience: 'public', tAud: 1 })
    // an author's retarget is sealed where authorEvent declares enc
    expect(await eventWrite(mainnet, MAIN, 'authorEvent', retarget)).toEqual({ audience: 'members', tAud: 1 })
    // a maintainer's bundle made it public: it keeps aud 1, so the value stays sealed
    bundled = true
    expect(await eventWrite(mainnet, MAIN, 'event', label)).toEqual({ audience: 'members', tAud: 1 })
    stored[`issue/${TARGET}`] = { $id: TARGET, title: 'public' }
    expect(await eventWrite(mainnet, MAIN, 'event', label)).toEqual({ audience: 'public', tAud: null })
  })

  it('mainnet: a value on a letter is refused before signing; a value-less event names its aud 2', async () => {
    stored[`patch/${TARGET}`] = { $id: TARGET, enc: LETTER_ENC, aud: 2 }
    await expect(eventWrite(mainnet, MAIN, 'event', label)).rejects.toBeInstanceOf(LetterRefusedError)
    expect(await eventWrite(mainnet, MAIN, 'event', { targetId: id(0x51), targetNumber: 1, kind: 11 })).toEqual({ audience: 'public', tAud: 2 })
  })

  it('mainnet: a target nobody can read is refused, never written public', async () => {
    await expect(eventWrite(mainnet, MAIN, 'event', label)).rejects.toThrow(/not found/)
  })
})

describe('kind 23: a maintainer’s bypass proves its maintainer (M2)', () => {
  const input = { target: { id: TARGET, number: 2 }, rules: ['approvals'], mergeOid: 'ab'.repeat(20) }

  it('mainnet: a maintainer’s carries asMaintainer, a writer’s none', async () => {
    stored[`patch/${TARGET}`] = { $id: TARGET, title: 'public PR' }
    role = 'maintainer'
    await recordPolicyBypass(mainnet, auth, MAIN, input)
    expect(creates[0]?.data['asMaintainer']).toEqual(id(0x42))
    expect('tAud' in (creates[0]?.data ?? {})).toBe(false)
    role = 'writer'
    await recordPolicyBypass(mainnet, auth, MAIN, input)
    expect('asMaintainer' in (creates[1]?.data ?? {})).toBe(false)
  })
})

describe('pack manifests of the maintainer-only kinds claim r = 0 (C3)', () => {
  it('only where packManifest.r admits 0', async () => {
    role = 'maintainer'
    expect(await manifestMaintKinds(sakura, SAKURA)).toBe(false)
    expect(await manifestMaintKinds(mainnet, MAIN)).toBe(true)
    for (const kind of [7, 8, 9, 11]) {
      expect(await roleClaim(sakura, auth, SAKURA, 'packManifest', { kind })).toEqual({ r: 1 })
      expect(await roleClaim(mainnet, auth, MAIN, 'packManifest', { kind })).toEqual({ r: 0 })
    }
    expect(await roleClaim(mainnet, auth, MAIN, 'packManifest', { kind: 1 })).toEqual({ r: 1 })
  })
})

describe('readers: an aud that disagrees with enc is malformed, never text', () => {
  const comment = (extra: Record<string, unknown>) => ({ $id: 'c', $ownerId: BOB, repoId: SAKURA.repoId, targetId: TARGET, ...extra })
  const enc = Buffer.from(MEMBERS_ENC).toString('base64')
  const letter = Buffer.from(LETTER_ENC).toString('base64')

  it('agrees: shown (or opened) as before', () => {
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc, epoch: 0 }))).toBe(true)
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc, epoch: 0, aud: 1 }))).toBe(true)
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc: letter, epoch: 0, aud: 2 }))).toBe(true)
    expect(wellFormedAs(SAKURA, 'comment', comment({ body: 'public' }))).toBe(true)
  })

  it('disagrees: refused by every gate', () => {
    expect(wellFormedAs(SAKURA, 'comment', comment({ body: 'public', aud: 1 }))).toBe(false)
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc, epoch: 0, aud: 2 }))).toBe(false)
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc: letter, epoch: 0, aud: 1 }))).toBe(false)
    expect(wellFormedAs(SAKURA, 'comment', comment({ enc, epoch: 0, aud: 3 }))).toBe(false)
  })
})

describe('the M-A2 client items', () => {
  it('R-11: webhook and topic writes drop vis where the contract no longer declares it', async () => {
    const data = { repoId: id(0x31), url: 'https://x.example', vis: 'public' }
    expect(await withoutUndeclaredVis(sakura, SAKURA_FORGE.community, 'webhook', data)).toEqual(data)
    expect(await withoutUndeclaredVis(mainnet, MAINNET_FORGE.community, 'webhook', data)).toEqual({ repoId: id(0x31), url: 'https://x.example' })
    expect(await withoutUndeclaredVis(mainnet, MAINNET_FORGE.meta, 'topic', { name: 'rust', vis: 'public' })).toEqual({ name: 'rust' })
  })

  it("R-03: a PR's author gets no verdict on it, refused before signing", async () => {
    stored[`patch/${TARGET}`] = { $id: TARGET, $ownerId: BOB }
    await expect(refuseOwnVerdict(mainnet, MAIN, BOB, TARGET, 'approve')).rejects.toThrow("You can't approve or request changes on your own pull request.")
    await expect(refuseOwnVerdict(mainnet, MAIN, BOB, TARGET, 'requestChanges')).rejects.toThrow(/your own pull request/)
    await expect(refuseOwnVerdict(mainnet, MAIN, BOB, TARGET, 'comment')).resolves.toBeUndefined()
    await expect(refuseOwnVerdict(mainnet, MAIN, ALICE, TARGET, 'approve')).resolves.toBeUndefined()
  })

  it("R-08: the owner's own maintainer row is never removed; others' are", () => {
    expect(() => refuseOwnerRow(MAIN, ALICE, 'maintainer')).toThrow(OWNER_ROW_STAYS)
    expect(() => refuseOwnerRow(MAIN, BOB, 'maintainer')).not.toThrow()
    expect(() => refuseOwnerRow(MAIN, ALICE, 'writer')).not.toThrow()
  })

  it('R-12: a private repo is neither starred nor watched', () => {
    expect(() => requirePublicFor({ ...MAIN, visibility: 'private' }, 'starred')).toThrow("Private repositories can't be starred.")
    expect(() => requirePublicFor({ ...MAIN, visibility: 'private' }, 'watched')).toThrow("Private repositories can't be watched.")
    expect(() => requirePublicFor(MAIN, 'starred')).not.toThrow()
  })

  it('a mainnet rule refusal (10422) and a delete rule refusal (40147) read in plain words', () => {
    const rule = (code: number, name: string) => new ConsensusRefusal(code, `Document 9x of type "review" breaks its propertyConstraints rule "${name}": it does not hold`, {}, false)
    expect(writeFailure(rule(10422, 'authorNoVerdict')).message).toBe("You can't approve or request changes on your own pull request. Post it as a comment instead. You weren't charged.")
    const del = new ConsensusRefusal(40147, 'Document 9x of type "maintainer" can not be deleted: it breaks its deleteConstraints rule \\"ownerRowStays\\": it does not hold', {}, false)
    expect(writeFailure(del).message).toBe("The owner's own Maintain access can't be removed. You weren't charged.")
    expect(writeFailure(rule(10422, 'somethingElse')).message).toMatch(/Error code 10422/)
    expect(writeFailure(new ConsensusRefusal(40147, 'no rule here', {}, false)).message).toMatch(/Error code 40147/)
  })

  it('the offline judge reads the protocol-14 shorthands the mainnet build writes (R-02)', async () => {
    const run = (extra: Record<string, unknown>) => validateRc1('comment', { ...membersComment(), aud: 1, mRole: 1, ...extra }, { contractsDir: MAINNET, owner: BOB })
    expect(await run({})).toEqual({ ok: true })
    const short = await run({ targetId: new Uint8Array(31) })
    expect(short.ok ? [] : short.errors.join(' ')).toMatch(/type at \/targetId: expected an identifier/)
    const hash = { repoId: id(0x31), number: 2, title: 'pr', baseRefName: 'refs/heads/main', sourceRepoId: id(0x31), headOid: new Uint8Array(20), vis: 'public' }
    const sized = await validateRc1('patch', { ...hash, patchManifestHash: new Uint8Array(31) }, { contractsDir: MAINNET, owner: BOB })
    expect(sized.ok ? [] : sized.errors.join(' ')).toMatch(/size at \/patchManifestHash/)
  })

  it('every mainnet rule a client meets first has words (propertyConstraints and deleteConstraints)', async () => {
    const { MAINNET_RULE_SENTENCES } = await import('../view/write-errors')
    const names = new Set<string>()
    for (const c of ['forge-core', 'forge-collab', 'forge-community', 'forge-meta']) {
      const json = JSON.parse(readFileSync(join(MAINNET, `${c}.json`), 'utf8')) as { documentSchemas: Record<string, { propertyConstraints?: object; deleteConstraints?: object }> }
      for (const s of Object.values(json.documentSchemas)) for (const k of [...Object.keys(s.propertyConstraints ?? {}), ...Object.keys(s.deleteConstraints ?? {})]) names.add(k)
    }
    for (const rule of Object.keys(MAINNET_RULE_SENTENCES)) expect(names.has(rule), `no mainnet rule ${rule}`).toBe(true)
  })
})
