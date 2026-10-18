import { describe, expect, it } from 'vitest'
import type { Network } from '../constants'
import { fiatText, formatFiat, type FiatKind } from './format'
import type { Currency } from './providers'
import vectors from './vectors.json'

describe('shared fiat golden vectors', () => {
  for (const vector of vectors) {
    it(JSON.stringify(vector), () => {
      expect(fiatText(vector.amount, { ...vector, currency: vector.currency as Currency, kind: vector.kind as FiatKind, network: vector.network as Network })).toBe(vector.expected)
    })
  }
  it.each([NaN, Infinity, -Infinity])('never formats a non-finite amount or rate (%s)', (number) => {
    expect(formatFiat(number, 'USD')).toBeNull()
    expect(fiatText(number, { network: 'mainnet', rate: 40, currency: 'USD' })).toBeNull()
    expect(fiatText(1, { network: 'mainnet', rate: number, currency: 'USD' })).toBeNull()
  })
  it('rejects overflowing products, unavailable rates and invalid ranges', () => {
    expect(fiatText(Number.MAX_VALUE, { network: 'mainnet', rate: 40, currency: 'USD' })).toBeNull()
    expect(fiatText(1, { network: 'mainnet', rate: undefined, currency: 'USD' })).toBeNull()
    for (const range of [NaN, Infinity, -1, 2]) {
      expect(fiatText(1, { range, network: 'mainnet', rate: 40, currency: 'USD' })).toBeNull()
    }
  })
})
