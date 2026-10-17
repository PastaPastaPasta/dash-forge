import { describe, expect, it } from 'vitest'

import { faucetHost, faucetUrls } from './faucets'

describe('faucetUrls', () => {
  it('testnet: the official faucet first, then faucet.thepasta.org (OD-12), whatever NEXT_PUBLIC_FORGE_DEV says', () => {
    expect(faucetUrls({ network: 'testnet', devnetName: null })).toEqual([
      'https://faucet.testnet.networks.dash.org',
      'https://faucet.thepasta.org',
    ])
  })

  it('devnet: the devnet’s own faucet', () => {
    expect(faucetUrls({ network: 'devnet', devnetName: 'sakura' })).toEqual(['https://faucet.sakura.networks.dash.org'])
    expect(faucetUrls({ network: 'devnet', devnetName: null })).toEqual([])
  })

  it('mainnet: none', () => {
    expect(faucetUrls({ network: 'mainnet', devnetName: null })).toEqual([])
  })

  it('names a link by its host', () => {
    expect(faucetHost('https://faucet.thepasta.org')).toBe('faucet.thepasta.org')
    expect(faucetHost('https://faucet.testnet.networks.dash.org/')).toBe('faucet.testnet.networks.dash.org')
  })
})
