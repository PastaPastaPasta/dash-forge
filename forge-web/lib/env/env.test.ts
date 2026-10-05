/**
 * Unit tests for what the `env_snapshot__*` vectors do not pin: names that are JavaScript
 * object keys, lone surrogates, the writer's refusals, and a full Members and Maintainers round
 * trip through the production (randomized) seals.
 */

import { describe, expect, it } from 'vitest'
import { getPublicKey } from '@noble/secp256k1'

import { base58Encode } from '../auth/base58'
import { EpochKeys } from '../private'
import { resolveSnapshots } from './chain'
import { openSnapshot, sealMaintainersSnapshot, sealMembersSnapshot, SnapshotOpenError } from './codec'
import { decodeSnapshot, diffSnapshots, encodeSnapshot, MEMBERS_SENTENCE, ACCESS_SENTENCE, type EnvVar, type Snapshot } from './format'

const v = (value: string, type: EnvVar['type'] = 'secret'): EnvVar => ({ value, type, note: '' })

const OWNER = base58Encode(new Uint8Array(32).fill(1))

function snap(vars: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return { env: 'dev', audience: 'members', generatedAt: 1, maintainers: [OWNER], to: [], vars: new Map(Object.entries(vars).map(([k, x]) => [k, v(x)])), ...over }
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(b))).toString('hex')
}

describe('format', () => {
  it('keeps a variable named __proto__ as a plain entry', () => {
    const s: Snapshot = { ...snap({}), vars: new Map([['__proto__', v('x')]]) }
    const back = decodeSnapshot(encodeSnapshot(s))
    expect(back?.vars.get('__proto__')?.value).toBe('x')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('refuses a lone surrogate on write and on read', () => {
    expect(() => encodeSnapshot(snap({ A: '\ud800' }))).toThrow(RangeError)
    const raw = new TextEncoder().encode('{"audience":"members","env":"dev","generatedAt":1,"v":1,"vars":{"A":{"type":"secret","value":"\\ud800"}}}')
    const pt = new Uint8Array(512).fill(0x20)
    pt.set(raw)
    expect(decodeSnapshot(pt)).toBeNull()
  })

  it('diffs names only', () => {
    expect(diffSnapshots(snap({ A: '1', B: '2' }), snap({ B: '3', C: '4' }))).toEqual([
      ['A', 'removed'],
      ['B', 'changed'],
      ['C', 'added'],
    ])
  })

  it('uses the glossary in its sentences', () => {
    for (const s of [MEMBERS_SENTENCE, ACCESS_SENTENCE]) {
      for (const banned of ['sealed', 'lane', 'named', 'restricted', 'reveal']) expect(s.toLowerCase()).not.toContain(banned)
    }
  })
})

describe('codec round trips', () => {
  const repoId = new Uint8Array(32).fill(0x11)

  it('a Members snapshot opens under its epoch key only', async () => {
    const keys = await EpochKeys.import(repoId, 3, new Uint8Array(32).fill(7))
    const s = snap({ TOKEN: 'fake' })
    const sealed = await sealMembersSnapshot(keys, s)
    const manifest = { ownerId: OWNER, packHash: await sha256Hex(sealed), sizeBytes: sealed.length }
    const opened = await openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map([[3, keys]]) })
    expect(opened.vars.get('TOKEN')?.value).toBe('fake')
    await expect(openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map() })).rejects.toEqual(
      new SnapshotOpenError('noKey'),
    )
  })

  it('a Maintainers snapshot opens for each recipient and refuses a writer as the sender', async () => {
    const secret = (b: number) => new Uint8Array(32).fill(b)
    const party = (b: number) => ({ identityId: new Uint8Array(32).fill(b + 100), publicKey: getPublicKey(secret(b), true) })
    const alice = party(1)
    const bob = party(2)
    const ids = [alice, bob].map((p) => base58Encode(p.identityId))
    const s = snap({ DB_URL: 'postgres://fake' }, { env: 'production', audience: 'maintainers', to: ids, maintainers: ids })
    const sealed = await sealMaintainersSnapshot(repoId, secret(1), 4, alice.identityId, [alice, bob], s)
    const manifest = { ownerId: base58Encode(alice.identityId), packHash: await sha256Hex(sealed), sizeBytes: sealed.length }
    const ownerKeys = [{ id: 4, purpose: 1, keyType: 0, data: alice.publicKey }]
    for (const [p, b] of [[alice, 1], [bob, 2]] as const) {
      const got = await openSnapshot(manifest, sealed, { repoId, ownerKeys, reader: { identityId: p.identityId, secrets: [secret(b)] }, epochKeys: new Map() })
      expect(got.vars.get('DB_URL')?.value).toBe('postgres://fake')
    }
    // the same bytes under bob's manifest: the sender key is taken from bob's identity, nothing opens
    const asBob = { ...manifest, ownerId: base58Encode(bob.identityId) }
    const bobKeys = [{ id: 4, purpose: 1, keyType: 0, data: bob.publicKey }]
    await expect(
      openSnapshot(asBob, sealed, { repoId, ownerKeys: bobKeys, reader: { identityId: alice.identityId, secrets: [secret(1)] }, epochKeys: new Map() }),
    ).rejects.toBeInstanceOf(SnapshotOpenError)
    await expect(sealMaintainersSnapshot(repoId, secret(1), 4, bob.identityId, [alice, bob], s)).rejects.toThrow(RangeError)
  })

  it('checks the packHash before anything else', async () => {
    const keys = await EpochKeys.import(repoId, 0, new Uint8Array(32).fill(7))
    const sealed = await sealMembersSnapshot(keys, snap({ A: '1' }))
    const manifest = { ownerId: 'x', packHash: '00'.repeat(32), sizeBytes: 1 }
    await expect(openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map([[0, keys]]) })).rejects.toEqual(
      new SnapshotOpenError('packHashMismatch'),
    )
  })
})

describe('resolve', () => {
  it("a removed maintainer's latest change fails closed; without evidence it is ignored", () => {
    const ms = [
      { id: 's1', ownerId: 'A', packHash: 'aa', supersedes: [], createdAt: 1 },
      { id: 's2', ownerId: 'C', packHash: 'bb', supersedes: ['aa'], createdAt: 2 },
    ]
    const envOf = () => 'production'
    expect(resolveSnapshots(new Set(['A']), new Set(['C']), ms, envOf).environments[0]).toEqual({
      env: 'production',
      state: 'stale',
      heads: ['s2'],
      snapshots: ['s1', 's2'],
    })
    expect(resolveSnapshots(new Set(['A']), new Set(), ms, envOf).environments[0]?.heads).toEqual(['s1'])
  })

  it('a writer neither forks nor extends a chain', () => {
    const r = resolveSnapshots(
      new Set(['A']),
      new Set(),
      [
        { id: 's1', ownerId: 'A', packHash: 'aa', supersedes: [], createdAt: 1 },
        { id: 'w1', ownerId: 'W', packHash: 'bb', supersedes: ['aa'], createdAt: 2 },
      ],
      (h) => (h === 'aa' || h === 'bb' ? 'production' : null),
    )
    expect(r.environments).toEqual([{ env: 'production', state: 'current', heads: ['s1'], snapshots: ['s1'] }])
    expect(r.ignored).toEqual([{ id: 'w1', reason: 'notAMaintainer' }])
  })
})
