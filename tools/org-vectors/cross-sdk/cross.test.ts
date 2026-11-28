import * as current from '@dashevo/evo-sdk'
import * as old from 'evo-sdk-503'
import { beforeAll, describe, expect, it } from 'vitest'

import { ALLOWED } from '../../../forge-web/lib/org/transition'
import { bytesOf, hexOf, readFixture } from './vectors'

type Sdk = typeof current
const SDKS: [Sdk, Sdk] = [old as unknown as Sdk, current]
const fixture = readFixture()

beforeAll(async () => {
  for (const m of SDKS) await m.EvoSDK.getLatestVersionNumber()
})

const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? hexOf(x) : typeof x === 'bigint' ? `${x}n` : x)))

const reading = (m: Sdk, unsigned: string) => {
  const st = m.StateTransition.fromBytes(bytesOf(unsigned))
  return { st, bytes: hexOf(st.toBytes()), signable: hexOf(st.getSignableBytes()), batch: plain(m.BatchTransition.fromStateTransition(st).toObject()) }
}

describe("each SDK reads the other's organization transitions", () => {
  for (const v of fixture.vectors) {
    it(`${v.label}: both decode and re-encode the same bytes, unsigned and signed`, () => {
      const [a, b] = SDKS
      const ra = reading(a, v.unsigned)
      const rb = reading(b, v.unsigned)
      expect(ra.bytes).toBe(v.unsigned)
      expect(rb.bytes).toBe(v.unsigned)
      expect(ra.signable).toBe(v.signable)
      expect(rb.signable).toBe(v.signable)
      expect(ra.batch).toEqual(rb.batch)

      ra.st.signature = new Uint8Array(96).fill(0xab)
      const signedByOld = hexOf(ra.st.toBytes())
      rb.st.signature = new Uint8Array(96).fill(0xab)
      expect(hexOf(rb.st.toBytes())).toBe(signedByOld)
      for (const m of SDKS) {
        const back = m.StateTransition.fromBytes(bytesOf(signedByOld))
        expect(hexOf(back.toBytes())).toBe(signedByOld)
        expect(hexOf(back.getSignableBytes())).toBe(v.signable)
      }
    })
  }

  it('covers every request type Forge signs', () => {
    const kinds = new Set(
      fixture.vectors.map((v) => {
        const d = v.intent['document'] as { documentType: string; action: string }
        return `${d.documentType}:${d.action}`
      }),
    )
    expect([...kinds].sort()).toEqual(Object.entries(ALLOWED).flatMap(([type, actions]) => actions.map((a) => `${type}:${a}`)).sort())
  })
})
