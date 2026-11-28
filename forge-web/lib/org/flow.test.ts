import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import { publicKeyHash } from '../auth/identity-lookup'
import { DEPLOYMENTS, forgeV2Ids, type ForgeIds } from '../deployments'
import { membershipData } from '../repo/writes'
import type { RepoRef } from '../repo/contract'
import { verify } from './bls'
import { approveEnvelope, connect, createRequest, myShare, declineRequest, finishRequest, freeNonces, loadOrg, resetOrgCaches, signRequest, verifyInvite, type ConnectCandidate } from './service'
import { fakeOrgPort, type FakeOrgPort } from './fake-port'
import { encodeMessage } from './platform'
import { rosterFields, rosterFromIdentity } from './roster'
import { publishRequest } from './actions'
import { declaredOrgLink } from './gate'
import type { WriteSpec } from './transition'
import { envelopeId, sealEnvelope, type Envelope } from './envelope'
import type { WriteAuth } from '../sdk/write'
import type { OrgRecord } from './store'
import { participantKeys, seedFromMnemonic } from './derive'
import { hex } from './util'

const V = JSON.parse(readFileSync(resolve(__dirname, '../../../forge-contracts/fixtures/org/dti-2of3.json'), 'utf8')) as {
  room: string
  members: { mnemonic: string; passphrase: string; authPub: string }[]
  keys: Record<string, { groupPublicKey: string }>
  ceremonyMessages: Envelope[]
}

const forge = forgeV2Ids(DEPLOYMENTS['testnet']) as ForgeIds
const ORG = base58Encode(new Uint8Array(32).fill(3))
const ALICE = base58Encode(new Uint8Array(32).fill(5))
const REPO: RepoRef = { forge, repoId: base58Encode(new Uint8Array(32).fill(9)), ownerId: ORG, name: 'widgets', visibility: 'public' }
const GROUP_KEY = V.keys['high']!.groupPublicKey
const RELAY = 'https://multisig.dashhq.org'

const room: { envelope: unknown }[] = []
const broadcasts: { signable: string; signature: string }[] = []
const stored = new Map<string, { revision: bigint; data: Record<string, unknown> }>()
let nonce = 0n
let latest = 0

const orgIdentity = { id: { toBase58: () => ORG }, publicKeys: [{ keyId: 2, keyTypeNumber: 1, purposeNumber: 0, securityLevelNumber: 2, data: GROUP_KEY }] }
let relayUp = true
let nonceDown = false

const sdk = {
  version: () => latest,
  identities: {
    fetch: async (id: string) => (id === ORG ? orgIdentity : undefined),
    byPublicKeyHash: async (hash: string) => (hash === publicKeyHash(GROUP_KEY) ? orgIdentity : undefined),
    contractNonce: async () => {
      if (nonceDown) throw new Error('DAPI unavailable')
      return nonce
    },
  },
  documents: {
    get: async (_c: string, _t: string, id: string) => {
      const doc = stored.get(id)
      return doc ? { revision: doc.revision, toObject: () => doc.data } : undefined
    },
    query: async () => new Map(),
  },
  stateTransitions: {
    broadcastStateTransition: async (st: { getSignableBytes(): Uint8Array; signature?: Uint8Array; toBytes(): Uint8Array }) => {
      const m = await import('@dashevo/evo-sdk')
      const signable = hex(st.getSignableBytes())
      const signature = hex(st.signature as Uint8Array)
      if (!verify(signature, st.getSignableBytes(), GROUP_KEY)) throw new Error('bad signature')
      broadcasts.push({ signable, signature })
      const batch = m.BatchTransition.fromStateTransition(m.StateTransition.fromBytes(st.toBytes())).toObject() as unknown as { transitions: Record<string, unknown>[] }
      const t = batch.transitions[0]!
      nonce = BigInt(t['$identityContractNonce'] as bigint)
      stored.set(base58Encode(t['$id'] as Uint8Array), { revision: 1n, data: t })
    },
    waitForResponse: async () => undefined,
    waitForAffectedState: async () => undefined,
  },
} as unknown as EvoSDK

const people = V.members.map((m, i) => {
  const seed = seedFromMnemonic(m.mnemonic, m.passphrase)
  const identityId = base58Encode(new Uint8Array(32).fill(40 + i))
  const auth: WriteAuth = { identityId, network: 'testnet', getSigningKeyWif: () => 'unused' }
  return { seed, keys: participantKeys(seed), auth }
})

let port: FakeOrgPort
const opts = (who: number) => ({ network: 'testnet' as const, forge, port, auth: people[who]!.auth })
const readOpts = () => ({ network: 'testnet' as const, forge, port })
const writer = (fill: number, role = 1) => ({ action: 'create' as const, contractId: forge.core, documentType: 'writer', data: membershipData(REPO, base58Encode(new Uint8Array(32).fill(fill)), { role }) })

beforeAll(async () => {
  const evo = await import('@dashevo/evo-sdk')
  latest = await evo.EvoSDK.getLatestVersionNumber()
  for (const e of V.ceremonyMessages) room.push({ envelope: e })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!relayUp) throw new Error('relay unreachable')
    const u = new URL(url)
    expect(u.origin).toBe(RELAY)
    expect(u.pathname).toBe(`/v1/rooms/${V.room}/messages`)
    expect(init?.method ?? 'GET').toBe('GET')
    const after = Number(u.searchParams.get('after') ?? 0)
    return new Response(JSON.stringify({ messages: room.slice(after), next: room.length, more: false }), { status: 200 })
  })
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  port = fakeOrgPort()
  relayUp = true
  resetOrgCaches()
})

async function connected(who: number, candidate?: ConnectCandidate): Promise<OrgRecord> {
  return connect(sdk, candidate ?? (await verifyInvite(sdk, V.room, 'testnet')), 'testnet', people[who]!, people[who]!.auth, { forge, port })
}

describe('organization requests on Platform', () => {
  it('connects, creates at 1 of 2, a co-signer completes and broadcasts, then it reads done', async () => {
    const candidate = await verifyInvite(sdk, `${RELAY}/?network=testnet#room=${V.room}&name=Acme`, 'testnet')
    expect(candidate.identity.orgId).toBe(ORG)
    expect(candidate.identity.keyId).toBe(2)
    expect(candidate.threshold).toBe(2)
    expect(candidate.members.map((m) => m.authPub)).toEqual(V.members.map((m) => m.authPub))

    const r1 = await connected(0, candidate)
    expect(r1.label).toBe('Acme')
    expect(port.members).toHaveLength(1)
    expect(port.shares).toHaveLength(1)
    expect(port.shares[0]!.sealed.length).toBe(72)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'Give alice Write access', specs: [{ action: 'create', contractId: forge.core, documentType: 'writer', data: membershipData(REPO, ALICE, { role: 1 }) }] }, opts(0))
    expect(id).toBe(`${id.slice(0, 16)}-${people[0]!.keys.authPub.slice(0, 16)}`)
    expect(port.writes.every((w) => w.ownerId === people[0]!.auth.identityId)).toBe(true)
    const v1 = await loadOrg(sdk, r1, readOpts())
    const req1 = v1.requests.find((r) => r.request.id === id)!
    expect(req1.status).toBe('collecting')
    expect(req1.card).toEqual({ kind: 'signed', missing: 1 })
    expect(req1.collected).toBe(1)
    expect(req1.proposals[0]!.sentence).toMatch(/^Give .+ Write access to a repository$/)
    expect(req1.proposals[0]!.problems).toEqual([])

    const r3 = await connected(2)
    const v3 = await loadOrg(sdk, r3, readOpts())
    const req3 = v3.requests.find((r) => r.request.id === id)!
    expect(req3.card).toEqual({ kind: 'sign', collected: 1, needed: 2 })
    const after = await signRequest(sdk, v3, req3, people[2]!, opts(2))
    expect(after?.status).toBe('done')
    expect(after?.card).toEqual({ kind: 'done' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]!.signable).toBe(req1.request.proposals[0]!.body.signable)
    expect(nonce).toBe(1n)
  })

  it('a member signs on a fresh device from the published roster and their sealed share alone', async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'x', specs: [writer(21)] }, opts(0))
    const roster = rosterFromIdentity((await verifyInvite(sdk, V.room, 'testnet')).identity, RELAY)
    port.orgDocs.set(ORG, { id: 'orgdoc', revision: 1n, fields: rosterFields(roster) })
    resetOrgCaches()
    relayUp = false
    const v2 = await loadOrg(sdk, r2, readOpts())
    expect(v2.roster.source).toBe('org')
    const req = v2.requests.find((r) => r.request.id === id)!
    expect(req.card).toEqual({ kind: 'sign', collected: 1, needed: 2 })
    const done = await signRequest(sdk, v2, req, people[1]!, opts(1))
    expect(done?.status).toBe('done')
  })

  it('reads only member identities whose proof verifies, so a stranger cannot add to the log', async () => {
    const r1 = await connected(0)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'x', specs: [writer(22)] }, opts(0))
    const stranger = { identityId: base58Encode(new Uint8Array(32).fill(90)), network: 'testnet' as const, getSigningKeyWif: () => '' }
    const fake = port.members[0]!
    port.members.push({ ...fake, id: 'forged', ownerId: stranger.identityId, createdAt: 1 })
    const view = await loadOrg(sdk, r1, readOpts())
    const p = view.requests.find((r) => r.request.id === id)!.request.proposals[0]!
    const approve = sealEnvelope(people[1]!.keys, V.room, 'reject', { proposalId: p.id, reason: 'spam' })
    await port.writeMessage(stranger, ORG, encodeMessage(approve))
    const again = await loadOrg(sdk, r1, readOpts())
    expect(again.members.map((m) => m.ownerId)).toEqual([people[0]!.auth.identityId])
    expect(again.requests.find((r) => r.request.id === id)!.decliners).toEqual([])
  })

  it('garbage orgMember rows naming a member key cannot push the real one out', async () => {
    const r1 = await connected(0)
    const real = port.members[0]!
    for (let i = 0; i < 20; i++) port.members.push({ ...real, id: `junk${i}`, ownerId: base58Encode(new Uint8Array(32).fill(150 + i)), createdAt: -100 + i })
    const id = await createRequest(sdk, r1, people[0]!, { title: 'f', specs: [writer(26)] }, opts(0))
    const view = await loadOrg(sdk, r1, readOpts())
    expect(view.members.map((m) => m.ownerId)).toEqual([people[0]!.auth.identityId])
    expect(view.requests.some((r) => r.request.id === id)).toBe(true)
  })

  it("a member re-proposing a finished request's exact bytes cannot make it read expired", async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'c1', specs: [writer(31)] }, opts(0))
    const v2 = await loadOrg(sdk, r2, readOpts())
    const p = v2.requests.find((r) => r.request.id === id)!.request.proposals[0]!
    const copy = { ...p.body, note: p.body.note!.replace(/"group":"[0-9a-f]{16}"/, '"group":"ffffffffffffffff"') }
    const mine = await myShare(port, v2, people[1]!, people[1]!.auth.identityId)
    const proposal = sealEnvelope(people[1]!.keys, V.room, 'proposal', copy as unknown as Record<string, unknown>)
    await port.writeMessage(people[1]!.auth, ORG, encodeMessage(proposal))
    await port.writeMessage(people[1]!.auth, ORG, encodeMessage(approveEnvelope(v2, people[1]!, mine, envelopeId(proposal), copy)))
    await signRequest(sdk, v2, v2.requests.find((r) => r.request.id === id)!, people[1]!, opts(1))
    const after = await loadOrg(sdk, r1, readOpts())
    expect(after.requests.find((r) => r.request.id === id)!.status).toBe('done')
  })

  it('a new request waits while some member logs are unreadable, so it never takes a nonce they hold', async () => {
    const r1 = await connected(0)
    await connected(1)
    const messagesOf = port.messagesOf
    port.messagesOf = async (o, owner, since) => {
      if (owner === people[1]!.auth.identityId) throw new Error('incomplete read')
      return messagesOf(o, owner, since)
    }
    try {
      resetOrgCaches()
      await expect(createRequest(sdk, r1, people[0]!, { title: 'u', specs: [writer(32)] }, opts(0))).rejects.toThrow(/could not be read/)
    } finally {
      port.messagesOf = messagesOf
    }
  })

  it("one member's unreadable log drops only that member's messages", async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'l', specs: [writer(27)] }, opts(0))
    const v2 = await loadOrg(sdk, r2, readOpts())
    await declineRequest(sdk, v2, v2.requests.find((r) => r.request.id === id)!, people[1]!, opts(1))
    resetOrgCaches()
    const messagesOf = port.messagesOf
    port.messagesOf = async (o, owner, since) => {
      if (owner === people[1]!.auth.identityId) throw new Error('incomplete read')
      return messagesOf(o, owner, since)
    }
    try {
      const view = await loadOrg(sdk, r1, readOpts())
      expect(view.unreadLogs).toBe(1)
      expect(view.requests.find((r) => r.request.id === id)!.decliners).toEqual([])
    } finally {
      port.messagesOf = messagesOf
    }
  })

  it('a retry of the same confirmed action posts the same request, not a second one', async () => {
    const r1 = await connected(0)
    const writeMessage = port.writeMessage
    let calls = 0
    port.writeMessage = async (...args) => {
      if (++calls === 2) throw new Error('sent, not seen yet')
      return writeMessage(...args)
    }
    try {
      await expect(createRequest(sdk, r1, people[0]!, { title: 'r', specs: [writer(28)] }, { ...opts(0), intent: 'intent-1' })).rejects.toThrow(/not seen/)
      const id = await createRequest(sdk, r1, people[0]!, { title: 'r', specs: [writer(28)] }, { ...opts(0), intent: 'intent-1' })
      const view = await loadOrg(sdk, r1, readOpts())
      expect(view.requests.filter((r) => r.request.title === 'r').map((r) => r.request.id)).toEqual([id])
      expect(view.requests.find((r) => r.request.id === id)!.collected).toBe(1)
    } finally {
      port.writeMessage = writeMessage
    }
  })

  it("an unreadable nonce keeps a request open but unsignable, never refused", async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'n', specs: [writer(29)] }, opts(0))
    nonceDown = true
    try {
      const v2 = await loadOrg(sdk, r2, readOpts())
      const req = v2.requests.find((r) => r.request.id === id)!
      expect(req.status).toBe('collecting')
      await expect(signRequest(sdk, v2, req, people[1]!, opts(1))).rejects.toThrow(/nonce could not be read/)
    } finally {
      nonceDown = false
    }
  })

  it('a decline is recorded and does not block', async () => {
    stored.set(ALICE, { revision: 1n, data: membershipData(REPO, ALICE, { role: 1 }) })
    const r1 = await connected(0)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'x', specs: [{ action: 'delete', contractId: forge.core, documentType: 'writer', documentId: ALICE }] }, opts(0))
    const r2 = await connected(1)
    const v2 = await loadOrg(sdk, r2, readOpts())
    const req = v2.requests.find((r) => r.request.id === id)!
    expect(req.request.proposals[0]!.body.unsigned).toMatch(/^[0-9a-f]+$/)
    await declineRequest(sdk, v2, req, people[1]!, opts(1))
    const again = (await loadOrg(sdk, r2, readOpts())).requests.find((r) => r.request.id === id)!
    expect(again.viewerDeclined).toBe(true)
    expect(again.status).toBe('collecting')
    expect(again.decliners).toHaveLength(1)
    stored.delete(ALICE)
  })

  it('the second request takes the next nonce after an open one', async () => {
    const r1 = await connected(0)
    await createRequest(sdk, r1, people[0]!, { title: 'w', specs: [writer(23)] }, opts(0))
    const view = await loadOrg(sdk, r1, readOpts())
    const open = view.requests.filter((r) => r.status === 'collecting').flatMap((r) => r.proposals.map((p) => p.decoded!.nonce))
    const id = await createRequest(sdk, r1, people[0]!, { title: 'y', specs: [writer(6, 3)] }, opts(0))
    const req = (await loadOrg(sdk, r1, readOpts())).requests.find((r) => r.request.id === id)!
    expect(req.proposals[0]!.decoded!.nonce).toBe(open.reduce((a, b) => (a > b ? a : b)) + 1n)
  })

  it('new requests take the lowest free nonces, so a far open one blocks nothing', async () => {
    const held = new Map([['c', new Set([11n, 12n, 34n])]])
    expect(freeNonces(['c', 'c', 'd'], () => 10n, held)).toEqual([13n, 14n, 11n])
    expect(freeNonces(['c'], () => 33n | (1n << 40n), held)).toEqual([35n])
    const full = new Map([['c', new Set(Array.from({ length: 24 }, (_, i) => 11n + BigInt(i)))]])
    expect(() => freeNonces(['c'], () => 10n, full)).toThrow(/hold every nonce/)
  })

  it('a phrase that is not this record\'s member cannot create a request', async () => {
    const r1 = await connected(0)
    await expect(createRequest(sdk, r1, people[1]!, { title: 'z', specs: [writer(30)] }, opts(1))).rejects.toThrow(/unlock/)
  })

  it('one Forge identity cannot connect as two members', async () => {
    await connected(0)
    const candidate = await verifyInvite(sdk, V.room, 'testnet')
    await expect(connect(sdk, candidate, 'testnet', people[1]!, people[0]!.auth, { forge, port })).rejects.toThrow(/another member/)
  })

  it('a request declined by more than M-N members reads declined and frees its nonce', async () => {
    const r1 = await connected(0)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'w', specs: [writer(7)] }, opts(0))
    const r2 = await connected(1)
    const r3 = await connected(2)
    const v2 = await loadOrg(sdk, r2, readOpts())
    await declineRequest(sdk, v2, v2.requests.find((r) => r.request.id === id)!, people[1]!, opts(1))
    const v3 = await loadOrg(sdk, r3, readOpts())
    const before = v3.requests.find((r) => r.request.id === id)!
    expect(before.status).toBe('collecting')
    const held = before.proposals[0]!.decoded!.nonce
    await declineRequest(sdk, v3, before, people[2]!, opts(2))
    const v1 = await loadOrg(sdk, r1, readOpts())
    const req = v1.requests.find((r) => r.request.id === id)!
    expect(req.status).toBe('declined')
    expect(req.card).toEqual({ kind: 'declined', needed: 2, size: 3 })
    await expect(signRequest(sdk, v1, req, people[0]!, opts(0))).rejects.toThrow(/no longer open/)
    const next = await createRequest(sdk, r1, people[0]!, { title: 'v', specs: [writer(7)] }, opts(0))
    const fresh = (await loadOrg(sdk, r1, readOpts())).requests.find((r) => r.request.id === next)!
    expect(fresh.proposals[0]!.decoded!.nonce).toBe(held)
    const v3again = await loadOrg(sdk, r3, readOpts())
    await signRequest(sdk, v3again, v3again.requests.find((r) => r.request.id === next)!, people[2]!, opts(2))
    const after = await loadOrg(sdk, r1, readOpts())
    expect(after.requests.find((r) => r.request.id === next)!.status).toBe('done')
    expect(after.requests.find((r) => r.request.id === id)!.status).toBe('declined')
  })

  it('Publish organization: one request for the roster and the declared link that signers check against the ceremony (§10.5)', async () => {
    const ORGC = base58Encode(new Uint8Array(32).fill(77))
    const withOrg = { ...forge, org: ORGC }
    const r1 = await connected(0)
    const r2 = await connected(1)
    const roster = (await loadOrg(sdk, r1, readOpts())).roster
    const input = (await publishRequest(sdk, withOrg, port, roster, 'testnet', 'Acme'))!
    expect(input.specs.map((x) => ('documentType' in x ? `${x.documentType}:${x.action}` : ''))).toEqual(['org:create', 'profile:create'])
    const id = await createRequest(sdk, r1, people[0]!, input, { ...opts(0), forge: withOrg })
    const v2 = await loadOrg(sdk, r2, { ...readOpts(), forge: withOrg })
    const req = v2.requests.find((r) => r.request.id === id)!
    expect(req.proposals.flatMap((p) => p.problems)).toEqual([])
    expect(req.proposals[0]!.sentence).toBe("Publish the organization's roster: 2 of 3 members must sign")
    expect(req.proposals[1]!.sentence).toContain(declaredOrgLink('testnet', 2, 3))
    const done = await signRequest(sdk, v2, req, people[1]!, { ...opts(1), forge: withOrg })
    expect(done?.status).toBe('done')

    const bad = { ...input, specs: [{ ...(input.specs[0] as WriteSpec & { action: 'create' }), data: { ...rosterFields(roster), threshold: 3 } }] }
    const badId = await createRequest(sdk, r1, people[0]!, bad, { ...opts(0), forge: withOrg }).catch((e: Error) => e.message)
    expect(badId).toMatch(/does not match the organization's key ceremony \(threshold\)/)
  })

  it('signing re-runs the member-change checks: a repository that turned members-only refuses it (§11.4)', async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'g', specs: [writer(25)] }, opts(0))
    stored.set(REPO.repoId, { revision: 1n, data: { name: 'widgets', visibility: 'private' } })
    try {
      const v2 = await loadOrg(sdk, r2, readOpts())
      const req = v2.requests.find((r) => r.request.id === id)!
      await expect(signRequest(sdk, v2, req, people[1]!, opts(1))).rejects.toThrow("widgets now has members-only content or environments, so an organization can't change its members; decline this request")
      const after = (await loadOrg(sdk, r2, readOpts())).requests.find((r) => r.request.id === id)!
      expect(after.collected).toBe(1)
    } finally {
      stored.delete(REPO.repoId)
    }
  })

  it("a member's broadcast claim alone is not done: with its nonce free, Finish sends it", async () => {
    const r1 = await connected(0)
    const r2 = await connected(1)
    const id = await createRequest(sdk, r1, people[0]!, { title: 'c', specs: [writer(24)] }, opts(0))
    const v2 = await loadOrg(sdk, r2, readOpts())
    const p = v2.requests.find((r) => r.request.id === id)!.request.proposals[0]!
    const mine = await myShare(port, v2, people[1]!, people[1]!.auth.identityId)
    await port.writeMessage(people[1]!.auth, ORG, encodeMessage(approveEnvelope(v2, people[1]!, mine, p.id, p.body)))
    await port.writeMessage(people[1]!.auth, ORG, encodeMessage(sealEnvelope(people[1]!.keys, V.room, 'broadcast', { proposalId: p.id, result: { ok: true, confirmed: true } })))
    const claimed = await loadOrg(sdk, r1, readOpts())
    const req = claimed.requests.find((r) => r.request.id === id)!
    expect(req.request.proposals[0]!.status).toBe('executed')
    expect(req.status).toBe('ready')
    const before = broadcasts.length
    const done = await finishRequest(sdk, claimed, req, people[0]!, opts(0))
    expect(broadcasts.length).toBe(before + 1)
    expect(done?.status).toBe('done')
  })
})
