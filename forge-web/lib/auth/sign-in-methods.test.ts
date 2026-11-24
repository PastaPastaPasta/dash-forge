import { describe, expect, it } from 'vitest'
import { signInMethods, type SignInContext } from './sign-in-methods'

const order = (ctx: Partial<SignInContext>): string[] =>
  signInMethods({ network: 'testnet', walletAvailable: true, walletV2: false, creating: false, ...ctx }).map(
    (m) => `${m.group}:${m.id}${m.recommended ? '*' : ''}`,
  )

describe('signInMethods', () => {
  it('testnet with App Connect v2: the wallet leads, and creating stays the newcomer\'s recommendation', () => {
    expect(order({ walletV2: true })).toEqual(['lead:wallet', 'new:create*', 'existing:passkey', 'existing:import', 'existing:dg', 'advanced:raw-key'])
  })

  it('without v2, or on a devnet: create is recommended, the wallet sits last among existing identities', () => {
    expect(order({})).toEqual(['new:create*', 'existing:passkey', 'existing:import', 'existing:dg', 'existing:wallet', 'advanced:raw-key'])
    expect(order({ network: 'devnet', walletV2: true })).toEqual(order({}))
  })

  it('mainnet with App Connect v2: the wallet leads and is recommended, newcomers get DashPay, and in-page create is under Other ways', () => {
    expect(order({ network: 'mainnet', walletV2: true })).toEqual([
      'lead:wallet*',
      'new:get-dashpay',
      'existing:passkey',
      'existing:import',
      'existing:dg',
      'other:create',
      'advanced:raw-key',
    ])
  })

  it('mainnet without v2: no wallet to finish in, so creating stays first and nothing sends newcomers to DashPay', () => {
    expect(order({ network: 'mainnet', walletV2: false })).toEqual(['new:create*', 'existing:passkey', 'existing:import', 'existing:dg', 'existing:wallet', 'advanced:raw-key'])
  })

  it('the sheet order per network, with v2 on offer: only mainnet sends newcomers to DashPay', () => {
    const newcomer = (network: SignInContext['network']): string[] => order({ network, walletV2: true }).filter((m) => m.startsWith('new:') || m.startsWith('other:'))
    expect(newcomer('mainnet')).toEqual(['new:get-dashpay', 'other:create'])
    expect(newcomer('testnet')).toEqual(['new:create*'])
    expect(newcomer('devnet')).toEqual(['new:create*'])
  })

  it('an unfinished creation comes first, and nothing is recommended meanwhile', () => {
    expect(order({ creating: true })).toEqual(['lead:resume-create', 'new:create', 'existing:passkey', 'existing:import', 'existing:dg', 'existing:wallet', 'advanced:raw-key'])
    expect(order({ network: 'mainnet', walletV2: true, creating: true })).toEqual([
      'lead:resume-create',
      'lead:wallet',
      'new:get-dashpay',
      'existing:passkey',
      'existing:import',
      'existing:dg',
      'other:create',
      'advanced:raw-key',
    ])
  })

  it('no wallet tile where no answer source exists', () => {
    expect(order({ walletAvailable: false })).not.toContain('existing:wallet')
    expect(order({ network: 'mainnet', walletV2: true, walletAvailable: false })[0]).toBe('new:create')
  })
})
