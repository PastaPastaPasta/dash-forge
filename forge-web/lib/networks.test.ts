import { describe, expect, it } from 'vitest'

import { DEPLOYMENTS } from './deployments'
import { networkRows } from './networks'

const registered = { status: 'registered', contractId: 'x' }
const live = { v2: { forgeCore: registered, forgeCollab: registered, forgeCommunity: registered, contractGroupId: 'g' } }

describe('networkRows', () => {
  it('lists live networks first, then those not deployed yet, then retired devnets', () => {
    const rows = networkRows({
      mainnet: {},
      'devnet-old': { ...live, retired: true },
      testnet: {},
      'devnet-new': live,
    })
    expect(rows.map((r) => [r.label, r.standing, r.test])).toEqual([
      ['Devnet new', 'live', true],
      ['Testnet', 'not-yet', true],
      ['Mainnet', 'not-yet', false],
      ['Devnet old', 'retired', true],
    ])
  })

  it('counts a half-finished deploy as not deployed', () => {
    const rows = networkRows({ testnet: { v2: { forgeCore: registered } } })
    expect(rows[0]?.standing).toBe('not-yet')
  })

  it('has a row for every bundled deployment file', () => {
    expect(networkRows().map((r) => r.key).sort()).toEqual(Object.keys(DEPLOYMENTS).sort())
  })
})
