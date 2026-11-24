import { describe, expect, it } from 'vitest'
import { signInMethods, walletSignInReady, type SignInContext } from './sign-in-methods'

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

  it('no wallet tile where App Connect v2 is not on offer (no older code to fall back on)', () => {
    expect(order({ walletAvailable: false })).not.toContain('existing:wallet')
    expect(order({ network: 'mainnet', walletV2: true, walletAvailable: false })[0]).toBe('new:create')
  })

  // The sheet on each network, App Connect v2 being the only wallet sign-in. `walletAvailable`
  // follows `walletV2` once the chain was asked; it stays true without v2 only when Platform could
  // not be asked.
  describe('pins the sheet per network', () => {
    const offered = { walletAvailable: true, walletV2: true }
    const notOffered = { walletAvailable: false, walletV2: false }
    const unchecked = { walletAvailable: true, walletV2: false }
    const rest = ['existing:passkey', 'existing:import', 'existing:dg']

    it('mainnet', () => {
      expect(order({ network: 'mainnet', ...offered })).toEqual(['lead:wallet*', 'new:get-dashpay', ...rest, 'other:create', 'advanced:raw-key'])
      expect(order({ network: 'mainnet', ...notOffered })).toEqual(['new:create*', ...rest, 'advanced:raw-key'])
      expect(order({ network: 'mainnet', ...unchecked })).toEqual(['new:create*', ...rest, 'existing:wallet', 'advanced:raw-key'])
    })

    it('testnet', () => {
      expect(order({ network: 'testnet', ...offered })).toEqual(['lead:wallet', 'new:create*', ...rest, 'advanced:raw-key'])
      expect(order({ network: 'testnet', ...notOffered })).toEqual(['new:create*', ...rest, 'advanced:raw-key'])
      expect(order({ network: 'testnet', ...unchecked })).toEqual(['new:create*', ...rest, 'existing:wallet', 'advanced:raw-key'])
    })

    it('devnet: no released wallet answers, so the wallet never leads', () => {
      expect(order({ network: 'devnet', ...offered })).toEqual(['new:create*', ...rest, 'existing:wallet', 'advanced:raw-key'])
      expect(order({ network: 'devnet', ...notOffered })).toEqual(['new:create*', ...rest, 'advanced:raw-key'])
    })

    it('the recovery phrase or identity file, dg, raw key paste and in-page create stay on every network', () => {
      for (const network of ['mainnet', 'testnet', 'devnet'] as const) {
        for (const ctx of [offered, notOffered, unchecked]) {
          expect(order({ network, ...ctx }).map((m) => m.replace(/^\w+:|\*$/g, ''))).toEqual(expect.arrayContaining(['create', 'import', 'dg', 'raw-key']))
        }
      }
    })

    it('walletSignInReady: mainnet and testnet with v2 only', () => {
      expect(walletSignInReady('mainnet', true)).toBe(true)
      expect(walletSignInReady('testnet', true)).toBe(true)
      expect(walletSignInReady('devnet', true)).toBe(false)
      expect(walletSignInReady('testnet', false)).toBe(false)
    })
  })
})
