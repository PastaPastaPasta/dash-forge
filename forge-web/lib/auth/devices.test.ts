// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_KEYS_PER_UPDATE, boundsText, chunkKeyIds, disableRefusal, keyKindOf, keyRole, keyRows, otherKeysToDisable, readKeyLabels, writeKeyLabel } from './devices'
import type { WasmKey } from '../sdk/facade'

const forge = { core: 'C', collab: 'L', community: 'M', group: 'G' } as never
const key = (keyId: number, o: Partial<WasmKey> & { bounds?: { $type: string; id: string; documentTypeName?: string } } = {}): WasmKey =>
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
    expect(keyRole(key(8, { bounds: { $type: 'contractGroup', id: 'OTHER' } }), forge)).toBe('other')
    expect(keyRole(key(6, { bounds: { $type: 'singleContract', id: 'L' } }), forge)).toBe('forge-contract')
    expect(keyRole(key(7, { bounds: { $type: 'singleContract', id: 'X' } }), forge)).toBe('other')
    expect(keyRole(key(1), forge)).toBe('signing')
  })

  it('lists live keys first, newest first, with budgets and this browser marked', () => {
    const rows = keyRows(
      [key(1), key(5, { totalBudget: 100n, expiresAt: 9n, disabledAt: 3n }), key(6, { totalBudget: 100n, expiresAt: 9n })],
      new Map([[6, 40n]]),
      forge,
      [6],
    )
    expect(rows.map((r) => r.keyId)).toEqual([6, 1, 5])
    expect(rows[0]).toMatchObject({ budgetLeft: 40n, budgetTotal: 100n, thisBrowser: true })
    expect(rows[2]?.disabledAt).toBe(3)
  })

  it('disables only what is safe to disable from here', () => {
    const g = { bounds: { $type: 'contractGroup', id: 'G' } }
    const order = [9, 7, 8, 1, 0, 4, 2]
    const [mine, grant, other, wallet, master, enc, gone] = keyRows(
      [key(9, g), key(7, { bounds: { $type: 'singleContract', id: 'L' } }), key(8, g), key(1), key(0, { securityLevelNumber: 0 }), key(4, { purposeNumber: 1 }), key(2, { ...g, disabledAt: 1n })],
      new Map(),
      forge,
      [9, 7],
    ).sort((a, b) => order.indexOf(a.keyId) - order.indexOf(b.keyId))
    expect(disableRefusal(mine!)).toMatch(/Revoke/)
    expect(disableRefusal(grant!)).toMatch(/Revoke/)
    expect(disableRefusal(other!)).toBeNull()
    expect(disableRefusal(wallet!)).toMatch(/--force/)
    expect(disableRefusal(master!)).toMatch(/master/)
    expect(disableRefusal(enc!)).toMatch(/Lost a device/)
    expect(disableRefusal(gone!)).toMatch(/Already/)
  })

  it('"Disable all other keys" takes every AUTHENTICATION key but the master and the one in use', () => {
    const g = { bounds: { $type: 'contractGroup', id: 'G' } }
    const budget = { totalBudget: 100n, expiresAt: 9n }
    const rows = keyRows(
      [
        key(0, { securityLevelNumber: 0 }), // master: signs the update
        key(1), // the Android wallet's key: no bounds
        key(2, { bounds: { $type: 'singleContract', id: 'L' } }), // the iOS wallet's: a Forge contract, no budget
        key(3, { purposeNumber: 3, securityLevelNumber: 1 }), // transfer
        key(4, { purposeNumber: 1 }), // encryption
        key(5, { purposeNumber: 2 }), // decryption
        key(9, { ...g, ...budget }), // this browser's key
        key(10, { ...g, ...budget }),
        key(11, { bounds: { $type: 'documentType', id: 'C', documentTypeName: 'checkRun' } }), // a CI runner
        key(12, { ...g, ...budget, disabledAt: 1n }), // already disabled
        key(14, { bounds: { $type: 'contractGroup', id: 'OTHER' } }), // another app's
        key(15, { bounds: { $type: 'singleContract', id: 'X' } }),
      ],
      new Map(),
      forge,
      [9],
      9,
    )
    expect(otherKeysToDisable(rows).map((r) => r.keyId).sort((a, b) => a - b)).toEqual([1, 2, 10, 11, 14, 15])
    // with nothing else to disable, the button has nothing to offer
    expect(otherKeysToDisable(rows.filter((r) => [0, 3, 4, 5, 9, 12].includes(r.keyId)))).toEqual([])
  })

  it('tells a Forge limited key, a wallet sign-in, a runner key and another app apart (as dg does)', () => {
    const budget = { totalBudget: 100n }
    const kind = (o: Parameters<typeof key>[1]): string => keyKindOf(key(1, o), forge)
    expect(kind({ bounds: { $type: 'contractGroup', id: 'G' }, ...budget })).toBe('forge-limited')
    expect(kind(undefined)).toBe('wallet')
    expect(kind({ bounds: { $type: 'singleContract', id: 'L' } })).toBe('wallet')
    expect(kind({ bounds: { $type: 'contractGroup', id: 'G' } })).toBe('wallet')
    expect(kind({ bounds: { $type: 'documentType', id: 'C', documentTypeName: 'checkRun' }, ...budget })).toBe('ci-runner')
    expect(kind({ bounds: { $type: 'contractGroup', id: 'OTHER' }, ...budget })).toBe('other')
    expect(kind({ bounds: { $type: 'singleContract', id: 'X' } })).toBe('other')
    expect(kind({ bounds: { $type: 'documentType', id: 'X', documentTypeName: 'note' } })).toBe('other')
    // with no Forge deployment only an unbounded key is told apart
    expect(keyKindOf(key(1, { bounds: { $type: 'singleContract', id: 'L' } }), undefined)).toBe('other')
    expect(keyKindOf(key(1), undefined)).toBe('wallet')
  })

  it('shows the bounds in words', () => {
    const t = (o?: Parameters<typeof key>[1]): string => boundsText(key(1, o), forge)
    expect(t()).toBe('any contract')
    expect(t({ bounds: { $type: 'contractGroup', id: 'G' } })).toBe('Forge contract group')
    expect(t({ bounds: { $type: 'contractGroup', id: 'G2' } })).toBe('contract group G2')
    expect(t({ bounds: { $type: 'singleContract', id: 'L' } })).toBe('forge-collab')
    expect(t({ bounds: { $type: 'singleContract', id: 'X' } })).toBe('contract X')
    expect(t({ bounds: { $type: 'documentType', id: 'C', documentTypeName: 'checkRun' } })).toBe('checkRun documents of forge-core')
  })

  it('splits the keys into updates Platform accepts', () => {
    expect(MAX_KEYS_PER_UPDATE).toBe(10)
    expect(chunkKeyIds([])).toEqual([])
    expect(chunkKeyIds([1, 2, 3])).toEqual([[1, 2, 3]])
    const ids = Array.from({ length: 23 }, (_, i) => i + 1)
    expect(chunkKeyIds(ids).map((c) => c.length)).toEqual([10, 10, 3])
    expect(chunkKeyIds(ids).flat()).toEqual(ids)
    expect(chunkKeyIds([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
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
