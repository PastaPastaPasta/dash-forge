/**
 * The network badge (WEB-17): a testnet build is flagged like a devnet, in the caution color,
 * and its tooltip says the funds are test money; mainnet shows nothing in the header.
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NETWORKS } from '@/lib/constants'
import { NetworkBadge, networkBadgeTitle } from './network-badge'

const DEPLOYED = { v2: { forge: 'x' } as never }

describe('NetworkBadge', () => {
  it('testnet: caution color and a test-money tooltip', () => {
    const html = renderToString(<NetworkBadge config={{ ...NETWORKS.testnet, ...DEPLOYED }} />)
    expect(html).toContain('bg-caution/10')
    expect(html).toContain('test money')
    expect(html).toContain('testnet')
  })

  it('titles', () => {
    expect(networkBadgeTitle(NETWORKS.testnet)).toBe('testnet: a test network. Its DASH is free test money and it can be reset.')
    expect(networkBadgeTitle({ ...NETWORKS.testnet, network: 'devnet', devnetName: 'sakura', key: 'devnet-sakura' })).toBe(
      'devnet sakura: a test network. Its DASH is free test money and it can be reset.',
    )
    expect(networkBadgeTitle(NETWORKS.mainnet)).toBe('Connected to mainnet.')
  })

  it('mainnet: no badge unless asked for', () => {
    expect(renderToString(<NetworkBadge config={NETWORKS.mainnet} />)).toBe('')
    expect(renderToString(<NetworkBadge config={NETWORKS.mainnet} always />)).toContain('mainnet')
  })
})
