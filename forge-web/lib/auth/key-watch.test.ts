// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { acknowledgeKeys, checkKeys, forgetKeySnapshot, keyKind, newKeysSince, type WatchedKey } from './key-watch'

const k = (keyId: number, o: Partial<WatchedKey> = {}): WatchedKey => ({ keyId, purpose: 0, level: 2, disabled: false, ...o })

describe('new-key alert', () => {
  beforeEach(() => localStorage.clear())

  it('says nothing on the first look, and records what it saw', () => {
    expect(checkKeys('devnet', 'id', [k(0, { level: 0 }), k(5)], [5])).toEqual([])
    expect(checkKeys('devnet', 'id', [k(0, { level: 0 }), k(5)], [5])).toEqual([])
  })

  it('names a live key this device did not add, until it is acknowledged', () => {
    checkKeys('devnet', 'id', [k(0, { level: 0 }), k(5)], [5])
    const keys = [k(0, { level: 0 }), k(5), k(6), k(7, { disabled: true })]
    expect(checkKeys('devnet', 'id', keys, [5]).map((x) => x.keyId)).toEqual([6])
    // Still there after a reload: the snapshot only moves on once seen.
    expect(checkKeys('devnet', 'id', keys, [5]).map((x) => x.keyId)).toEqual([6])
    acknowledgeKeys('devnet', 'id', [6])
    expect(checkKeys('devnet', 'id', keys, [5])).toEqual([])
  })

  it("never names this device's own keys, nor another identity's or network's snapshot", () => {
    checkKeys('devnet', 'id', [k(5)], [5])
    expect(checkKeys('devnet', 'id', [k(5), k(8)], [8])).toEqual([])
    expect(checkKeys('testnet', 'id', [k(9)], [])).toEqual([])
    expect(checkKeys('devnet', 'other', [k(9)], [])).toEqual([])
    forgetKeySnapshot('devnet', 'id')
    expect(checkKeys('devnet', 'id', [k(5), k(10)], [])).toEqual([])
  })

  it('never starts a snapshot from an acknowledgement', () => {
    acknowledgeKeys('devnet', 'id', [9])
    expect(checkKeys('devnet', 'id', [k(0, { level: 0 }), k(5), k(9)], [9])).toEqual([])
    expect(checkKeys('devnet', 'id', [k(0, { level: 0 }), k(5), k(9)], [9])).toEqual([])
  })

  it('compares against nothing when there is no snapshot', () => {
    expect(newKeysSince(null, [k(1)], [])).toEqual([])
    expect(newKeysSince([1], [k(1), k(2)], []).map((x) => x.keyId)).toEqual([2])
  })

  it('words keys plainly', () => {
    expect(keyKind({ purpose: 0, level: 0 })).toBe('master key')
    expect(keyKind({ purpose: 0, level: 2 })).toBe('high signing key')
    expect(keyKind({ purpose: 1, level: 3 })).toBe('medium encryption key')
  })
})
