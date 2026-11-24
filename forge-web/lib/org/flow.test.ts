import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import { publicKeyHash } from '../auth/identity-lookup'
import { DEPLOYMENTS, forgeV2Ids, type ForgeIds } from '../deployments'
import { membershipData } from '../repo/writes'
import type { RepoRef } from '../repo/contract'
import { verify } from './bls'
import type { Envelope } from './envelope'
import { connect, createRequest, declineRequest, loadOrg, signRequest, verifyInvite } from './service'
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
const opts = { network: 'testnet' as const, forge }

const room: { envelope: unknown }[] = []
const broadcasts: { signable: string; signature: string }[] = []
const stored = new Map<string, { revision: bigint; data: Record<string, unknown> }>()
let nonce = 0n
let latest = 0

const sdk = {
  version: () => latest,
  identities: {
    byPublicKeyHash: async (hash: string) =>
      hash === publicKeyHash(GROUP_KEY)
        ? { id: { toBase58: () => ORG }, publicKeys: [{ keyId: 2, keyTypeNumber: 1, purposeNumber: 0, securityLevelNumber: 2, data: GROUP_KEY }] }
        : undefined,
    contractNonce: async () => nonce,
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

const people = V.members.map((m) => {
  const seed = seedFromMnemonic(m.mnemonic, m.passphrase)
  return { seed, keys: participantKeys(seed) }
})

beforeAll(async () => {
  const evo = await import('@dashevo/evo-sdk')
  latest = await evo.EvoSDK.getLatestVersionNumber()
  for (const e of V.ceremonyMessages) room.push({ envelope: e })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    expect(u.origin).toBe(RELAY)
    expect(u.pathname).toBe(`/v1/rooms/${V.room}/messages`)
    if (init?.method === 'POST') {
      room.push({ envelope: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 200 })
    }
    const after = Number(u.searchParams.get('after') ?? 0)
    return new Response(JSON.stringify({ messages: room.slice(after), next: room.length, more: false }), { status: 200 })
  })
})
afterAll(() => vi.unstubAllGlobals())

describe('organization request flow', () => {
  it('connects, creates at 1 of 2, a co-signer completes and broadcasts, then it reads done', async () => {
    const candidate = await verifyInvite(sdk, `${RELAY}/?network=testnet#room=${V.room}&name=Acme`, 'testnet')
    expect(candidate.identity.orgId).toBe(ORG)
    expect(candidate.identity.keyId).toBe(2)
    expect(candidate.threshold).toBe(2)
    expect(candidate.members.map((m) => m.authPub)).toEqual(V.members.map((m) => m.authPub))

    const r1 = connect(candidate, 'testnet', people[0]!.keys.authPub)
    expect(r1.label).toBe('Acme')
    const group = await createRequest(
      sdk,
      r1,
      people[0]!,
      { title: 'Give alice Write access', specs: [{ action: 'create', contractId: forge.core, documentType: 'writer', data: membershipData(REPO, ALICE, { role: 1 }) }] },
      opts,
    )
    const v1 = await loadOrg(sdk, r1, opts)
    const req1 = v1.requests.find((r) => r.request.id === group)!
    expect(req1.status).toBe('collecting')
    expect(req1.card).toEqual({ kind: 'signed', missing: 1 })
    expect(req1.collected).toBe(1)
    expect(req1.proposals[0]!.sentence).toMatch(/^Give .+ Write access to a repository$/)
    expect(req1.proposals[0]!.problems).toEqual([])

    const r3 = { ...r1, authPub: people[2]!.keys.authPub }
    const v3 = await loadOrg(sdk, r3, opts)
    const req3 = v3.requests.find((r) => r.request.id === group)!
    expect(req3.card).toEqual({ kind: 'sign', collected: 1, needed: 2 })
    const after = await signRequest(sdk, v3, req3, people[2]!, opts)
    expect(after?.status).toBe('done')
    expect(after?.card).toEqual({ kind: 'done' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]!.signable).toBe(req1.request.proposals[0]!.body.signable)
    expect(nonce).toBe(1n)
  })

  it('a decline is recorded and does not block', async () => {
    const r1 = connect(await verifyInvite(sdk, V.room, 'testnet'), 'testnet', people[0]!.keys.authPub)
    const group = await createRequest(sdk, r1, people[0]!, { title: 'x', specs: [{ action: 'delete', contractId: forge.core, documentType: 'writer', documentId: ALICE }] }, opts)
    const r2 = { ...r1, authPub: people[1]!.keys.authPub }
    const v2 = await loadOrg(sdk, r2, opts)
    const req = v2.requests.find((r) => r.request.id === group)!
    expect(req.request.proposals[0]!.body.unsigned).toMatch(/^[0-9a-f]+$/)
    await declineRequest(v2, req, people[1]!)
    const again = (await loadOrg(sdk, r2, opts)).requests.find((r) => r.request.id === group)!
    expect(again.viewerDeclined).toBe(true)
    expect(again.status).toBe('collecting')
    expect(again.decliners).toHaveLength(1)
  })

  it('the second request takes the next nonce after an open one', async () => {
    const r1 = connect(await verifyInvite(sdk, V.room, 'testnet'), 'testnet', people[0]!.keys.authPub)
    const view = await loadOrg(sdk, r1, opts)
    const open = view.requests.filter((r) => r.status === 'collecting').flatMap((r) => r.proposals.map((p) => p.decoded!.nonce))
    const group = await createRequest(sdk, r1, people[0]!, { title: 'y', specs: [{ action: 'create', contractId: forge.core, documentType: 'writer', data: membershipData(REPO, base58Encode(new Uint8Array(32).fill(6)), { role: 3 }) }] }, opts)
    const req = (await loadOrg(sdk, r1, opts)).requests.find((r) => r.request.id === group)!
    expect(req.proposals[0]!.decoded!.nonce).toBe(open.reduce((a, b) => (a > b ? a : b)) + 1n)
  })

  it('a phrase that is not a member cannot create a request', async () => {
    const r1 = connect(await verifyInvite(sdk, V.room, 'testnet'), 'testnet', people[0]!.keys.authPub)
    await expect(createRequest(sdk, r1, people[1]!, { title: 'z', specs: [] }, opts)).rejects.toThrow(/unlock/)
  })
})
