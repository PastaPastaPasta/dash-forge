/**
 * Unit tests for what the §11 vectors cannot cover: the production (randomized) seals,
 * non-extractability, the header cache and streaming reads.
 */

import { describe, expect, it } from 'vitest'

import { bytesToHex, constantTimeEqual, hexToBytes } from './bytes'
import { base58Encode } from '../auth/base58'
import { openContent, sealDoc, type OpenContext, type PrivateDoc } from './doc'
import { resolveEpochs, type ConfigRow, type WrapRow } from './epoch'
import { IdSet, compareBytes, encodePrivateId, privateId } from './ids'
import { EpochKeys, importEpochKeyAndWipe } from './keys'
import {
  HEADER_LEN,
  PackError,
  PackHeaderCache,
  openPack,
  openPackStream,
  packHash,
  parseHeader,
  readPackRange,
  sealPack,
  type RangeFetcher,
} from './pack'
import { MalformedError, parseTlv } from './tlv'
import { parseWrapPlaintext, WrapError, buildWrapPlaintext, sealWrap, type WrapFacade } from './wrap'
import * as privateApi from './index'

const REPO_ID = new Uint8Array(32).fill(0x11)
const OWNER = new Uint8Array(32).fill(0x22)
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)

const keysFor = (epoch = 0, raw = K0) => EpochKeys.import(REPO_ID, epoch, raw)
const mod251 = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const ISSUE: PrivateDoc = { type: 'issue', ownerId: OWNER, epoch: 0, number: 7 }

describe('production seals are randomized and round-trip', () => {
  it('sealDoc draws a fresh hedged nonce every time', async () => {
    const keys = await keysFor()
    const fields = { title: 'Rotate the signing key', body: 'See the runbook.' }
    const a = await sealDoc(keys, ISSUE, fields)
    const b = await sealDoc(keys, ISSUE, fields)
    expect(bytesToHex(a.subarray(1, 13))).not.toBe(bytesToHex(b.subarray(1, 13)))
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
    const ctx: OpenContext = {
      keys: new Map([[0, keys]]),
      anchors: new Map([[0, { id: new Uint8Array(32).fill(0xc0), height: 10 }]]),
      members: new IdSet(),
    }
    for (const enc of [a, b]) {
      expect(await openContent({ ...ISSUE, enc, createdAtBlockHeight: 50 }, ctx)).toEqual({
        status: 'readable',
        fields,
      })
    }
  })

  it('sealDoc refuses what a reader would refuse', async () => {
    const keys = await keysFor()
    await expect(sealDoc(keys, ISSUE, { body: 'no title' })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealDoc(keys, { ...ISSUE, epoch: 1 }, { title: 't' })).rejects.toBeInstanceOf(RangeError)
  })

  it('a config anchor seals as enc v0x02 carrying COMMIT_e', async () => {
    const keys = await keysFor()
    const enc = await sealDoc(keys, { type: 'config', ownerId: OWNER, epoch: 0 }, { defaultBranch: 'refs/heads/main' }, { anchor: true })
    expect(enc[0]).toBe(2)
    expect(constantTimeEqual(enc.subarray(1, 33), keys.commit)).toBe(true)
  })

  it('sealPack draws a fresh hedged fileId every time', async () => {
    const keys = await keysFor()
    const plain = mod251(40_000)
    const a = await sealPack(keys, plain)
    const b = await sealPack(keys, plain)
    expect(bytesToHex(parseHeader(a).fileId)).not.toBe(bytesToHex(parseHeader(b).fileId))
    expect(await packHash(a)).not.toBe(await packHash(b))
    const ring = new Map([[0, keys]])
    expect(bytesToHex(await openPack(a, a.length, ring))).toBe(bytesToHex(plain))
    expect(bytesToHex(await openPack(b, b.length, ring))).toBe(bytesToHex(plain))
  })

  it('the production API does not export the deterministic seams', () => {
    const exported = Object.keys(privateApi)
    for (const name of ['sealDocWithNonce', 'sealPackWithFileId', 'hedgedFileId', 'hedgedNonce', 'sealPackWith', 'prepareDocSeal', 'sealDocWith', '__unsafeSealDocWithNonce', '__unsafeSealPackWithFileId']) {
      expect(exported).not.toContain(name)
    }
  })
})

describe('keys are non-extractable', () => {
  it('every derived subkey', async () => {
    const keys = await keysFor()
    const derived = [keys.docKey, keys.refKey, keys.hedgeKey, await keys.packKey(new Uint8Array(16))]
    for (const k of derived) expect(k.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', keys.docKey)).rejects.toThrow()
    expect(keys.kcv.length).toBe(14)
    expect(keys.commit.length).toBe(32)
  })

  it('importEpochKeyAndWipe erases the raw key', async () => {
    const raw = new Uint8Array(K0)
    const keys = await importEpochKeyAndWipe(REPO_ID, 0, raw)
    expect(raw.every((b) => b === 0)).toBe(true)
    expect(bytesToHex(keys.kcv)).toBe('7cab1ab77a4b34d31fa6ef954054')
  })

  it('a wrap plaintext round-trips and is wiped after parsing', async () => {
    const keys = await keysFor()
    const pt = await buildWrapPlaintext(keys, K0)
    const opened = await parseWrapPlaintext(REPO_ID, 0, pt, keys.commit)
    expect(pt.every((b) => b === 0)).toBe(true)
    expect(bytesToHex(opened.commit)).toBe(bytesToHex(keys.commit))
    await expect(parseWrapPlaintext(REPO_ID, 0, await buildWrapPlaintext(keys, K0), new Uint8Array(32))).rejects.toEqual(
      new WrapError('keyMismatch'),
    )
  })

  it('sealWrap refuses a raw key that is not the one behind keys, before the SDK sees it', async () => {
    const keys = await keysFor()
    let calls = 0
    const facade: WrapFacade = {
      encrypt: async () => {
        calls++
        return {}
      },
      decrypt: async () => new Uint8Array(0),
    }
    const params = {} as Parameters<typeof sealWrap>[3]
    await expect(sealWrap(facade, keys, new Uint8Array(32).fill(0x77), params)).rejects.toBeInstanceOf(RangeError)
    await expect(sealWrap(facade, await keysFor(1, new Uint8Array(32).fill(0x20)), K0, params)).rejects.toBeInstanceOf(RangeError)
    expect(calls).toBe(0)
    await sealWrap(facade, keys, K0, params)
    expect(calls).toBe(1)
  })
})

describe('ranged and streaming reads', () => {
  async function fixture() {
    const keys = await keysFor()
    const plain = mod251(40_000)
    const sealed = await sealPack(keys, plain)
    const calls: [number, number][] = []
    const fetchRange: RangeFetcher = async (start, end) => {
      calls.push([start, end])
      return sealed.subarray(start, end)
    }
    return { ring: new Map([[0, keys]]), plain, sealed, calls, fetchRange, hash: await packHash(sealed) }
  }

  const src = (f: Awaited<ReturnType<typeof fixture>>, copy = 'copy-a', sizeBytes = f.sealed.length) => ({
    packHash: f.hash,
    copy,
    sizeBytes,
    fetchRange: f.fetchRange,
  })

  it('the header cache fetches the header of a copy once, after it authenticates', async () => {
    const f = await fixture()
    const cache = new PackHeaderCache()
    const a = await readPackRange(src(f), 20_000, 20_100, f.ring, cache)
    expect(cache.has(f.hash, 'copy-a')).toBe(true)
    expect(cache.has(f.hash, 'copy-b')).toBe(false)
    const b = await readPackRange(src(f), 100, 200, f.ring, cache)
    expect(bytesToHex(a)).toBe(bytesToHex(f.plain.subarray(20_000, 20_100)))
    expect(bytesToHex(b)).toBe(bytesToHex(f.plain.subarray(100, 200)))
    expect(f.calls).toEqual([
      [0, HEADER_LEN],
      [16_436, 32_836],
      [36, 16_436],
    ])
  })

  it('a hostile copy never poisons the cache for an honest copy of the same pack', async () => {
    const honest = await fixture()
    // Same packHash, but this copy serves a forged header (plaintextLen shrunk to match its length)
    const forged = new Uint8Array(honest.sealed)
    forged[5] = 10
    const hostile: RangeFetcher = async (start, end) => forged.subarray(start, end)
    const cache = new PackHeaderCache()
    await expect(
      readPackRange({ ...src(honest, 'hostile'), fetchRange: hostile }, 0, 1, honest.ring, cache),
    ).rejects.toEqual(new PackError('sealedPackCorrupt'))
    expect(cache.has(honest.hash, 'hostile')).toBe(false)
    const got = await readPackRange(src(honest, 'honest'), 0, 10, honest.ring, cache)
    expect(bytesToHex(got)).toBe(bytesToHex(honest.plain.subarray(0, 10)))
  })

  it('a header whose tags fail is never cached, and a corrupt copy is evicted', async () => {
    const f = await fixture()
    const cache = new PackHeaderCache()
    const bad = new Uint8Array(f.sealed)
    bad[HEADER_LEN + 3] = (bad[HEADER_LEN + 3] ?? 0) ^ 1
    const badFetch: RangeFetcher = async (start, end) => bad.subarray(start, end)
    await expect(readPackRange({ ...src(f), fetchRange: badFetch }, 0, 1, f.ring, cache)).rejects.toEqual(
      new PackError('sealedPackCorrupt'),
    )
    expect(cache.has(f.hash, 'copy-a')).toBe(false)
    await readPackRange(src(f), 0, 1, f.ring, cache)
    expect(cache.has(f.hash, 'copy-a')).toBe(true)
    // The same copy later serves a bad segment: its entry goes
    await expect(readPackRange({ ...src(f), fetchRange: badFetch }, 0, 1, f.ring, cache)).rejects.toEqual(
      new PackError('sealedPackCorrupt'),
    )
    expect(cache.has(f.hash, 'copy-a')).toBe(false)
  })

  it('a ranged read with a size mismatch or no key fails, caching nothing', async () => {
    const f = await fixture()
    const cache = new PackHeaderCache()
    await expect(readPackRange(src(f), 0, 1, new Map(), cache)).rejects.toEqual(new PackError('noKey'))
    await expect(readPackRange(src(f, 'copy-a', f.sealed.length + 1), 0, 1, f.ring, cache)).rejects.toEqual(
      new PackError('sealedPackCorrupt'),
    )
    expect(cache.has(f.hash, 'copy-a')).toBe(false)
  })

  it('a range past an unauthenticated header is corrupt bytes; a missing key stays noKey (L-10)', async () => {
    const f = await fixture()
    const cache = new PackHeaderCache()
    // Nothing decrypted under this header yet: asking past its plaintext means the bytes are wrong.
    await expect(readPackRange(src(f), 40_000, 40_010, f.ring, cache)).rejects.toEqual(new PackError('sealedPackCorrupt'))
    expect(cache.has(f.hash, 'copy-a')).toBe(false)
    // Authenticated once: the same request is the caller's mistake, not the copy's.
    await readPackRange(src(f), 0, 1, f.ring, cache)
    await expect(readPackRange(src(f), 40_000, 40_010, f.ring, cache)).rejects.toEqual(new PackError('outOfRange'))
    // An epoch this reader has no key for is Unreadable(NoKey) (§5.3), never tampering.
    await expect(readPackRange(src(f, 'copy-b'), 0, 1, new Map(), new PackHeaderCache())).rejects.toEqual(new PackError('noKey'))
  })

  it('streaming open yields segments that concatenate to the whole open', async () => {
    const { ring, plain, sealed, fetchRange } = await fixture()
    const whole = await openPack(sealed, sealed.length, ring)
    const fromBytes: Uint8Array[] = []
    for await (const seg of openPackStream(sealed, sealed.length, ring)) fromBytes.push(seg)
    const fromFetcher: Uint8Array[] = []
    for await (const seg of openPackStream(fetchRange, sealed.length, ring)) fromFetcher.push(seg)
    expect(fromBytes.map((s) => s.length)).toEqual([16_384, 16_384, 40_000 - 2 * 16_384])
    const join = (parts: Uint8Array[]) => bytesToHex(Uint8Array.from(parts.flatMap((p) => [...p])))
    expect(join(fromBytes)).toBe(bytesToHex(whole))
    expect(join(fromFetcher)).toBe(bytesToHex(plain))
  })

  it('streaming stops at the first bad segment, before yielding it', async () => {
    const { ring, sealed } = await fixture()
    const bad = new Uint8Array(sealed)
    const inSegment1 = HEADER_LEN + 16_400 + 3
    bad[inSegment1] = (bad[inSegment1] ?? 0) ^ 1
    const got: Uint8Array[] = []
    await expect(
      (async () => {
        for await (const seg of openPackStream(bad, bad.length, ring)) got.push(seg)
      })(),
    ).rejects.toEqual(new PackError('sealedPackCorrupt'))
    expect(got).toHaveLength(1)
  })
})

describe('TLV edge cases', () => {
  it('counts zero-length pattern records toward the 8-record cap', () => {
    const rec = (tag: number, v: string) => {
      const b = new TextEncoder().encode(v)
      return [tag, b.length >> 8, b.length & 0xff, ...b]
    }
    const eight = Uint8Array.from([...Array.from({ length: 7 }, () => rec(7, 'p')).flat(), ...rec(7, '')])
    expect(parseTlv(eight, { type: 'config', epoch: 0 }).protectedPatterns).toHaveLength(7)
    const nine = Uint8Array.from([...eight, ...rec(7, '')])
    expect(() => parseTlv(nine, { type: 'config', epoch: 0 })).toThrow(MalformedError)
  })

  it('refuses one trailing byte', () => {
    expect(() => parseTlv(hexToBytes('0200017800'), { type: 'review', epoch: 0 })).toThrow(MalformedError)
  })
})

describe('identities are bytes', () => {
  const ALICE = new Uint8Array(32).fill(0xa1)
  const BOB = new Uint8Array(32).fill(0xb0)

  it('privateId accepts hex and base58 and round-trips', () => {
    const b58 = base58Encode(ALICE)
    expect(bytesToHex(privateId(b58))).toBe(bytesToHex(ALICE))
    expect(bytesToHex(privateId(bytesToHex(ALICE).toUpperCase()))).toBe(bytesToHex(ALICE))
    expect(encodePrivateId(ALICE, 'base58')).toBe(b58)
    expect(encodePrivateId(ALICE)).toBe(bytesToHex(ALICE))
    expect(() => privateId('not an id')).toThrow()
  })

  it('compares ids as raw bytes, not as base58 strings', () => {
    const lo = new Uint8Array(32).fill(0x01)
    lo[0] = 0x00
    const hi = new Uint8Array(32).fill(0xff)
    expect(compareBytes(lo, hi)).toBeLessThan(0)
    // Leading zero bytes shorten the base58 string, so string order can disagree with byte order
    expect(base58Encode(lo).length).toBeLessThan(base58Encode(hi).length)
  })

  it('resolves epochs from base58 input with byte-ordered ties', async () => {
    const keys = await keysFor()
    const c0 = await sealDoc(keys, { type: 'config', ownerId: ALICE, epoch: 0 }, { defaultBranch: 'refs/heads/main' }, { anchor: true })
    // Two configs at the same height: the smaller id as raw bytes is the anchor
    const idLo = new Uint8Array(32).fill(0x0a)
    const idHi = new Uint8Array(32).fill(0x0b)
    const b58 = (b: Uint8Array) => privateId(base58Encode(b))
    const configs: ConfigRow[] = [
      { id: b58(idHi), owner: b58(ALICE), epoch: 0, createdAtBlockHeight: 10, enc: c0 },
      { id: b58(idLo), owner: b58(ALICE), epoch: 0, createdAtBlockHeight: 10, enc: c0 },
    ]
    const wraps: WrapRow[] = [
      { id: b58(idHi), owner: b58(ALICE), memberId: b58(BOB), epoch: 0, recipientKeyId: 4, keyEnabled: true, keys },
    ]
    const r = await resolveEpochs({
      repoId: REPO_ID,
      reader: b58(BOB),
      memberships: [
        { identity: b58(ALICE), role: 'maintainer' },
        { identity: b58(BOB), role: 'writer' },
      ],
      configs,
      wraps,
    })
    expect(encodePrivateId((r.anchors.get(0) as { id: Uint8Array }).id, 'base58')).toBe(base58Encode(idLo))
    expect([...r.keys.keys()]).toEqual([0])
    expect(r.members.has(BOB)).toBe(true)
    expect(r.repair?.missingWraps.map((m) => encodePrivateId(m, 'base58'))).toEqual([base58Encode(ALICE)])
  })

  it('dates stated(e): the earliest $createdAt of the epoch’s configs at the height its key was first stated (§16.3)', async () => {
    const keys = await keysFor()
    const c0 = await sealDoc(keys, { type: 'config', ownerId: ALICE, epoch: 0 }, { defaultBranch: 'refs/heads/main' }, { anchor: true })
    const b58 = (b: Uint8Array) => privateId(base58Encode(b))
    const row = (id: number, height: number, createdAt?: number): ConfigRow => ({
      id: b58(new Uint8Array(32).fill(id)),
      owner: b58(ALICE),
      epoch: 0,
      createdAtBlockHeight: height,
      enc: c0,
      ...(createdAt !== undefined ? { createdAt } : {}),
    })
    const resolve = (configs: ConfigRow[]) =>
      resolveEpochs({ repoId: REPO_ID, reader: b58(ALICE), memberships: [{ identity: b58(ALICE), role: 'maintainer' }], configs, wraps: [] })
    // a re-anchor later (height 20) does not move it
    const r = await resolve([row(2, 10, 5_000), row(1, 10, 4_000), row(3, 20, 9_000)])
    expect(r.anchors.get(0)?.statedAt).toBe(4_000)
    expect((await resolve([row(1, 10)])).anchors.get(0)?.statedAt).toBeUndefined()
  })
})

describe('doc hardening', () => {
  const ctx = async (): Promise<OpenContext> => ({
    keys: new Map([[0, await keysFor()]]),
    anchors: new Map([[0, { id: new Uint8Array(32).fill(0xc0), height: 10 }]]),
    members: new IdSet(),
  })

  it('refuses a number or epoch that is not a u32', async () => {
    const keys = await keysFor()
    await expect(sealDoc(keys, { ...ISSUE, number: 2 ** 32 }, { title: 't' })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealDoc(keys, { ...ISSUE, number: -1 }, { title: 't' })).rejects.toBeInstanceOf(MalformedError)
    await expect(sealDoc(keys, { ...ISSUE, number: 1.5 }, { title: 't' })).rejects.toBeInstanceOf(MalformedError)
    const enc = await sealDoc(keys, ISSUE, { title: 't' })
    expect(await openContent({ ...ISSUE, epoch: 2 ** 32, enc, createdAtBlockHeight: 50 }, await ctx())).toEqual({
      status: 'malformed',
    })
    expect(await openContent({ ...ISSUE, number: 2 ** 32, enc, createdAtBlockHeight: 50 }, await ctx())).toEqual({
      status: 'malformed',
    })
  })

  it('a document without a block height is malformed, never assumed early', async () => {
    const keys = await keysFor()
    const enc = await sealDoc(keys, ISSUE, { title: 't' })
    expect(await openContent({ ...ISSUE, enc }, await ctx())).toEqual({ status: 'malformed' })
  })
})
