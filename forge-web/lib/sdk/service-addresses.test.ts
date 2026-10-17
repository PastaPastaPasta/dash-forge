import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDKOptions } from '@dashevo/evo-sdk'

vi.hoisted(() => {
  process.env['NEXT_PUBLIC_NETWORK'] = 'devnet'
  process.env['NEXT_PUBLIC_DEVNET_NAME'] = 'moutai'
})
const recorded = vi.hoisted(() => ({
  options: [] as EvoSDKOptions[],
  fetch: vi.fn(async (_id: string): Promise<unknown> => ({})),
  free: vi.fn(),
  snapshots: vi.fn(async () => ({})),
  mainnetAddresses: [] as string[],
}))
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))
vi.mock('./contract-seed', () => ({ loadContractSnapshots: recorded.snapshots }))
vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constants')>()
  return {
    ...actual,
    NETWORKS: {
      ...actual.NETWORKS,
      // Master has no testnet Forge ids yet; the rehearsal adds them separately.
      testnet: { ...actual.NETWORKS.testnet, v2: actual.NETWORKS.devnet.v2 },
      mainnet: { ...actual.NETWORKS.mainnet, dapiAddresses: recorded.mainnetAddresses },
    },
  }
})
vi.mock('@dashevo/evo-sdk', () => ({
  ensureInitialized: async () => undefined,
  EvoSDK: class {
    constructor(options: EvoSDKOptions) { recorded.options.push(options) }
    connect = async () => undefined
    contracts = { fetch: recorded.fetch, getLatestVersions: async () => new Map() }
    documents = { query: async () => { throw new Error('contract not found error: contract not found for a document query') } }
    wasm = { free: recorded.free }
    version = () => 14
  },
}))

import testnetDeployment from '../../../forge-contracts/deployments/testnet.json'
import { NETWORKS, type Network } from '../constants'
import { EvoSdkService, MAX_CONTRACT_MISSING_NODES } from './service'

const services: EvoSdkService[] = []
beforeEach(() => {
  vi.useFakeTimers()
  recorded.options.length = 0
  recorded.mainnetAddresses.length = 0
  recorded.fetch.mockReset().mockResolvedValue({})
  recorded.snapshots.mockClear()
  recorded.free.mockClear()
})
afterEach(() => {
  services.splice(0).forEach((service) => service.cleanup())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function connect(network: Network): Promise<EvoSdkService> {
  const service = new EvoSdkService()
  services.push(service)
  await service.initialize({ network, contractIds: [] })
  return service
}

describe('trusted SDK endpoint selection', () => {
  it.each([false, true])('uses only the testnet deployment seeds, with custom quorum URL = %s', async (custom) => {
    if (custom) vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'forge.quorumUrl.testnet' ? 'https://quorums.example.test' : null })
    await connect('testnet')
    const options = recorded.options[0]!
    expect(options).toMatchObject({ network: 'testnet', trusted: true, addresses: NETWORKS.testnet.dapiAddresses })
    expect(options.addresses).toHaveLength(29)
    expect(options.addresses).toEqual(testnetDeployment.dapiAddresses)
    expect(options.addresses).not.toContain('https://206.245.167.63:1443')
    expect(options.proofs).not.toBe(false)
    expect(options.version).toBeUndefined()
    expect(options.quorumUrl).toBe(custom ? 'https://quorums.example.test' : undefined)
    expect(options.settings).toEqual({ timeoutMs: 8000, banFailedAddress: false })
  })

  it('uses mainnet deployment endpoints when present', async () => {
    recorded.mainnetAddresses.push('https://mainnet.example.test:1443')
    await connect('mainnet')
    expect(recorded.options[0]).toMatchObject({ network: 'mainnet', trusted: true, addresses: [...recorded.mainnetAddresses] })
  })

  it('leaves SDK discovery/seeds available when the deployment list is empty', async () => {
    await connect('mainnet')
    expect(recorded.options[0]).toMatchObject({ network: 'mainnet', trusted: true })
    expect(recorded.options[0]).not.toHaveProperty('addresses')
  })

  it('retains the configured devnet addresses, name, and quorum context', async () => {
    await connect('devnet')
    expect(recorded.options[0]).toMatchObject({
      network: 'devnet', trusted: true, devnetName: NETWORKS.devnet.devnetName,
      addresses: NETWORKS.devnet.dapiAddresses,
      ...(NETWORKS.devnet.quorumBaseUrl !== null ? { quorumUrl: NETWORKS.devnet.quorumBaseUrl } : {}),
    })
  })

  it('pins corroborating connections to distinct deployment nodes, preserving custom quorum trust and skipping warm-up', async () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'forge.quorumUrl.testnet' ? 'https://quorums.example.test' : null })
    const service = await connect('testnet')
    recorded.fetch.mockRejectedValue(new Error('contract not found error: contract not found for a document query'))
    await expect(service.getSdk().documents.query({ dataContractId: NETWORKS.testnet.v2!.core } as never)).rejects.toBeDefined()
    await vi.waitFor(() => expect(service.contractsMissing).not.toBeNull())
    expect(recorded.options).toHaveLength(1 + MAX_CONTRACT_MISSING_NODES)
    expect(recorded.options.slice(1).map((options) => options.addresses)).toEqual(
      NETWORKS.testnet.dapiAddresses.slice(0, MAX_CONTRACT_MISSING_NODES).map((address) => [address]),
    )
    for (const options of recorded.options.slice(1)) {
      expect(options).toMatchObject({ network: 'testnet', trusted: true, quorumUrl: 'https://quorums.example.test', settings: { retries: 0 } })
      expect(options.proofs).not.toBe(false)
      expect(options.version).toBeUndefined()
    }
    expect(recorded.snapshots).toHaveBeenCalledOnce()
    expect(recorded.fetch).toHaveBeenCalledTimes(1 + MAX_CONTRACT_MISSING_NODES)
    expect(recorded.free).toHaveBeenCalledTimes(MAX_CONTRACT_MISSING_NODES)
    expect(service.generation).toBe(1)
    expect(service.contractsMissing).toContain('3 nodes answered')
    expect(service.contractsMissing).toContain('unproved refusals')
  })
})
