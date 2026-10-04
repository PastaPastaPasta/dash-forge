import { describe, expect, it } from 'vitest'
import { comparable, editDistance, looksLike, skeleton } from './confusable'

describe('confusable skeletons (TS-24)', () => {
  it('folds what DPNS does not', () => {
    expect(skeleton('dashpay')).toBe(skeleton('dash-pay'))
    expect(skeleton('dashpay')).toBe(skeleton('DASHPAY'))
    expect(skeleton('myname')).toBe(skeleton('rnyname'))
    expect(skeleton('wallet')).toBe(skeleton('vvallet'))
    expect(skeleton('dash')).toBe(skeleton('clash'))
    expect(skeleton('dash')).toBe(skeleton('c1ash'))
    expect(skeleton('dash')).toBe(skeleton('ciash'))
    expect(skeleton('pool')).toBe(skeleton('p00l'))
    expect(skeleton('alice')).toBe(skeleton('a1ice'))
  })
})

describe('looksLike', () => {
  it('flags look-alikes and one-edit variants of longer names', () => {
    expect(looksLike('dashpay2', 'dashpay')).toBe(true)
    expect(looksLike('dash-pay', 'dashpay')).toBe(true)
    expect(looksLike('dashpya', 'dashpay')).toBe(false) // a swap is two edits
    expect(looksLike('dashpai', 'dashpay')).toBe(true)
    expect(looksLike('rnasternode', 'masternode')).toBe(true)
    expect(looksLike(comparable('dashpay2'), 'dashpay')).toBe(true)
  })

  it('leaves the same name and unrelated names alone', () => {
    expect(looksLike('dashpay', 'dashpay')).toBe(false)
    expect(looksLike('DashPay', 'dashpay')).toBe(false)
    expect(looksLike('alice', 'bob')).toBe(false)
    expect(looksLike('dash', 'dish')).toBe(false) // short names need an exact skeleton match
    expect(looksLike('', 'dash')).toBe(false)
  })

  it('counts the same name when asked (two repos may share one)', () => {
    expect(looksLike('dashcore', 'dashcore', true)).toBe(true)
    expect(looksLike('', '', true)).toBe(false)
  })
})

describe('editDistance', () => {
  it('counts insertions, deletions and substitutions, and stops past the cap', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('abc', 'abcdef', 1)).toBe(2)
  })
})
