import { describe, expect, it } from 'vitest'
import { signInMethods, type SignInContext } from './sign-in-methods'

const order = (ctx: Partial<SignInContext>): string[] =>
  signInMethods({ network: 'testnet', walletAvailable: true, walletV2: false, creating: false, ...ctx }).map(
    (m) => `${m.group}:${m.id}${m.recommended ? '*' : ''}`,
  )

describe('signInMethods', () => {
  it('testnet today: create is recommended, the wallet sits last among existing identities', () => {
    expect(order({})).toEqual(['new:create*', 'existing:passkey', 'existing:import', 'existing:dg', 'existing:wallet', 'advanced:raw-key'])
    expect(order({ walletV2: true })).toEqual(order({}))
  })

  it('mainnet with App Connect v2: the wallet leads and is recommended', () => {
    expect(order({ network: 'mainnet', walletV2: true })).toEqual(['lead:wallet*', 'new:create', 'existing:passkey', 'existing:import', 'existing:dg', 'advanced:raw-key'])
    expect(order({ network: 'mainnet', walletV2: false })[0]).toBe('new:create*')
  })

  it('an unfinished creation comes first and takes the badge', () => {
    expect(order({ creating: true })).toEqual(['lead:resume-create', 'new:create', 'existing:passkey', 'existing:import', 'existing:dg', 'existing:wallet', 'advanced:raw-key'])
    expect(order({ network: 'mainnet', walletV2: true, creating: true }).slice(0, 2)).toEqual(['lead:resume-create', 'lead:wallet'])
  })

  it('no wallet tile where no answer source exists', () => {
    expect(order({ walletAvailable: false })).not.toContain('existing:wallet')
    expect(order({ network: 'mainnet', walletV2: true, walletAvailable: false })[0]).toBe('new:create')
  })
})
