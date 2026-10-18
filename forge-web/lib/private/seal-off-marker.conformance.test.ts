/** Shared vectors generated independently by tools/private-repos-vectors/seal_off_marker.py. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from './bytes'
import { activeSealOff, encodeSealOffMarker, parseSealOffMarker, sealOffDecision, type ActiveSealOff, type SealOffMarker, type SealOffConfig } from './convert'
import { openWithKey, sealDoc, TooLargeError } from './doc'
import { EpochKeys } from './keys'
import { sealDocWithNonce } from './testing'
import { encodeTlv, parseTlv } from './tlv'
import { drySealOffAnchor, anchorContent } from '../repo/members-anchor'

type Json = Record<string, unknown>
const root = resolve(process.cwd(), '../forge-contracts/vectors')
const files = readdirSync(root).filter((f) => f.startsWith('seal_off_marker__'))
const marker = (v: Json): SealOffMarker => ({ ...v, conversionId: hexToBytes(v.conversionId as string), startedAtMs: BigInt(v.startedAtMs as string) }) as SealOffMarker
const markerJson = (m: SealOffMarker | null): unknown => m === null ? null : ({ ...m, conversionId: bytesToHex(m.conversionId), startedAtMs: m.startedAtMs.toString() })
const activeJson = (a: ActiveSealOff): unknown => a.kind === 'active' ? { ...a, marker: markerJson(a.marker) } : a
const active = (v: Json): ActiveSealOff => (v.kind === 'active' ? { ...v, marker: v.marker === null ? null : marker(v.marker as Json) } : v) as ActiveSealOff
const raw = (offset: number) => Uint8Array.from({ length: 32 }, (_, i) => i + offset)

describe('seal-off marker shared vectors', () => {
  it('loads every shared vector', () => expect(files).toHaveLength(49))
  for (const file of files) {
    const vector = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as { name: string; input: Json; expected: Json }
    it(vector.name, async () => {
      const { input: i, expected: e } = vector
      switch (i.op) {
        case 'encoding': {
          const m = marker(i.marker as Json)
          const value = encodeSealOffMarker(m)
          expect(bytesToHex(value)).toBe(e.value)
          expect(parseSealOffMarker(value, m.boundaryEpoch)).toEqual(m)
          const fields = { defaultBranch: 'main', prevEpoch: m.boundaryEpoch - 1, prevEpochKey: raw(0), sealOff: value }
          const keys = await EpochKeys.import(new Uint8Array(32).fill(0x11), m.boundaryEpoch, raw(32))
          const doc = { type: 'config' as const, ownerId: new Uint8Array(32).fill(0x22), epoch: m.boundaryEpoch }
          const sealed = await sealDocWithNonce(keys, doc, fields, Uint8Array.from({ length: 12 }, (_, j) => j), { anchor: true })
          expect(bytesToHex(sealed.tlv) === e.tlv).toBe(true)
          expect(bytesToHex(sealed.enc) === e.enc).toBe(true)
          const opened = await openWithKey({ ...doc, enc: sealed.enc }, keys, true)
          expect(opened.status).toBe('readable')
          if (opened.status === 'readable') expect(opened.fields.sealOff).toEqual(value)
          return
        }
        case 'issue':
          expect(parseTlv(new Uint8Array([1, 0, 5, 84, 105, 116, 108, 101, 65, 0, 2, 1, 2]), { type: 'issue', epoch: 1 })).toEqual(e)
          return
        case 'rule': {
          const configs = (i.configs as Json[]).map((c) => ({ ...c, id: hexToBytes(c.id as string), owner: hexToBytes(c.owner as string), ...(c.sealOff !== undefined ? { sealOff: hexToBytes(c.sealOff as string) } : {}) })) as SealOffConfig[]
          expect(activeJson(activeSealOff(configs, hexToBytes(i.owner as string)))).toEqual(e)
          return
        }
        case 'decision':
          expect(sealOffDecision(i.recorded as number | null, active(i.active as Json), i.current as number | null, i.flipped as boolean, i.stated as number | null)).toEqual(e)
          return
        case 'size': {
          const m = marker(i.marker as Json)
          const settings = i.settings as { defaultBranch: string; protectedPatterns: string[] }
          const fields = anchorContent('private', { ...settings, backend: { mode: 0 }, archived: false }, { prevEpoch: 2, prevEpochKey: raw(0), skipEpochKey: raw(0) }, m).fields
          expect(encodeTlv(fields).length).toBe(e.tlvBytes)
          const keys = await EpochKeys.import(new Uint8Array(32).fill(0x11), m.boundaryEpoch, raw(32))
          const sealed = sealDoc(keys, { type: 'config', ownerId: new Uint8Array(32).fill(0x22), epoch: m.boundaryEpoch }, fields, { anchor: true })
          if (e.fits === true) expect((await sealed).length).toBe((e.tlvBytes as number) + 61)
          else await expect(sealed).rejects.toBeInstanceOf(TooLargeError)
          const dry = drySealOffAnchor(new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22), { ...settings, backend: { mode: 0 }, archived: false }, m)
          if (e.fits === true) await expect(dry).resolves.toBeUndefined()
          else await expect(dry).rejects.toBeInstanceOf(TooLargeError)
          return
        }
        default: throw new Error(`Unknown operation: ${String(i.op)}`)
      }
    })
  }
})

it('notice pointers resolve only to the confirmed owner marker', async () => {
  const { sealOffNoticeFor, confirmsSealOffNotice } = await import('./convert')
  const m: SealOffMarker = { mode: 'everything', conversionId: new Uint8Array(16).fill(1), boundaryEpoch: 3, startedAtMs: 123n, replacesEpoch: 1 }
  const a: ActiveSealOff = { kind: 'active', epoch: 3, highestEpoch: 3, replacesThrough: null, height: 10, marker: m }
  expect(sealOffNoticeFor(a, new Uint8Array(16).fill(2))).toBeNull()
  const notice = sealOffNoticeFor(a, m.conversionId)!
  expect(notice.replacesEpoch).toBe(1)
  expect(confirmsSealOffNotice(a, notice)).toBe(true)
  expect(confirmsSealOffNotice({ kind: 'unknown' }, notice)).toBe(false)
  expect(confirmsSealOffNotice(a, { ...notice, conversionId: new Uint8Array(16).fill(2) })).toBe(false)
})

function concurrentOwnerConfigs(): SealOffConfig[] {
  return [1, 2, 3].map((epoch) => ({ id: new Uint8Array(32).fill(epoch), owner: raw(0), epoch, private: true, height: epoch,
    opening: 'opened', sealOff: encodeSealOffMarker({ mode: 'codeOnly', conversionId: new Uint8Array(16), boundaryEpoch: epoch, startedAtMs: 1n, ...(epoch === 3 ? { replacesEpoch: 2 } : {}) }) }))
}
it('start-over sets aside all prior concurrent owner runs', () => {
  expect(activeSealOff(concurrentOwnerConfigs(), raw(0))).toMatchObject({ kind: 'active', epoch: 3 })
})
it('a stale record on another device adopts the replacement', () => {
  expect(sealOffDecision(1, activeSealOff(concurrentOwnerConfigs(), raw(0)), 3, false, null)).toEqual({ kind: 'adopt', epoch: 3 })
})
