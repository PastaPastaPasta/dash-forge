import { describe, expect, it } from 'vitest'

import { otherNetworkSite, siteOrigin, siteUrlFor } from './network-sites'

const registered = { status: 'registered', contractId: 'x' }
const live = { v2: { forgeCore: registered, forgeCollab: registered, forgeCommunity: registered, contractGroupId: 'g' } }
const sites = { mainnet: 'https://forge.example', testnet: 'https://testnet-forge.example' }

describe('siteOrigin', () => {
  it('keeps an https origin, with or without a trailing slash', () => {
    expect(siteOrigin('https://forge.example')).toBe('https://forge.example')
    expect(siteOrigin(' https://forge.example/ ')).toBe('https://forge.example')
    expect(siteOrigin('https://forge.example:8443')).toBe('https://forge.example:8443')
  })

  it('ignores anything else', () => {
    for (const raw of [undefined, '', '  ', 'forge.example', 'http://forge.example', 'https://forge.example/app', 'https://forge.example/?x=1', 'https://forge.example/#x', 'https://u:p@forge.example', 'javascript:alert(1)']) {
      expect(siteOrigin(raw)).toBeNull()
    }
  })
})

describe('siteUrlFor', () => {
  it('names the mainnet and testnet sites, nothing for a devnet', () => {
    expect(siteUrlFor('mainnet', sites)).toBe('https://forge.example')
    expect(siteUrlFor('testnet', sites)).toBe('https://testnet-forge.example')
    expect(siteUrlFor('devnet-sakura', sites)).toBeNull()
    expect(siteUrlFor('mainnet', { mainnet: null, testnet: null })).toBeNull()
  })
})

describe('otherNetworkSite', () => {
  it('points a mainnet build at the testnet site', () => {
    expect(otherNetworkSite({ network: 'mainnet' }, sites, {})).toEqual({ key: 'testnet', url: 'https://testnet-forge.example', host: 'testnet-forge.example' })
    expect(otherNetworkSite({ network: 'mainnet' }, { ...sites, testnet: null }, {})).toBeNull()
  })

  it('points a test network at the mainnet site only once Forge is live there', () => {
    expect(otherNetworkSite({ network: 'testnet' }, sites, { mainnet: {} })).toBeNull()
    expect(otherNetworkSite({ network: 'testnet' }, sites, {})).toBeNull()
    expect(otherNetworkSite({ network: 'testnet' }, sites, { mainnet: { v2: { forgeCore: registered } } })).toBeNull()
    expect(otherNetworkSite({ network: 'testnet' }, sites, { mainnet: live })).toEqual({ key: 'mainnet', url: 'https://forge.example', host: 'forge.example' })
    expect(otherNetworkSite({ network: 'devnet' }, sites, { mainnet: live })?.key).toBe('mainnet')
    expect(otherNetworkSite({ network: 'testnet' }, { ...sites, mainnet: null }, { mainnet: live })).toBeNull()
  })

  it('is off when no site URL is configured for this build', () => {
    expect(otherNetworkSite({ network: 'testnet' })).toBeNull()
    expect(otherNetworkSite({ network: 'mainnet' })).toBeNull()
  })
})
