import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PINNED_WASM_SDK, trueCodeOf } from './consensus-shift'
import { asConsensusRefusal, ConsensusRefusal, UNREADABLE_REFUSAL_CODE } from './write'
import { writeFailure } from '../view/write-errors'

/** A CheckTx refusal as the pinned SDK hands it over: its own decoded text, code -1. */
const wasm = (message: string) => ({ name: 'Protocol', kind: 3, code: -1, message, isRetriable: false })

/**
 * The texts wasm-sdk 4.2.0-beta.5 renders for errors a beta.6 node sent (platform#5053), each
 * measured by serializing the error with rs-dpp v4.2.0-beta.6 and decoding it with the pinned
 * wasm `ConsensusError.deserialize`; the first also live on moutai (a checkRun `completed`
 * without a conclusion, refused by `conclusionIfDone`).
 */
const SHIFTED_TEXTS: ReadonlyArray<readonly [sent: number, rendered: string]> = [
  [10422, 'Failed to broadcast: Protocol error: Property checkRun is 16 bytes in UTF-8, over its maxBytes of 99'],
  [10421, "Failed to broadcast: Protocol error: The moderation charter's reward split of 5% to the leader, 116% equally and 105% by action count sums to 226%, it must sum to 100%"],
  [10419, 'Failed to broadcast: Protocol error: The documents a contract moderation reason cites are invalid: follow'],
]

describe('platform#5053: the pinned SDK decodes a beta.6 error one variant off', () => {
  it('pins the same wasm-sdk as package.json, so the remap is dropped with the bump', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@dashevo/wasm-sdk']).toBe(PINNED_WASM_SDK)
  })

  it('maps each decoded code back to the one the node sent, one to one', () => {
    expect(trueCodeOf(10421)).toBe(10422)
    expect(trueCodeOf(11001)).toBe(10421)
    expect(trueCodeOf(10904)).toBe(10419)
    expect(trueCodeOf(10419)).toBe(10420)
    expect(trueCodeOf(10422)).toBe(10828)
    // Outside positions 140–199 nothing moves
    for (const code of [10002, 10417, 20014, 40105, 40120, 40140, 40218, 30000]) expect(trueCodeOf(code)).toBe(code)
  })

  it.each(SHIFTED_TEXTS)('a %i refused at the broadcast check is classified as what the node sent', (sent, rendered) => {
    const r = asConsensusRefusal(wasm(rendered))
    expect(r?.code).toBe(sent)
    expect(r?.feeCharged).toBe(false)
  })

  it('a rule refusal is no longer told as "a field is longer than the contract allows"', () => {
    const f = writeFailure(asConsensusRefusal(wasm(SHIFTED_TEXTS[0]![1])))
    expect(f.message).toMatch(/breaks one of the contract's rules/)
    expect(f.message).not.toMatch(/longer than the contract allows/)
  })

  it('a real maxBytes refusal still says the field is too long', () => {
    expect(writeFailure(asConsensusRefusal(wasm(SHIFTED_TEXTS[1]![1]))).message).toMatch(/longer than the contract allows/)
  })

  it('a 10420 or 10424 the pinned SDK cannot decode is a refusal with an unknown reason, not a lost answer', () => {
    // Measured: the beta.6 payloads do not fit the variant the old order puts there
    for (const tail of ['UnexpectedEnd { additional: 18 }', 'UnexpectedVariant { type_name: "BasicError", allowed: Range { min: 0, max: 199 }, found: 200 }']) {
      const r = asConsensusRefusal(wasm(`Failed to broadcast: Protocol error: platform deserialization error: unable to deserialize ConsensusError: ${tail}`))
      expect(r).toBeInstanceOf(ConsensusRefusal)
      expect(r?.code).toBe(UNREADABLE_REFUSAL_CODE)
      expect(r?.feeCharged).toBe(false)
      const f = writeFailure(r)
      expect(f.message).toMatch(/could not read the reason/)
      expect(f.message).toMatch(/Nothing was charged/)
      expect(f.message).not.toMatch(/^Sent/)
    }
  })

  it("keeps the node's own code on a result-wait verdict (never remapped)", () => {
    const coded = { ...wasm('state transition broadcast error: Property checkRun is 16 bytes in UTF-8, over its maxBytes of 99'), code: 10421 }
    expect(asConsensusRefusal(coded)?.code).toBe(10421)
    expect(asConsensusRefusal({ ...coded, code: 10422 })?.code).toBe(10422)
  })
})
