/**
 * Unit tests for what the `env_snapshot__*` vectors do not pin: names that are JavaScript
 * object keys, lone surrogates, the writer's refusals, the version-1 / version-2 split, audience
 * labels, and a full round trip of an old-format Members snapshot and a 64-person letter through
 * the production (randomized) seals.
 */

import { describe, expect, it } from 'vitest'
import { getPublicKey } from '@noble/secp256k1'

import { base58Encode } from '../auth/base58'
import { EpochKeys, sealLetterArtifact, sealPack } from '../private'
import { resolveSnapshots } from './chain'
import { openSnapshot, sealLetterSnapshot, sealOldMembersSnapshotForVectors, SnapshotOpenError } from './codec'
import {
  ACCESS_SENTENCE,
  MAX_RECIPIENTS,
  OLD_FORMAT_HISTORY_SENTENCE,
  OLD_FORMAT_SENTENCE,
  audienceLabel,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  membersKey,
  snapshotProblem,
  type EnvVar,
  type Snapshot,
} from './format'

const v = (value: string, type: EnvVar['type'] = 'secret'): EnvVar => ({ value, type, note: '' })

const ENV_ID = '00112233445566778899aabbccddeeff'

/** An old-format Members snapshot (version 1) unless overridden. */
function snap(vars: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    env: 'dev',
    audience: { group: 'members', also: [] },
    id: null,
    generatedAt: 1,
    to: [],
    toKeys: [],
    markedChanged: [],
    vars: new Map(Object.entries(vars).map(([k, x]) => [k, v(x)])),
    ...over,
  }
}

/** A version-2 snapshot to `to`. */
function snap2(vars: Record<string, string>, to: string[], over: Partial<Snapshot> = {}): Snapshot {
  return snap(vars, { version: 2, audience: { group: 'maintainers', also: [] }, id: ENV_ID, to, toKeys: to.map((_, i) => i), ...over })
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => base58Encode(new Uint8Array(32).fill(i + 1)))

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
    for (const s of [OLD_FORMAT_SENTENCE, OLD_FORMAT_HISTORY_SENTENCE, ACCESS_SENTENCE]) {
      for (const banned of ['sealed', 'lane', 'named', 'restricted', 'reveal']) expect(s.toLowerCase()).not.toContain(banned)
    }
  })

  it('tells an audience as dg does', () => {
    expect(audienceLabel({ group: 'maintainers', also: [] })).toBe('Maintainers')
    expect(audienceLabel({ group: 'writers', also: [] })).toBe('Writers and maintainers')
    expect(audienceLabel({ group: 'members', also: [] })).toBe('All members')
    expect(audienceLabel({ group: 'writers', also: ids(1) })).toBe('Writers and maintainers + 1 more')
    expect(audienceLabel({ group: null, also: ids(3) })).toBe('Specific people (3)')
  })

  it('knows an old-format Members snapshot by version and group', () => {
    expect(membersKey(snap({}))).toBe(true)
    expect(membersKey(snap2({}, ids(1), { audience: { group: 'members', also: [] } }))).toBe(false)
    expect(membersKey(snap({}, { audience: { group: 'maintainers', also: [] }, to: ids(1) }))).toBe(false)
  })

  describe('version 2', () => {
    const to = ids(3)
    const round = (s: Snapshot) => decodeSnapshot(encodeSnapshot(s))

    it('round-trips every audience, the id, the keys and the marks', () => {
      for (const audience of [
        { group: 'maintainers', also: [] },
        { group: 'writers', also: [to[2] as string] },
        { group: 'members', also: [] },
        { group: null, also: [to[1] as string, to[2] as string] },
      ] as const) {
        const s = snap2({ A: '1' }, to, { audience, markedChanged: ['A', 'B'] })
        const back = round(s)
        expect(back).toEqual(s)
        expect(back?.version).toBe(2)
      }
    })

    it('leaves markedChanged out when empty', () => {
      const raw = new TextDecoder().decode(encodeSnapshot(snap2({ A: '1' }, to)))
      expect(raw.startsWith(`{"audience":{"also":[],"group":"maintainers"},"env":"dev","generatedAt":1,"id":"${ENV_ID}","to":["${to[0]}"`)).toBe(true)
      expect(raw).not.toContain('markedChanged')
      expect(raw).toContain('"toKeys":[0,1,2],"v":2,"vars":')
    })

    it('goes to at most 64 people and a version-1 letter to 16', () => {
      expect(MAX_RECIPIENTS).toBe(64)
      expect(snapshotProblem(snap2({}, ids(64)))).toBeNull()
      expect(snapshotProblem(snap2({}, ids(65)))).not.toBeNull()
      expect(snapshotProblem(snap({}, { audience: { group: 'maintainers', also: [] }, to: ids(16) }))).toBeNull()
      expect(snapshotProblem(snap({}, { audience: { group: 'maintainers', also: [] }, to: ids(17) }))).not.toBeNull()
    })

    it('refuses what a reader would refuse', () => {
      const bad = (over: Partial<Snapshot>) => snapshotProblem(snap2({}, to, over))
      expect(bad({ id: null })).not.toBeNull()
      expect(bad({ id: ENV_ID.toUpperCase() })).not.toBeNull()
      expect(bad({ id: ENV_ID.slice(1) })).not.toBeNull()
      expect(bad({ audience: { group: null, also: [] } })).not.toBeNull()
      expect(bad({ audience: { group: 'members', also: [to[1] as string, to[0] as string] } })).not.toBeNull()
      expect(bad({ audience: { group: 'members', also: [to[0] as string, to[0] as string] } })).not.toBeNull()
      expect(bad({ audience: { group: 'members', also: ['nope'] } })).not.toBeNull()
      expect(bad({ to: [] })).not.toBeNull()
      expect(bad({ to: [to[0] as string, to[0] as string] })).not.toBeNull()
      expect(bad({ toKeys: [0, 1] })).not.toBeNull()
      expect(bad({ toKeys: [0, 1, 2 ** 32] })).not.toBeNull()
      expect(bad({ toKeys: [0, 1, -1] })).not.toBeNull()
      expect(bad({ markedChanged: ['B', 'A'] })).not.toBeNull()
      expect(bad({ markedChanged: ['A', 'A'] })).not.toBeNull()
      expect(bad({ markedChanged: ['1A'] })).not.toBeNull()
      expect(bad({ version: 3 as unknown as 2 })).not.toBeNull()
    })

    it('reads version 1 as before, and refuses v2-only keys in it and other versions', () => {
      const pad = (raw: string): Uint8Array => {
        const pt = new Uint8Array(512).fill(0x20)
        pt.set(new TextEncoder().encode(raw))
        return pt
      }
      const ok = '{"audience":"members","env":"dev","generatedAt":1,"v":1,"vars":{"A":{"type":"secret","value":"x"}}}'
      const old = decodeSnapshot(pad(ok))
      expect(old?.version).toBe(1)
      expect(old?.audience).toEqual({ group: 'members', also: [] })
      expect(old?.id).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"env"', `"id":"${ENV_ID}","env"`)))).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"v":1', '"toKeys":[],"v":1')))).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"v":1', '"markedChanged":["A"],"v":1')))).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"v":1', '"v":3')))).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"v":1,', '')))).toBeNull()
      expect(decodeSnapshot(pad(ok.replace('"members"', '"writers"')))).toBeNull()
    })

    it('refuses a non-canonical encoding of a valid snapshot', () => {
      const good = new TextDecoder().decode(encodeSnapshot(snap2({ A: '1' }, to))).trimEnd()
      const pad = (raw: string): Uint8Array => {
        const pt = new Uint8Array(512).fill(0x20)
        pt.set(new TextEncoder().encode(raw))
        return pt
      }
      expect(decodeSnapshot(pad(good))).not.toBeNull()
      expect(decodeSnapshot(pad(good.replace('"toKeys":[0,1,2]', '"toKeys":[0,1,2.0]')))).toBeNull()
      expect(decodeSnapshot(pad(good.replace('"audience":{"also":[],"group":"maintainers"}', '"audience":{"group":"maintainers","also":[]}')))).toBeNull()
      expect(decodeSnapshot(pad(good.replace(',"toKeys"', ',"markedChanged":[],"toKeys"')))).toBeNull()
    })
  })
})

describe('codec round trips', () => {
  const repoId = new Uint8Array(32).fill(0x11)

  it('an old-format Members snapshot opens under its epoch key only', async () => {
    const keys = await EpochKeys.import(repoId, 3, new Uint8Array(32).fill(7))
    const s = snap({ TOKEN: 'fake' })
    const sealed = await sealOldMembersSnapshotForVectors(keys, s)
    const manifest = { ownerId: base58Encode(new Uint8Array(32).fill(1)), packHash: await sha256Hex(sealed), sizeBytes: sealed.length }
    const opened = await openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map([[3, keys]]) })
    expect(opened.vars.get('TOKEN')?.value).toBe('fake')
    await expect(openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map() })).rejects.toEqual(
      new SnapshotOpenError('noKey'),
    )
  })

  it('a letter opens for each recipient and refuses a writer as the sender', async () => {
    const secret = (b: number) => new Uint8Array(32).fill(b)
    const party = (b: number) => ({ identityId: new Uint8Array(32).fill(b + 100), publicKey: getPublicKey(secret(b), true) })
    const alice = party(1)
    const bob = party(2)
    const s = snap2({ DB_URL: 'postgres://fake' }, [alice, bob].map((p) => base58Encode(p.identityId)), { env: 'production' })
    const sealed = await sealLetterSnapshot(repoId, secret(1), 4, alice.identityId, [alice, bob], s)
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
    await expect(sealLetterSnapshot(repoId, secret(1), 4, bob.identityId, [alice, bob], s)).rejects.toThrow(RangeError)
  })

  it('a letter to 64 people opens for the last of them', async () => {
    const secret = (b: number) => new Uint8Array(32).fill(b)
    const party = (b: number) => ({ identityId: new Uint8Array(32).fill(b + 100), publicKey: getPublicKey(secret(b), true) })
    const people = Array.from({ length: 64 }, (_, i) => party(i + 1))
    const s = snap2({ TOKEN: 'fake' }, people.map((p) => base58Encode(p.identityId)))
    const sealed = await sealLetterSnapshot(repoId, secret(1), 4, (people[0] as (typeof people)[number]).identityId, people, s)
    const manifest = { ownerId: s.to[0] as string, packHash: await sha256Hex(sealed), sizeBytes: sealed.length }
    const ownerKeys = [{ id: 4, purpose: 1, keyType: 0, data: (people[0] as (typeof people)[number]).publicKey }]
    const last = people[63] as (typeof people)[number]
    const got = await openSnapshot(manifest, sealed, { repoId, ownerKeys, reader: { identityId: last.identityId, secrets: [secret(64)] }, epochKeys: new Map() })
    expect(got.to).toHaveLength(64)
    expect(got.vars.get('TOKEN')?.value).toBe('fake')
    // a 65th recipient is refused by the writer
    const extra = [...people, party(65)]
    await expect(sealLetterSnapshot(repoId, secret(1), 4, (people[0] as (typeof people)[number]).identityId, extra, { ...s, to: extra.map((p) => base58Encode(p.identityId)) })).rejects.toThrow()
  })

  it('opens an old-format Members snapshot only from a members-key file, and anything else only from a letter', async () => {
    const secret = (b: number) => new Uint8Array(32).fill(b)
    const alice = { identityId: new Uint8Array(32).fill(101), publicKey: getPublicKey(secret(1), true) }
    const owner = base58Encode(alice.identityId)
    const ownerKeys = [{ id: 4, purpose: 1, keyType: 0, data: alice.publicKey }]
    const keys = await EpochKeys.import(repoId, 0, new Uint8Array(32).fill(7))
    const open = async (sealed: Uint8Array) =>
      openSnapshot({ ownerId: owner, packHash: await sha256Hex(sealed), sizeBytes: sealed.length }, sealed, {
        repoId,
        ownerKeys,
        reader: { identityId: alice.identityId, secrets: [secret(1)] },
        epochKeys: new Map([[0, keys]]),
      })
    // a version-2 snapshot in a members-key file, and an old-format Members snapshot in a letter
    await expect(open(await sealPack(keys, encodeSnapshot(snap2({ A: '1' }, [owner]))))).rejects.toEqual(new SnapshotOpenError('malformed'))
    await expect(open(await sealLetterArtifact(repoId, secret(1), 4, alice.identityId, [alice], encodeSnapshot(snap({ A: '1' }))))).rejects.toEqual(
      new SnapshotOpenError('malformed'),
    )
    // a letter whose `to` does not list the manifest owner first
    await expect(open(await sealLetterArtifact(repoId, secret(1), 4, alice.identityId, [alice], encodeSnapshot(snap2({ A: '1' }, ids(1)))))).rejects.toEqual(
      new SnapshotOpenError('malformed'),
    )
    // a version-1 Maintainers letter is still read, and a good version-2 one
    const v1 = snap({ A: '1' }, { audience: { group: 'maintainers', also: [] }, to: [owner] })
    expect((await open(await sealLetterArtifact(repoId, secret(1), 4, alice.identityId, [alice], encodeSnapshot(v1)))).version).toBe(1)
    expect((await open(await sealLetterArtifact(repoId, secret(1), 4, alice.identityId, [alice], encodeSnapshot(snap2({ A: '1' }, [owner]))))).version).toBe(2)
  })

  it('checks the packHash before anything else', async () => {
    const keys = await EpochKeys.import(repoId, 0, new Uint8Array(32).fill(7))
    const sealed = await sealOldMembersSnapshotForVectors(keys, snap({ A: '1' }))
    const manifest = { ownerId: 'x', packHash: '00'.repeat(32), sizeBytes: 1 }
    await expect(openSnapshot(manifest, sealed, { repoId, ownerKeys: [], reader: null, epochKeys: new Map([[0, keys]]) })).rejects.toEqual(
      new SnapshotOpenError('packHashMismatch'),
    )
  })
})

describe('resolve', () => {
  it('a writer neither forks nor extends a chain', () => {
    const r = resolveSnapshots(
      new Set(['A']),
      [
        { id: 's1', ownerId: 'A', packHash: 'aa', supersedes: [], height: 1 },
        { id: 'w1', ownerId: 'W', packHash: 'bb', supersedes: ['aa'], height: 2 },
      ],
      (h) => (h === 'aa' || h === 'bb' ? 'production' : null),
    )
    expect(r.environments).toEqual([{ env: 'production', state: 'current', heads: ['s1'], snapshots: ['s1'], ignoredNewer: ['w1'] }])
    expect(r.ignored).toEqual([{ id: 'w1', reason: 'notAMaintainer' }])
  })
})
