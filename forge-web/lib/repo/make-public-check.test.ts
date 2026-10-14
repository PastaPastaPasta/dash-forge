/**
 * The check reads the private era through the repo's private view (forge-core
 * `RepoRef::private_view`): in a repo made public already, a member's session of that view opens
 * the settings and refs written while private and quietly leaves out what was written after the
 * flip (a plaintext config or ref update, a members-only one stamped public).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { EpochKeys, WrapError, bytesToHex, refNameHash, sealDoc, type PrivateDoc, type PrivateDocType } from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, type DocumentQuery } from '../sdk'
import type { RepoRef } from './contract'
import { hostOf, privateEraRefs, privateViewOf, publicViewOf } from './make-public-check'
import { loadPrivateSession } from './private-session'
import { readRefs } from './refs'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO = id(0x11)
const ALICE = id(0x21)
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
// the repo as the page holds it once public, with a session the check must not reuse
const PUBLIC: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'ledger', visibility: 'public' }
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)

let seq = 0
const docId = (): Uint8Array => {
  seq += 1
  const u = new Uint8Array(32)
  new DataView(u.buffer).setUint32(28, seq)
  return u
}

async function sealed(type: PrivateDocType, keys: EpochKeys, bind: Partial<PrivateDoc>, fields: Parameters<typeof sealDoc>[2], extra: Record<string, unknown>, height: number, anchor = false): Promise<Record<string, unknown>> {
  const $id = docId()
  const enc = await sealDoc(keys, { type, ownerId: ALICE, epoch: keys.epoch, ...bind }, fields, { anchor })
  return { $id: b58($id), $ownerId: b58(ALICE), $createdAt: height * 1000, $createdAtBlockHeight: height, repoId: b58(REPO), epoch: keys.epoch, enc: bytesToBase64(enc), ...extra }
}

function wrap(epoch: number, height: number): Record<string, unknown> {
  return { $id: b58(docId()), $ownerId: b58(ALICE), $createdAt: height * 1000, $createdAtBlockHeight: height, repoId: b58(REPO), memberId: b58(ALICE), epoch, recipientKeyId: 4, senderKeyId: 4, wrapped: bytesToBase64(new Uint8Array(64)) }
}

function mockSdk(rows: Record<string, Record<string, unknown>[]>): EvoSDK {
  const query = async (q: DocumentQuery): Promise<Map<string, Record<string, unknown>>> => {
    let out = [...(rows[q.documentTypeName] ?? [])]
    for (const [f, op, v] of q.where ?? []) if (op === '==') out = out.filter((d) => d[f] === v)
    out.sort((a, b) => (a['$createdAt'] as number) - (b['$createdAt'] as number))
    if (q.startAfter !== undefined) out = out.slice(out.findIndex((d) => d['$id'] === q.startAfter) + 1)
    return new Map(out.slice(0, Math.min(q.limit ?? 100, 100)).map((d) => [String(d['$id']), d]))
  }
  return { documents: { query, count: async () => new Map(), sum: async () => new Map() } } as unknown as EvoSDK
}

describe("the check's private view of a repo made public", () => {
  it('drops the caller\'s sessions and states the visibility', () => {
    const page = { ...PUBLIC, lane: {} as never }
    expect(privateViewOf(page)).toEqual({ ...PUBLIC, visibility: 'private' })
    expect(publicViewOf({ ...PUBLIC, visibility: 'private' })).toEqual(PUBLIC)
  })

  it('opens the settings and refs written while private and leaves out what came after the flip', async () => {
    const k0 = await EpochKeys.import(REPO, 0, K0)
    const k1 = await EpochKeys.import(REPO, 1, K1)
    const configs = [
      await sealed('config', k0, {}, { defaultBranch: 'trunk' }, { vis: 'private', backend: { mode: 0 } }, 10, true),
      // the seal-off rotation, still private
      await sealed('config', k1, {}, { defaultBranch: 'trunk', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) }, { vis: 'private', backend: { mode: 0 } }, 20, true),
      // the first public settings, after the flip
      { $id: b58(docId()), $ownerId: b58(ALICE), $createdAt: 40_000, $createdAtBlockHeight: 40, repoId: b58(REPO), defaultBranch: 'main', vis: 'public', backend: { mode: 0 } },
    ]
    const members: Membership[] = [{ identity: b58(ALICE), role: 'maintainer', createdAt: 1 }]
    const keys = new Map([
      [0, k0],
      [1, k1],
    ])
    const view = privateViewOf(PUBLIC)
    const session = await loadPrivateSession({
      repo: view,
      network: 'devnet',
      reader: b58(ALICE),
      source: { memberships: async () => members, configs: async () => configs, repoKeys: async () => [wrap(0, 11), wrap(1, 19)], identityKeys: async () => [{ keyId: 4, purposeNumber: 1, keyTypeNumber: 0, data: '02' + 'ab'.repeat(32) }] },
      unwrapper: {
        keyId: 4,
        unwrap: async (p) => {
          const k = keys.get(p.epoch)
          if (k === undefined) throw new WrapError('wrapUnreadable')
          return k
        },
      },
    })
    expect(session.resolution.currentEpoch).toBe(1)
    expect(session.config?.defaultBranch).toBe('trunk')
    expect(session.conversion).toBeNull()
    const oid = (b: number) => new Uint8Array(20).fill(b)
    const sealedRef = async (keys: EpochKeys, name: string, newOid: Uint8Array, vis: 'private' | 'public', height: number) => {
      const h = await refNameHash(keys, name)
      return sealed('refUpdate', keys, { refNameHash: h, newOid, force: false }, { refName: name }, { refNameHash: bytesToBase64(h), newOid: bytesToBase64(newOid), force: false, vis }, height)
    }
    const rows = [
      await sealedRef(k0, 'refs/heads/trunk', oid(0xaa), 'private', 15),
      // members-only after the flip (under the seal-off key, stamped public): never this view's
      await sealedRef(k1, 'refs/heads/later', oid(0xbb), 'public', 45),
      // a public push after the flip: plaintext
      { $id: b58(docId()), $ownerId: b58(ALICE), $createdAt: 46_000, $createdAtBlockHeight: 46, repoId: b58(REPO), refName: 'refs/heads/pub', refNameHash: bytesToBase64(new Uint8Array(32)), newOid: bytesToBase64(oid(0xcc)), force: false, vis: 'public' },
    ]
    const refs = await readRefs(mockSdk({ refUpdate: rows, protectedRefUpdate: [] }), { ...view, session }, undefined, Promise.resolve(session.configHistory))
    expect(refs.map((r) => [r.refName, r.state.state === 'resolved' ? r.state.oid : null])).toEqual([['refs/heads/trunk', bytesToHex(oid(0xaa))]])
    // a push during the conversion (sealed under the seal-off key, still stamped private) moves
    // the private view's tip, but what Everything publishes stops below the seal-off epoch
    const during = await sealed('refUpdate', k1, { refNameHash: await refNameHash(k1, 'refs/heads/trunk'), newOid: oid(0xdd), prevOid: oid(0xaa), force: false }, { refName: 'refs/heads/trunk' }, {}, 25)
    const h1 = await refNameHash(k1, 'refs/heads/trunk')
    Object.assign(during, { refNameHash: bytesToBase64(h1), newOid: bytesToBase64(oid(0xdd)), prevOid: bytesToBase64(oid(0xaa)), force: false, vis: 'private' })
    const byType = new Map([
      ['refUpdate', [...rows, during]],
      ['protectedRefUpdate', []],
    ])
    const tip = async (below?: number) => (await privateEraRefs(session, byType, below)).map((r) => (r.state.state === 'resolved' ? r.state.oid : r.state.state))
    expect(await tip()).toEqual([bytesToHex(oid(0xdd))])
    expect(await tip(1)).toEqual([bytesToHex(oid(0xaa))])
    session.close()
  })
})

describe('imported authors', () => {
  it('are counted by their host (forge-core host_of)', () => {
    expect(hostOf('https://GitHub.com/o/r/issues/1')).toBe('github.com')
    expect(hostOf('https://gitlab.example:8443/x?y#z')).toBe('gitlab.example:8443')
    expect(hostOf('not a url')).toBe('not a url')
  })
})
