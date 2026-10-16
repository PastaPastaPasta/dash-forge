/**
 * The /start test-network note (WEB-05): any build that is not mainnet says its DASH is test
 * money that can be reset, and names the faucets; mainnet has none.
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NETWORKS } from '@/lib/constants'
import { TestNetworkNote } from './test-network-note'

describe('TestNetworkNote', () => {
  it('testnet: free test money, both faucets in order, can be reset', () => {
    const html = renderToString(<TestNetworkNote config={NETWORKS.testnet} />)
    expect(html).toContain('data-testid="start-test-network"')
    expect(html).toContain('<strong>testnet</strong>')
    expect(html).toContain('free test money with no value')
    expect(html.indexOf('https://faucet.testnet.networks.dash.org')).toBeGreaterThan(-1)
    expect(html.indexOf('https://faucet.thepasta.org')).toBeGreaterThan(html.indexOf('https://faucet.testnet.networks.dash.org'))
    expect(html).toContain('the network can be reset')
  })

  it('devnet: its own faucet', () => {
    const html = renderToString(<TestNetworkNote config={{ ...NETWORKS.testnet, network: 'devnet', devnetName: 'sakura', key: 'devnet-sakura' }} />)
    expect(html).toContain('<strong>devnet sakura</strong>')
    expect(html).toContain('https://faucet.sakura.networks.dash.org')
    expect(html).not.toContain('thepasta')
  })

  it('mainnet: nothing', () => {
    expect(renderToString(<TestNetworkNote config={NETWORKS.mainnet} />)).toBe('')
  })
})
