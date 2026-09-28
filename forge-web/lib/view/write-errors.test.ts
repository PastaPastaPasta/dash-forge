/**
 * Refusal decoding and routing (D-007, D-042). The messages are the ones evo-sdk 4.2.0-beta.4
 * threw on moutai (2026-09-27): a refusal at broadcast arrives as a `WasmSdkError` of kind
 * Generic with `code: -1` and Drive's text, so the text is what identifies it.
 */

import { describe, expect, it } from 'vitest'

import { BusyWriteError, ConsensusRefusal, KeyUnusableError, SupersededWriteError, UnconfirmedWriteError, asConsensusRefusal } from '../sdk/write'
import { writeFailure } from './write-errors'

/** A wasm error as the SDK throws it: a plain object, `code` -1, the text in `message`. */
const wasm = (message: string, code = -1) => ({ name: 'Generic', kind: 18, code, message, isRetriable: false })

const BUDGET =
  'Failed to broadcast: Protocol error: Identity 9sBGBgYZHgGDbwQyDsMvugXXYUsxgrXmZfpCXwyRgYCB public key 5 has 1000000 credits of budget left, the state transition requires 48654000'
const BALANCE =
  'Failed to broadcast: Protocol error: Insufficient identity WMKY5YoDyspvT6k4S3XDcEoJqfbgfYDLpNBT8XNEY2x balance 21150520 required 67706240'

describe('asConsensusRefusal decodes the SDK text (D-007)', () => {
  it('reads a key-budget refusal with its figures', () => {
    const r = asConsensusRefusal(wasm(BUDGET))
    expect(r?.code).toBe(40218)
    expect(r?.isKeyLimit).toBe(true)
    expect(r?.unpaid).toBe(true)
    expect(r?.figures).toEqual({ remaining: 1_000_000n, required: 48_654_000n })
  })
  it('reads an insufficient-balance refusal with its figures', () => {
    const r = asConsensusRefusal(wasm(BALANCE))
    expect(r?.code).toBe(40210)
    expect(r?.isBalance).toBe(true)
    expect(r?.figures).toEqual({ balance: 21_150_520n, required: 67_706_240n })
  })
  it.each([
    ['Protocol error: Identity public key 8 has spent its whole budget and can no longer sign', 20015],
    ['Protocol error: Identity public key 8 expired at 1790491415877 ms and can no longer sign (block time 1790491500000 ms)', 20016],
    ['Protocol error: Identity public key 8 is expired at the block time: it expires at 1 ms and the block time is 2 ms', 40219],
    ['Protocol error: Identity key 8 is disabled', 20006],
    ['Protocol error: Current credits balance 10 is not enough to pay 20 fee', 30000],
    ['Protocol error: Document Abc has duplicate unique properties ["repoId", "number"] with other documents', 40105],
    ['Protocol error: referenced document Xyz not found for path repoId', 40120],
    ['Protocol error: Property body is 6000 bytes in UTF-8, over its maxBytes of 5120', 10421],
  ])('reads %s', (message, code) => {
    expect(asConsensusRefusal(wasm(message))?.code).toBe(code)
  })
  it('prefers a numeric code the error carries', () => {
    expect(asConsensusRefusal(wasm('duplicate unique properties', 40105))?.code).toBe(40105)
  })
  it('never reads a nonce refusal as a refusal: a rebroadcast of bytes that landed says the same', () => {
    const nonce =
      'Failed to broadcast: Protocol error: Identity X is trying to set an invalid identity nonce. The current identity nonce is 5, we are setting 5, error is nonce already present at tip'
    expect(asConsensusRefusal(wasm(nonce))).toBeNull()
    // A numeric code (a verdict from a block) still maps.
    expect(asConsensusRefusal(wasm('nonce', 40204))?.code).toBe(40204)
  })
  it('knows a refusal at broadcast charged nothing, and one from a block did', () => {
    expect(asConsensusRefusal(wasm(BUDGET))?.charged).toBe(false)
    expect(asConsensusRefusal(wasm('Protocol error: referenced document Xyz not found for path repoId'))?.feeCharged).toBe(false)
    expect(asConsensusRefusal(wasm('gate', 40120))?.feeCharged).toBe(true)
  })
  it('leaves transport failures and the rate-limit gate unclassified', () => {
    expect(asConsensusRefusal(wasm('no available addresses to use'))).toBeNull()
    expect(asConsensusRefusal(wasm("transport error: grpc error: code: 'Resource has been exhausted', message: \"rate limited\""))).toBeNull()
    expect(asConsensusRefusal(wasm("transport error: grpc error: code: 'The service is currently unavailable'"))).toBeNull()
    expect(asConsensusRefusal(new Error('fetch failed'))).toBeNull()
  })
})

describe('writeFailure routes each refusal to its fix, never "sent" (D-007)', () => {
  it('a key-budget refusal opens the key sheet with the shortfall', () => {
    const f = writeFailure(asConsensusRefusal(wasm(BUDGET)))
    expect(f.sheet).toEqual({ blocker: 'key-budget', shortfall: 47_654_000n })
    expect(f.message).toMatch(/does not have enough budget/)
    expect(f.message).toMatch(/Nothing was charged/)
    expect(f.message).not.toMatch(/Sent/)
  })
  it('a balance refusal opens the top-up sheet with the shortfall', () => {
    const f = writeFailure(asConsensusRefusal(wasm(BALANCE)))
    expect(f.sheet).toEqual({ blocker: 'balance', shortfall: 46_555_720n })
    expect(f.message).toMatch(/balance is too low/)
  })
  it('an expired or disabled key opens renew', () => {
    expect(writeFailure(new ConsensusRefusal(20016, 'expired')).sheet?.blocker).toBe('key-expiry')
    expect(writeFailure(new ConsensusRefusal(40208, 'disabled')).sheet?.blocker).toBe('key-disabled')
  })
  it('a nonce race says so plainly, with no sheet', () => {
    const f = writeFailure(new ConsensusRefusal(40204, 'nonce'))
    expect(f.sheet).toBeNull()
    expect(f.message).toMatch(/another write from this identity/)
  })
  it('a membership refusal is a clear error; charged only when it reached a block', () => {
    const inBlock = writeFailure(new ConsensusRefusal(40120, 'gate', {}, true))
    expect(inBlock.sheet).toBeNull()
    expect(inBlock.message).toMatch(/member/)
    expect(inBlock.message).toMatch(/fee was charged/)
    expect(writeFailure(new ConsensusRefusal(40120, 'gate', {}, false)).message).toMatch(/Nothing was charged/)
  })
  it('a used nonce that reached here unsettled reads as "another write went first", not raw text (N6)', () => {
    const f = writeFailure(new Error('Failed to broadcast: Protocol error: Identity X is trying to set an invalid identity nonce. nonce already present at tip'))
    expect(f.message).toMatch(/another write from this identity/)
    expect(f.sheet).toBeNull()
  })
  it('the request budget turning a write away says it may not have been sent', () => {
    const f = writeFailure(new BusyWriteError('X'))
    expect(f.message).toMatch(/may not have been sent/)
    expect(f.message).not.toMatch(/^Sent/)
  })
  it('only an unconfirmed write says "Sent, not yet visible"', () => {
    expect(writeFailure(new UnconfirmedWriteError('X')).message).toMatch(/^Sent, not yet visible/)
    expect(writeFailure(new SupersededWriteError('X')).message).toMatch(/earlier attempt was posted/)
  })
})

/**
 * The refusals protocol 14 adds (platform v4.2.0-beta.5): Drive's texts from rs-dpp
 * `document_expired_error.rs`, `document_contest_maximum_contenders_reached_error.rs` and
 * `serialized_object_parsing_error.rs` (#5007, #5029, #5011).
 */
const EXPIRED =
  'Failed to broadcast: Protocol error: Document 4ggxb4HBaT of type "issue" on contract 6DJ3px1Z expired at 1790491415877, its $createdAt plus the type\'s time to live, which block time 1790491500000 is not before'
const CONTEST_FULL = 'Failed to broadcast: Protocol error: The vote poll ContestedDocumentResourceVotePoll(dpns/domain) already has 1000 contenders, the most a contest accepts'
const TRAILING =
  'Failed to broadcast: Protocol error: Parsing of serialized object failed due to: platform deserialization error: unable to deserialize dpp::state_transition::StateTransition: 1 bytes left over after the value'

describe('protocol 14 refusals: expired, contest full, trailing bytes', () => {
  it.each([
    [EXPIRED, 40140],
    [CONTEST_FULL, 40141],
    [TRAILING, 10002],
  ])('decodes %s', (message, code) => {
    const r = asConsensusRefusal(wasm(message))
    expect(r?.code).toBe(code)
    expect(r?.feeCharged).toBe(false)
  })
  it('decodes the numeric codes a block verdict carries', () => {
    expect(asConsensusRefusal(wasm(EXPIRED, 40140))?.code).toBe(40140)
    expect(asConsensusRefusal(wasm(CONTEST_FULL, 40141))?.feeCharged).toBe(true)
    // Trailing bytes are refused unpaid, in a block too.
    expect(asConsensusRefusal(wasm(TRAILING, 10002))?.feeCharged).toBe(false)
  })
  it('an expired document says it can no longer be changed, with no sheet', () => {
    const f = writeFailure(new ConsensusRefusal(40140, 'expired', {}, true))
    expect(f.sheet).toBeNull()
    expect(f.message).toMatch(/has expired/)
    expect(f.message).toMatch(/fee was charged/)
    expect(f.message).not.toMatch(/consensus error/)
  })
  it('a full contest says so, with no sheet', () => {
    const f = writeFailure(asConsensusRefusal(wasm(CONTEST_FULL)))
    expect(f.sheet).toBeNull()
    expect(f.message).toMatch(/most contenders/)
    expect(f.message).toMatch(/Nothing was charged/)
  })
  it('trailing bytes ask for a re-sign and say the damaged write was discarded', () => {
    const f = writeFailure(asConsensusRefusal(wasm(TRAILING, 10002)))
    expect(f.sheet).toBeNull()
    expect(f.message).toMatch(/re-sign/)
    expect(f.message).toMatch(/discarded/)
    expect(f.message).toMatch(/Nothing was charged/)
  })
})

describe('an unusable key opens renew, not a raw error (D-042)', () => {
  it('routes an expired key to the renew sheet', () => {
    const f = writeFailure(new KeyUnusableError('expired'))
    expect(f.sheet).toEqual({ blocker: 'key-expiry' })
    expect(f.message).not.toMatch(/AUTHENTICATION/)
  })
  it('routes a disabled, missing or wrong-level key to the renew sheet, each with its reason', () => {
    expect(writeFailure(new KeyUnusableError('disabled')).sheet).toEqual({ blocker: 'key-disabled' })
    expect(writeFailure(new KeyUnusableError('missing')).sheet).toEqual({ blocker: 'key-missing' })
    expect(writeFailure(new KeyUnusableError('level')).sheet).toEqual({ blocker: 'key-level' })
    expect(writeFailure(new KeyUnusableError('level')).message).not.toMatch(/disabled/)
  })
})
