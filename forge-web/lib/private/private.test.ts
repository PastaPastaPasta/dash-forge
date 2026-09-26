/**
 * Unit tests for what the §11 vectors cannot cover: the production (randomized) seals,
 * non-extractability, the header cache and streaming reads.
 */

import { describe, expect, it } from 'vitest'

import { bytesToHex, constantTimeEqual, hexToBytes } from './bytes'
import { openContent, sealDoc, type OpenContext, type PrivateDoc } from './doc'
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
import { parseWrapPlaintext, WrapError, buildWrapPlaintext } from './wrap'
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
      anchors: new Map([[0, { id: 'c0', height: 10 }]]),
      members: new Set(),
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
    for (const name of ['sealDocWithNonce', 'sealPackWithFileId', 'hedgedFileId', 'hedgedNonce', 'sealPackWith', 'prepareDocSeal']) {
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
    const pt = buildWrapPlaintext(keys, K0)
    const opened = await parseWrapPlaintext(REPO_ID, 0, pt, keys.commit)
    expect(pt.every((b) => b === 0)).toBe(true)
    expect(bytesToHex(opened.commit)).toBe(bytesToHex(keys.commit))
    await expect(parseWrapPlaintext(REPO_ID, 0, buildWrapPlaintext(keys, K0), new Uint8Array(32))).rejects.toEqual(
      new WrapError('keyMismatch'),
    )
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

  it('the header cache fetches each header once per packHash', async () => {
    const { ring, plain, sealed, calls, fetchRange, hash } = await fixture()
    const cache = new PackHeaderCache()
    const a = await readPackRange(hash, sealed.length, 20_000, 20_100, ring, fetchRange, cache)
    const b = await readPackRange(hash, sealed.length, 100, 200, ring, fetchRange, cache)
    expect(bytesToHex(a)).toBe(bytesToHex(plain.subarray(20_000, 20_100)))
    expect(bytesToHex(b)).toBe(bytesToHex(plain.subarray(100, 200)))
    expect(cache.has(hash)).toBe(true)
    expect(calls.filter(([s, e]) => s === 0 && e === HEADER_LEN)).toHaveLength(1)
    expect(calls).toEqual([
      [0, HEADER_LEN],
      [16_436, 32_836],
      [36, 16_436],
    ])
  })

  it('a ranged read with a size mismatch or no key fails', async () => {
    const { sealed, fetchRange, hash } = await fixture()
    const cache = new PackHeaderCache()
    await expect(readPackRange(hash, sealed.length, 0, 1, new Map(), fetchRange, cache)).rejects.toEqual(new PackError('noKey'))
    const { ring } = await fixture()
    await expect(readPackRange(hash, sealed.length + 1, 0, 1, ring, fetchRange, cache)).rejects.toEqual(
      new PackError('sealedPackCorrupt'),
    )
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
