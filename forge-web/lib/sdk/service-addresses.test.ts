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
  storeAtBuild: [] as (string | null)[],
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
    constructor(options: EvoSDKOptions) {
      recorded.options.push(options)
      const storage = (globalThis as { localStorage?: Storage }).localStorage
      recorded.storeAtBuild.push(storage?.getItem(`dash-sdk.protocol-version.${options.network}`) ?? null)
    }
    connect = async () => undefined
    contracts = { fetch: recorded.fetch, getLatestVersions: recorded.latest, addKnown: async () => true }
    wasm = { free: recorded.free }
    version = () => recorded.version
  },
}))

import testnetDeployment from '../../../forge-contracts/deployments/testnet.json'
import { NETWORKS, type Network } from '../constants'
import { EvoSdkService, LEARN_VERSION_MS, seedSdkVersion } from './service'

const services: EvoSdkService[] = []
beforeEach(() => {
  vi.useFakeTimers()
  recorded.options.length = 0
  recorded.storeAtBuild.length = 0
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
    expect(NETWORKS.mainnet.dapiAddresses.length).toBeGreaterThan(0)
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

  /**
   * Connect, noting each `getLatestVersions`: its ids, and whether a connection was live then.
   * (No localStorage here, so the seeded-snapshot check after going live is always due.)
   */
  async function connectNoting(network: Network): Promise<{ ids: string[]; live: boolean }[]> {
    const service = new EvoSdkService()
    services.push(service)
    const calls: { ids: string[]; live: boolean }[] = []
    recorded.latest.mockImplementation(async ({ contractIds }) => {
      calls.push({ ids: contractIds, live: service.generation > 0 })
      recorded.version = 14
      return new Map([[CORE, { version: 1 }]])
    })
    await service.initialize({ network, contractIds: [] })
    await vi.advanceTimersByTimeAsync(0)
    return calls
  }

  it('a new SDK below the snapshots\' version learns it from one proved read before going live', async () => {
    // rc.8 starts a testnet SDK at 13; with every contract seeded, nothing else would teach it 14.
    // The read asks the seeded-snapshot check's question, so that check sends nothing of its own.
    recorded.version = 13
    expect(await connectNoting('testnet')).toEqual([{ ids: [CORE], live: false }])
  })

  it('an SDK already at that version, or with no snapshots, sends nothing before going live', async () => {
    // Only the seeded-snapshot check, after going live.
    expect(await connectNoting('testnet')).toEqual([{ ids: [CORE], live: true }])

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
    recorded.latest.mockReset().mockReturnValueOnce(late).mockResolvedValue(new Map())
    const hung = new EvoSdkService()
    const connecting = hung.initialize({ network: 'testnet', contractIds: [] })
    await vi.waitFor(() => expect(recorded.latest).toHaveBeenCalledWith({ contractIds: [CORE] }))
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

  it.each(['testnet', 'mainnet'] as const)('a %s SDK is built with the snapshots\' version in its store, so a slow first read cannot leave it at 13 (#682)', async (network) => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    recorded.version = 14
    await connect(network)
    expect(recorded.storeAtBuild).toEqual(['14'])
  })
})

describe('seedSdkVersion', () => {
  function storage(initial: Record<string, string> = {}): Map<string, string> {
    const store = new Map(Object.entries(initial))
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    return store
  }

  it('raises a missing, lower or unreadable stored version to the floor', () => {
    for (const before of [undefined, '13', ' 12 ', 'garbage', '14abc', '']) {
      const store = storage(before === undefined ? {} : { 'dash-sdk.protocol-version.testnet': before })
      seedSdkVersion('testnet', 14)
      expect(store.get('dash-sdk.protocol-version.testnet')).toBe('14')
    }
  })

  it('never lowers a stored version and leaves other networks alone', () => {
    const store = storage({ 'dash-sdk.protocol-version.mainnet': '15', 'dash-sdk.protocol-version.testnet': '14' })
    seedSdkVersion('mainnet', 14)
    seedSdkVersion('testnet', 14)
    seedSdkVersion('devnet', 14)
    seedSdkVersion('testnet', 0)
    expect(Object.fromEntries(store)).toEqual({ 'dash-sdk.protocol-version.mainnet': '15', 'dash-sdk.protocol-version.testnet': '14' })
  })

  it('does nothing when storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('SecurityError') } })
    expect(() => seedSdkVersion('testnet', 14)).not.toThrow()
  })
})
