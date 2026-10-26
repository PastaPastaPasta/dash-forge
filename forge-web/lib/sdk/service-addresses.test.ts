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
  version: 14,
  latest: vi.fn(async (_q: { contractIds: string[] }) => new Map()),
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
  DataContract: { fromBase64: () => ({}) },
  EvoSDK: class {
    constructor(options: EvoSDKOptions) { recorded.options.push(options) }
    connect = async () => undefined
    contracts = { fetch: recorded.fetch, getLatestVersions: recorded.latest, addKnown: async () => true }
    wasm = { free: recorded.free }
    version = () => recorded.version
  },
}))

import testnetDeployment from '../../../forge-contracts/deployments/testnet.json'
import { NETWORKS, type Network } from '../constants'
import { EvoSdkService, LEARN_VERSION_MS } from './service'

const services: EvoSdkService[] = []
beforeEach(() => {
  vi.useFakeTimers()
  recorded.options.length = 0
  recorded.emptyTestnet = false
  recorded.fetch.mockReset().mockResolvedValue({})
  recorded.snapshots.mockReset().mockResolvedValue({})
  recorded.free.mockClear()
  recorded.gate.mockClear()
  recorded.version = 14
  recorded.latest.mockReset().mockResolvedValue(new Map())
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

describe('the protocol version before the first query', () => {
  const CORE = 'D2ZLdgghZTKGpES35a3KVDp5necSfZqqRHLSknjRPAV9'
  beforeEach(() => {
    recorded.snapshots.mockResolvedValue({ [CORE]: { version: 1, platformVersion: 14, bytes: '' } })
  })

  const DPNS = NETWORKS.testnet.dpnsContractId

  /** Connect, noting each `getLatestVersions` for DPNS and whether a connection was live then. */
  async function connectNoting(network: Network): Promise<{ live: boolean }[]> {
    const service = new EvoSdkService()
    services.push(service)
    const calls: { live: boolean }[] = []
    recorded.latest.mockImplementation(async ({ contractIds }) => {
      // (The seeded-snapshot check that follows going live asks for the seeded ids instead.)
      if (contractIds.includes(DPNS)) calls.push({ live: service.generation > 0 })
      recorded.version = 14
      return new Map()
    })
    await service.initialize({ network, contractIds: [] })
    return calls
  }

  it('a new SDK below the snapshots\' version learns it from one proved read before going live', async () => {
    // rc.8 starts a testnet SDK at 13; with every contract seeded, nothing else would teach it 14.
    recorded.version = 13
    expect(await connectNoting('testnet')).toEqual([{ live: false }])
  })

  it('an SDK already at that version, or with no snapshots, sends nothing before going live', async () => {
    expect(await connectNoting('testnet')).toEqual([])

    recorded.version = 13
    recorded.snapshots.mockResolvedValue({})
    expect(await connectNoting('testnet')).toEqual([])
  })

  it('a read that fails or does not answer does not hold up the connect', async () => {
    recorded.version = 13
    recorded.latest.mockRejectedValue(new Error('no available addresses'))
    const failed = new EvoSdkService()
    services.push(failed)
    await failed.initialize({ network: 'testnet', contractIds: [] })
    expect(failed.getStatus().phase).toBe('ready')

    let answer!: () => void
    const late = new Promise<Map<string, unknown>>((resolve) => (answer = () => resolve(new Map())))
    // Only the warm-up's read hangs (the seeded-snapshot check after going live is tracked anyway).
    recorded.latest.mockReset().mockImplementation(async ({ contractIds }) => (contractIds.includes(DPNS) ? late : new Map()))
    const hung = new EvoSdkService()
    const connecting = hung.initialize({ network: 'testnet', contractIds: [] })
    await vi.waitFor(() => expect(recorded.latest).toHaveBeenCalledWith({ contractIds: [DPNS] }))
    expect(hung.getStatus().phase).not.toBe('ready')
    await vi.advanceTimersByTimeAsync(LEARN_VERSION_MS)
    await connecting
    expect(hung.getStatus().phase).toBe('ready')

    // The read it stopped waiting for still borrows the SDK: retiring the connection frees it
    // only once that read settles (a wasm `free()` under a running call traps).
    recorded.free.mockClear()
    hung.cleanup()
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.free).not.toHaveBeenCalled()
    answer()
    await vi.waitFor(() => expect(recorded.free).toHaveBeenCalledTimes(1))
  })
})
