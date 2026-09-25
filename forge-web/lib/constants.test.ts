/**
 * Network resolution — which network a build targets and which registry it reads.
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
  requireRegistryContractId,
  resolveNetworks,
} from './constants'
import { DEPLOYMENTS, forgeV2Ids, recordedDapiAddresses } from './deployments'
import { identityFileMatchesNetwork } from './auth/identity-file'

const DEPLOYMENTS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'deployments')

function onDisk(key: string): { registry?: { contractId?: string | null } } {
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
  it('defaults to testnet with the registry from testnet.json', () => {
    const { active, networks } = resolveNetworks({}, DEPLOYMENTS)
    expect(active).toBe('testnet')
    expect(networks.testnet.registryContractId).toBe(onDisk('testnet').registry?.contractId)
    expect(networks.testnet.registrySource).toBe('forge-contracts/deployments/testnet.json')
  })

  it('never borrows testnet ids for mainnet', () => {
    const { active, networks } = resolveNetworks({ network: 'mainnet' }, DEPLOYMENTS)
    expect(active).toBe('mainnet')
    if (DEPLOYMENTS['mainnet'] === undefined) {
      expect(networks.mainnet.registryContractId).toBeNull()
      expect(networks.mainnet.registrySource).toBeNull()
    }
    expect(networks.mainnet.registryContractId).not.toBe(networks.testnet.registryContractId)
  })

  it('resolves a named devnet from its deployment file (no v1 registry)', () => {
    const { active, networks } = resolveNetworks(
      { network: 'devnet', devnetName: 'moutai' },
      DEPLOYMENTS,
    )
    expect(active).toBe('devnet')
    expect(networks.devnet.key).toBe('devnet-moutai')
    expect(networks.devnet.devnetName).toBe('moutai')
    expect(networks.devnet.dapiAddresses).toHaveLength(10)
    expect(networks.devnet.dapiAddresses).toContain('https://68.67.122.84:1443')
    expect(networks.devnet.registryContractId).toBeNull()
  })

  it('exposes the forge-v2 ids devnet-moutai.json records, and none for testnet', () => {
    const file = JSON.parse(readFileSync(resolve(DEPLOYMENTS_DIR, 'devnet-moutai.json'), 'utf8'))
    const { networks } = resolveNetworks({ devnetName: 'moutai' }, DEPLOYMENTS)
    expect(networks.devnet.v2).toEqual({
      core: file.v2.forgeCore.contractId,
      collab: file.v2.forgeCollab.contractId,
      group: file.v2.contractGroupId,
    })
    expect(networks.testnet.v2).toBeNull()
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

  it('lets NEXT_PUBLIC_REGISTRY_CONTRACT_ID beat the deployment, on the active network only', () => {
    const { networks } = resolveNetworks(
      { network: 'devnet', devnetName: 'moutai', registryContractId: 'OVERRIDE' },
      DEPLOYMENTS,
    )
    expect(networks.devnet.registryContractId).toBe('OVERRIDE')
    expect(networks.devnet.registrySource).toBe('NEXT_PUBLIC_REGISTRY_CONTRACT_ID')
    // The override does not leak onto testnet.
    expect(networks.testnet.registryContractId).toBe(onDisk('testnet').registry?.contractId)
  })

  it('an unknown devnet has no addresses (SDK discovery) and no registry', () => {
    const { networks } = resolveNetworks({ network: 'devnet', devnetName: 'paloma' }, DEPLOYMENTS)
    expect(networks.devnet.dapiAddresses).toEqual([])
    expect(networks.devnet.registryContractId).toBeNull()
  })

  it('fails the build on a malformed network env', () => {
    expect(() => resolveNetworks({ network: 'moonnet' }, DEPLOYMENTS)).toThrow(/unknown NEXT_PUBLIC_NETWORK/)
    expect(() => resolveNetworks({ network: 'devnet' }, DEPLOYMENTS)).toThrow(/NEXT_PUBLIC_DEVNET_NAME/)
    expect(() => resolveNetworks({ devnetName: 'mainnet' }, DEPLOYMENTS)).toThrow(/invalid NEXT_PUBLIC_DEVNET_NAME/)
    expect(() => resolveNetworks({ devnetName: '-x' }, DEPLOYMENTS)).toThrow(/invalid NEXT_PUBLIC_DEVNET_NAME/)
  })
})

describe('module-level config (default build env)', () => {
  it('targets testnet and exposes its registry', () => {
    expect(DEFAULT_NETWORK).toBe('testnet')
    expect(requireRegistryContractId('testnet')).toBe(onDisk('testnet').registry?.contractId)
  })

  it('throws the actionable NotDeployedError for a network without a registry', () => {
    if (NETWORKS.mainnet.registryContractId !== null) return
    expect(() => requireRegistryContractId('mainnet')).toThrow(NotDeployedError)
    expect(() => requireRegistryContractId('mainnet')).toThrow(
      /no Dash Forge registry is deployed on mainnet yet; see docs\/mainnet-runbook\.md/,
    )
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
    expect(forgeV2Ids(full)).toEqual({ core: 'C', collab: 'L', group: 'G' })
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
