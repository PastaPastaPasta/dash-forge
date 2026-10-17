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
  emptyTestnet: false,
  gate: vi.fn(),
}))
vi.mock('./budget', () => ({ installDapiFetchGate: recorded.gate, dapiBudget: { retryAfterMs: () => 0 } }))
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))
vi.mock('./contract-seed', () => ({ loadContractSnapshots: recorded.snapshots }))
vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constants')>()
  return {
    ...actual,
    NETWORKS: {
      ...actual.NETWORKS,
      get testnet() {
        return { ...actual.NETWORKS.testnet, dapiAddresses: recorded.emptyTestnet ? [] : actual.NETWORKS.testnet.dapiAddresses }
      },
    },
  }
})
vi.mock('@dashevo/evo-sdk', () => ({
  ensureInitialized: async () => undefined,
  EvoSDK: class {
    constructor(options: EvoSDKOptions) { recorded.options.push(options) }
    connect = async () => undefined
    contracts = { fetch: recorded.fetch, getLatestVersions: async () => new Map() }
    wasm = { free: recorded.free }
    version = () => 14
  },
}))

import testnetDeployment from '../../../forge-contracts/deployments/testnet.json'
import { NETWORKS, type Network } from '../constants'
import { EvoSdkService } from './service'

const services: EvoSdkService[] = []
beforeEach(() => {
  vi.useFakeTimers()
  recorded.options.length = 0
  recorded.emptyTestnet = false
  recorded.fetch.mockReset().mockResolvedValue({})
  recorded.snapshots.mockClear()
  recorded.free.mockClear()
  recorded.gate.mockClear()
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
    expect(recorded.gate).toHaveBeenCalledWith(testnetDeployment.dapiAddresses)
  })

  it.each([false, true])('keeps mainnet SDK seeds despite the deployment list, with custom quorum URL = %s', async (custom) => {
    if (custom) vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'forge.quorumUrl.mainnet' ? 'https://quorums.example.test' : null })
    expect(NETWORKS.mainnet.dapiAddresses).toHaveLength(10)
    await connect('mainnet')
    const options = recorded.options[0]!
    expect(options).toMatchObject({ network: 'mainnet', trusted: true })
    expect(options).not.toHaveProperty('addresses')
    expect(options.quorumUrl).toBe(custom ? 'https://quorums.example.test' : undefined)
    expect(options.proofs).not.toBe(false)
    expect(recorded.gate).toHaveBeenCalledWith([])
  })

  it('retains the SDK fallback for an empty testnet deployment list', async () => {
    recorded.emptyTestnet = true
    await connect('testnet')
    expect(recorded.options[0]).toMatchObject({ network: 'testnet', trusted: true })
    expect(recorded.options[0]).not.toHaveProperty('addresses')
    expect(recorded.gate).toHaveBeenCalledWith([])
  })

  it('retains the configured devnet addresses, name, and quorum context', async () => {
    await connect('devnet')
    expect(recorded.options[0]).toMatchObject({
      network: 'devnet', trusted: true, devnetName: NETWORKS.devnet.devnetName,
      addresses: NETWORKS.devnet.dapiAddresses,
      ...(NETWORKS.devnet.quorumBaseUrl !== null ? { quorumUrl: NETWORKS.devnet.quorumBaseUrl } : {}),
    })
    expect(recorded.gate).toHaveBeenCalledWith(NETWORKS.devnet.dapiAddresses)
  })
})
