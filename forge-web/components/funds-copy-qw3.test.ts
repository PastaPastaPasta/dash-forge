// @vitest-environment jsdom
/**
 * QA wave 3 (bonsia), funds and key copy:
 * - QW3-008: deposit and top-up addresses carry a `dash:` payment URI (QR and wallet link).
 * - QW3-033: the key's budget reads the same everywhere, capped by a lower balance.
 * - QW3-034: forgetting a key says the top-up note stays, when there is one.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { idbPut, resetMemoryStores } from '@/lib/idb'
import { hasTopUpNote } from '@/lib/auth/identity-top-up'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { keyBudgetWords } from '@/lib/view/funds'
import { creditsAsDash } from '@/lib/view/format'
import { dashPaymentUri } from './ui/payment-address'
import { FORGET_CONFIRM, TOP_UP_NOTE_STAYS, forgetConfirm } from './keys-panel'

const ID = 'DhRR5hsXcwGikNuwSs43AF3VpRAdbRRLCiMK4FfDD6by'
const DASH = 100_000_000_000n

afterEach(() => resetMemoryStores())

describe('dashPaymentUri (QW3-008)', () => {
  it('is the BIP21-style URI Dash wallets open, with the amount in DASH', () => {
    expect(dashPaymentUri('yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4', 0.05)).toBe('dash:yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4?amount=0.05')
    expect(dashPaymentUri('yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4', 0.01)).toBe('dash:yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4?amount=0.01')
    expect(dashPaymentUri('yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4')).toBe('dash:yQ4q8Vg83hFerBDfqda6BxNyGh1VBxwRK4')
  })
})

describe('keyBudgetWords (QW3-033)', () => {
  const key = { remaining: DASH / 20n, total: DASH / 20n }
  it('says a lower balance caps the budget', () => {
    expect(keyBudgetWords(key, 512_100_000n, creditsAsDash)).toEqual({ left: '0.05 of 0.05 DASH', cap: 'capped by your 0.005121 DASH balance' })
  })
  it('says nothing more when the balance covers it, or for a key without a budget', () => {
    expect(keyBudgetWords(key, DASH * 19n, creditsAsDash)).toEqual({ left: '0.05 of 0.05 DASH', cap: null })
    expect(keyBudgetWords(key, null, creditsAsDash)?.cap).toBeNull()
    expect(keyBudgetWords({ remaining: null, total: null }, DASH, creditsAsDash)).toBeNull()
  })
})

describe('forgetConfirm (QW3-034)', () => {
  it('says the top-up note stays only when this browser topped the identity up', async () => {
    expect(await forgetConfirm(ID)).toEqual(FORGET_CONFIRM)
    await idbPut('journal', `top-up-next:${ACTIVE_NETWORK.network}:${ID}`, { index: 1 })
    expect(await hasTopUpNote(ACTIVE_NETWORK.network, ID)).toBe(true)
    const withNote = await forgetConfirm(ID)
    expect(withNote.body).toContain(FORGET_CONFIRM.body)
    expect(withNote.body).toContain(TOP_UP_NOTE_STAYS)
  })
})
