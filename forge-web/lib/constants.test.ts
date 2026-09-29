/**
 * Network resolution — which network a build targets and which forge-v2 contracts it reads.
 *
 * Precedence per field: NEXT_PUBLIC_* env > `forge-contracts/deployments/<key>.json` >
 * testnet default. A network without a deployment resolves to "not deployed", never to
 * another network's ids (parity with forge-core `network.rs`).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_NETWORK,
  NETWORKS,
  NotDeployedError,
  parseDapiAddresses,
  quorumEndpoint,
  requireForge,
  resolveNetworks,
} from './constants'
import { DEPLOYMENTS, forgeV2Ids, recordedDapiAddresses } from './deployments'
import { identityFileMatchesNetwork } from './auth/identity-file'

const DEPLOYMENTS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'deployments')

function onDisk(key: string): {
  v2: { forgeCore: { contractId: string }; forgeCollab: { contractId: string }; forgeCommunity?: { contractId: string }; contractGroupId: string }
} {
  return JSON.parse(readFileSync(resolve(DEPLOYMENTS_DIR, `${key}.json`), 'utf8'))
}

describe('deployments bundle', () => {
  it('bundles every file in forge-contracts/deployments/', () => {
    const keys = readdirSync(DEPLOYMENTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
    expect(Object.keys(DEPLOYMENTS).sort()).toEqual(keys)
  })
})

describe('resolveNetworks', () => {
  it('defaults to testnet, which has no forge-v2 deployment', () => {
    const { active, networks } = resolveNetworks({}, DEPLOYMENTS)
    expect(active).toBe('testnet')
    if (DEPLOYMENTS['testnet'] === undefined) expect(networks.testnet.v2).toBeNull()
  })

  it('never borrows another network\'s ids', () => {
    const { active, networks } = resolveNetworks({ network: 'mainnet', devnetName: '' }, DEPLOYMENTS)
    expect(active).toBe('mainnet')
    if (DEPLOYMENTS['mainnet'] === undefined) expect(networks.mainnet.v2).toBeNull()
    const moutai = resolveNetworks({ devnetName: 'moutai' }, DEPLOYMENTS).networks.devnet.v2
    expect(networks.mainnet.v2).not.toEqual(moutai)
  })

  it('resolves a named devnet from its deployment file', () => {
    const { active, networks } = resolveNetworks(
      { network: 'devnet', devnetName: 'moutai' },
      DEPLOYMENTS,
    )
    expect(active).toBe('devnet')
    expect(networks.devnet.key).toBe('devnet-moutai')
    expect(networks.devnet.devnetName).toBe('moutai')
    expect(networks.devnet.dapiAddresses).toHaveLength(10)
    expect(networks.devnet.dapiAddresses).toContain('https://68.67.122.84:1443')
  })

  it('exposes the forge-v2 ids devnet-moutai.json records, and none for testnet', () => {
    const file = onDisk('devnet-moutai')
    const { networks } = resolveNetworks({ devnetName: 'moutai' }, DEPLOYMENTS)
    expect(networks.devnet.v2).toEqual({
      core: file.v2.forgeCore.contractId,
      collab: file.v2.forgeCollab.contractId,
      community: file.v2.forgeCommunity?.contractId ?? file.v2.forgeCollab.contractId,
      group: file.v2.contractGroupId,
    })
    expect(networks.testnet.v2).toBeNull()
  })

  it('resolves devnet bonsia: its 13 DAPI nodes, quorum service and RC1 contracts', () => {
    const { active, networks } = resolveNetworks({ network: 'devnet', devnetName: 'bonsia' }, DEPLOYMENTS)
    expect(active).toBe('devnet')
    expect(networks.devnet.key).toBe('devnet-bonsia')
    expect(networks.devnet.dapiAddresses).toHaveLength(13)
    expect(networks.devnet.dapiAddresses).toContain('https://68.67.122.224:1443')
    expect(quorumEndpoint(networks.devnet)).toBe('https://quorums.bonsia.networks.dash.org')
    // The RC1 registration (with forge-core network.rs)
    expect(networks.devnet.v2).toMatchObject({ core: '6SbihK14KP8RhUpSH4Tc6WNvWKziWEoAbkNZmi7RadwJ', collab: 'H1H5VfTt2KWy1NhwEHoHuwYZGJm8eoetUCUt5xGNuZUp' })
  })

  it('treats a devnet name alone as devnet', () => {
    expect(resolveNetworks({ devnetName: 'moutai' }, DEPLOYMENTS).active).toBe('devnet')
  })

  it('lets NEXT_PUBLIC_DAPI_ADDRESSES beat the deployment file', () => {
    const { networks } = resolveNetworks(
      { network: 'devnet', devnetName: 'moutai', dapiAddresses: '10.0.0.1, 10.0.0.2:2443' },
      DEPLOYMENTS,
    )
    expect(networks.devnet.dapiAddresses).toEqual(['https://10.0.0.1:1443', 'https://10.0.0.2:2443'])
  })

  it('an unknown devnet has no addresses (SDK discovery) and no forge-v2 deployment', () => {
    const { networks } = resolveNetworks({ network: 'devnet', devnetName: 'paloma' }, DEPLOYMENTS)
    expect(networks.devnet.dapiAddresses).toEqual([])
    expect(networks.devnet.v2).toBeNull()
  })

  it('fails the build on a malformed network env', () => {
    expect(() => resolveNetworks({ network: 'moonnet' }, DEPLOYMENTS)).toThrow(/unknown NEXT_PUBLIC_NETWORK/)
    expect(() => resolveNetworks({ network: 'devnet' }, DEPLOYMENTS)).toThrow(/NEXT_PUBLIC_DEVNET_NAME/)
    expect(() => resolveNetworks({ devnetName: 'mainnet' }, DEPLOYMENTS)).toThrow(/invalid NEXT_PUBLIC_DEVNET_NAME/)
    expect(() => resolveNetworks({ devnetName: '-x' }, DEPLOYMENTS)).toThrow(/invalid NEXT_PUBLIC_DEVNET_NAME/)
  })
})

describe('module-level config (default build env)', () => {
  it('targets testnet by default', () => {
    expect(DEFAULT_NETWORK).toBe('testnet')
  })

  it('throws the actionable NotDeployedError for a network without forge-v2', () => {
    if (NETWORKS.mainnet.v2 !== null) return
    expect(() => requireForge('mainnet')).toThrow(NotDeployedError)
    expect(() => requireForge('mainnet')).toThrow(/forge-v2 is not deployed on mainnet/)
  })
})

describe('parseDapiAddresses', () => {
  it('normalizes host, host:port and full URLs', () => {
    expect(parseDapiAddresses('1.2.3.4')).toEqual(['https://1.2.3.4:1443'])
    expect(parseDapiAddresses('http://1.2.3.4:3000/')).toEqual(['http://1.2.3.4:3000'])
    expect(parseDapiAddresses(',, ,')).toEqual([])
    expect(() => parseDapiAddresses('https://host/path')).toThrow(/invalid DAPI address/)
  })
})

describe('quorumEndpoint', () => {
  it('names the endpoint the SDK is given, for every network kind', () => {
    const { networks } = resolveNetworks({ devnetName: 'moutai' }, DEPLOYMENTS)
    expect(quorumEndpoint(networks.testnet)).toBe('https://quorums.testnet.networks.dash.org')
    expect(quorumEndpoint(networks.mainnet)).toBe('https://quorums.mainnet.networks.dash.org')
    expect(quorumEndpoint(networks.devnet)).toBe('https://quorums.moutai.networks.dash.org')
    // A non-devnet build still resolves an (unnamed) devnet config, which has no endpoint.
    expect(quorumEndpoint(resolveNetworks({}, DEPLOYMENTS).networks.devnet)).toBe('')
  })

  it('honors NEXT_PUBLIC_QUORUM_URL on the active devnet only', () => {
    const env = { devnetName: 'moutai', quorumBaseUrl: 'https://quorums.example.org' }
    const { networks } = resolveNetworks(env, DEPLOYMENTS)
    expect(quorumEndpoint(networks.devnet)).toBe('https://quorums.example.org')
    expect(quorumEndpoint(networks.testnet)).toBe('https://quorums.testnet.networks.dash.org')
  })
})

describe('recordedDapiAddresses', () => {
  const v2 = { devnet: { addresses: ['https://10.0.0.9:1443'] } }

  it('falls back to v2.devnet.addresses only when the top-level list is absent', () => {
    expect(recordedDapiAddresses({ v2 })).toEqual(['https://10.0.0.9:1443'])
    expect(recordedDapiAddresses({ dapiAddresses: ['https://10.0.0.1:1443'], v2 })).toEqual([
      'https://10.0.0.1:1443',
    ])
    expect(recordedDapiAddresses({ dapiAddresses: [], v2 })).toEqual([])
    expect(recordedDapiAddresses(undefined)).toEqual([])
  })
})

describe('forgeV2Ids', () => {
  const full = {
    v2: {
      forgeCore: { contractId: 'C', status: 'registered' },
      forgeCollab: { contractId: 'L', status: 'registered' },
      contractGroupId: 'G',
    },
  }

  it('needs both contracts registered and the group recorded', () => {
    expect(forgeV2Ids(full)).toEqual({ core: 'C', collab: 'L', community: 'L', group: 'G' })
    // Three contracts: forge-community's own id; one still in flight is a half-finished deploy
    const three = { v2: { ...full.v2, forgeCommunity: { contractId: 'M', status: 'registered' } } }
    expect(forgeV2Ids(three)).toEqual({ core: 'C', collab: 'L', community: 'M', group: 'G' })
    expect(forgeV2Ids({ v2: { ...full.v2, forgeCommunity: { contractId: 'M', status: 'broadcasting' } } })).toBeNull()
    expect(forgeV2Ids({ v2: { ...full.v2, forgeCollab: { contractId: 'L', status: 'broadcasting' } } })).toBeNull()
    expect(forgeV2Ids({ v2: { ...full.v2, forgeCore: undefined } })).toBeNull()
    expect(forgeV2Ids({ v2: { ...full.v2, contractGroupId: '' } })).toBeNull()
    expect(forgeV2Ids({})).toBeNull()
    expect(forgeV2Ids(undefined)).toBeNull()
  })
})

describe('identityFileMatchesNetwork', () => {
  it('compares full network keys, so devnets are told apart', () => {
    expect(identityFileMatchesNetwork('devnet-moutai', 'devnet-moutai')).toBe(true)
    expect(identityFileMatchesNetwork('devnet-paloma', 'devnet-moutai')).toBe(false)
    expect(identityFileMatchesNetwork('testnet', 'devnet-moutai')).toBe(false)
    expect(identityFileMatchesNetwork('testnet', 'testnet')).toBe(true)
  })

  it('accepts an undeclared network and a bare devnet on any devnet build', () => {
    expect(identityFileMatchesNetwork(null, 'mainnet')).toBe(true)
    expect(identityFileMatchesNetwork('devnet', 'devnet-moutai')).toBe(true)
    expect(identityFileMatchesNetwork('devnet', 'testnet')).toBe(false)
  })
})
