import { describe, expect, it } from 'vitest'
import { signInMethods, walletSignInReady, type SignInContext } from './sign-in-methods'

const order = (ctx: Partial<SignInContext>): string[] =>
  signInMethods({ network: 'testnet', walletAvailable: true, walletV2: false, creating: false, ...ctx }).map(
    (m) => `${m.group}:${m.id}${m.recommended ? '*' : ''}`,
  )

describe('signInMethods', () => {
  it('testnet with App Connect v2: the wallet (recommended) and the passkey show; everything else is under Other ways', () => {
    expect(order({ walletV2: true })).toEqual(['primary:wallet*', 'primary:passkey', 'more:import', 'more:dg', 'more:create', 'advanced:raw-key'])
  })

  it('without v2, or on a devnet: creating (recommended) shows beside the passkey, the wallet is under Other ways', () => {
    expect(order({})).toEqual(['primary:create*', 'primary:passkey', 'more:import', 'more:dg', 'more:wallet', 'advanced:raw-key'])
    expect(order({ network: 'devnet', walletV2: true })).toEqual(order({}))
  })

  it('mainnet with App Connect v2: the wallet and the passkey show; Get DashPay leads Other ways; every recovery-phrase path is under Advanced', () => {
    expect(order({ network: 'mainnet', walletV2: true })).toEqual([
      'primary:wallet*',
      'primary:passkey',
      'more:get-dashpay',
      'advanced:import',
      'more:dg',
      'advanced:create',
      'advanced:raw-key',
    ])
  })

  it('mainnet without v2: no wallet to finish in, so creating shows and nothing sends newcomers to DashPay', () => {
    expect(order({ network: 'mainnet', walletV2: false })).toEqual(['primary:create*', 'primary:passkey', 'advanced:import', 'more:dg', 'more:wallet', 'advanced:raw-key'])
  })

  it('at most two choices show where the wallet leads', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      expect(order({ network, walletV2: true }).filter((m) => m.startsWith('primary:'))).toEqual(['primary:wallet*', 'primary:passkey'])
    }
  })

  it('an unfinished creation comes first, and nothing is recommended meanwhile', () => {
    expect(order({ creating: true })).toEqual(['primary:resume-create', 'primary:create', 'primary:passkey', 'more:import', 'more:dg', 'more:wallet', 'advanced:raw-key'])
    expect(order({ network: 'mainnet', walletV2: true, creating: true })).toEqual([
      'primary:resume-create',
      'primary:wallet',
      'primary:passkey',
      'more:get-dashpay',
      'advanced:import',
      'more:dg',
      'advanced:create',
      'advanced:raw-key',
    ])
  })

  it('no wallet tile where App Connect v2 is not on offer (no older code to fall back on)', () => {
    expect(order({ walletAvailable: false })).not.toContain('more:wallet')
    expect(order({ network: 'mainnet', walletV2: true, walletAvailable: false })[0]).toBe('primary:create*')
  })

  describe('pins the sheet per network', () => {
    const offered = { walletAvailable: true, walletV2: true }
    const notOffered = { walletAvailable: false, walletV2: false }
    const unchecked = { walletAvailable: true, walletV2: false }
    const rest = ['more:import', 'more:dg']

    it('mainnet', () => {
      const main = ['advanced:import', 'more:dg']
      expect(order({ network: 'mainnet', ...offered })).toEqual(['primary:wallet*', 'primary:passkey', 'more:get-dashpay', ...main, 'advanced:create', 'advanced:raw-key'])
      expect(order({ network: 'mainnet', ...notOffered })).toEqual(['primary:create*', 'primary:passkey', ...main, 'advanced:raw-key'])
      expect(order({ network: 'mainnet', ...unchecked })).toEqual(['primary:create*', 'primary:passkey', ...main, 'more:wallet', 'advanced:raw-key'])
    })

    it('testnet', () => {
      expect(order({ network: 'testnet', ...offered })).toEqual(['primary:wallet*', 'primary:passkey', ...rest, 'more:create', 'advanced:raw-key'])
      expect(order({ network: 'testnet', ...notOffered })).toEqual(['primary:create*', 'primary:passkey', ...rest, 'advanced:raw-key'])
      expect(order({ network: 'testnet', ...unchecked })).toEqual(['primary:create*', 'primary:passkey', ...rest, 'more:wallet', 'advanced:raw-key'])
    })

    it('devnet: no released wallet answers, so the wallet never leads', () => {
      expect(order({ network: 'devnet', ...offered })).toEqual(['primary:create*', 'primary:passkey', ...rest, 'more:wallet', 'advanced:raw-key'])
      expect(order({ network: 'devnet', ...notOffered })).toEqual(['primary:create*', 'primary:passkey', ...rest, 'advanced:raw-key'])
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
