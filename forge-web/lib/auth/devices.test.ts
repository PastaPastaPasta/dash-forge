// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { disableRefusal, keyRole, keyRows, readKeyLabels, writeKeyLabel } from './devices'
import type { WasmKey } from '../sdk/facade'

const forge = { core: 'C', collab: 'L', community: 'M', group: 'G' } as never
const key = (keyId: number, o: Partial<WasmKey> & { bounds?: { $type: string; id: string } } = {}): WasmKey =>
  ({
    keyId,
    purposeNumber: 0,
    securityLevelNumber: 2,
    validatePrivateKey: () => false,
    ...o,
    ...(o.bounds ? { contractBounds: { toJSON: () => o.bounds } } : {}),
  }) as WasmKey

describe('Devices & keys', () => {
  beforeEach(() => localStorage.clear())

  it('tells keys apart', () => {
    expect(keyRole(key(0, { securityLevelNumber: 0 }), forge)).toBe('master')
    expect(keyRole(key(4, { purposeNumber: 1, securityLevelNumber: 3 }), forge)).toBe('encryption')
    expect(keyRole(key(3, { purposeNumber: 3, securityLevelNumber: 1 }), forge)).toBe('transfer')
    expect(keyRole(key(5, { bounds: { $type: 'contractGroup', id: 'G' } }), forge)).toBe('forge')
    expect(keyRole(key(6, { bounds: { $type: 'singleContract', id: 'L' } }), forge)).toBe('forge-contract')
    expect(keyRole(key(7, { bounds: { $type: 'singleContract', id: 'X' } }), forge)).toBe('other')
    expect(keyRole(key(1), forge)).toBe('signing')
  })

  it('lists live keys first, newest first, with budgets and this browser marked', () => {
    const rows = keyRows(
      [key(1), key(5, { totalBudget: 100n, expiresAt: 9n, disabledAt: 3n }), key(6, { totalBudget: 100n, expiresAt: 9n })],
      new Map([[6, 40n]]),
      forge,
      6,
    )
    expect(rows.map((r) => r.keyId)).toEqual([6, 1, 5])
    expect(rows[0]).toMatchObject({ budgetLeft: 40n, budgetTotal: 100n, thisBrowser: true })
    expect(rows[2]?.disabledAt).toBe(3)
  })

  it('disables only what is safe to disable from here', () => {
    const [mine, other, master, enc, gone] = keyRows(
      [key(9), key(8), key(0, { securityLevelNumber: 0 }), key(4, { purposeNumber: 1 }), key(2, { disabledAt: 1n })],
      new Map(),
      forge,
      9,
    ).sort((a, b) => [9, 8, 0, 4, 2].indexOf(a.keyId) - [9, 8, 0, 4, 2].indexOf(b.keyId))
    expect(disableRefusal(mine!)).toMatch(/Revoke/)
    expect(disableRefusal(other!)).toBeNull()
    expect(disableRefusal(master!)).toMatch(/master/)
    expect(disableRefusal(enc!)).toMatch(/Private repos/)
    expect(disableRefusal(gone!)).toMatch(/Already/)
  })

  it('keeps labels in this browser, per identity', () => {
    writeKeyLabel('devnet', 'a', 5, '  work laptop  ')
    writeKeyLabel('devnet', 'a', 6, 'x'.repeat(60))
    expect(readKeyLabels('devnet', 'a')).toEqual({ 5: 'work laptop', 6: 'x'.repeat(40) })
    expect(readKeyLabels('devnet', 'b')).toEqual({})
    writeKeyLabel('devnet', 'a', 5, '')
    expect(readKeyLabels('devnet', 'a')).toEqual({ 6: 'x'.repeat(40) })
  })
})
