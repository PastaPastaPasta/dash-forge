import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

vi.hoisted(() => {
  process.env['NEXT_PUBLIC_NETWORK'] = 'devnet'
  process.env['NEXT_PUBLIC_DEVNET_NAME'] = 'moutai'
})
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))

import { NETWORKS } from '../constants'
import { ContractReadRefusedError, isContractMissingError } from './contract-missing'
import { CONTRACT_REFUSAL_WAITS_MS, EvoSdkService, RECOVER_GAP_MS, type Connection } from './service'
import { isUnreachableError } from './unreachable'

const REFUSAL_MESSAGE =
  'transport error: grpc error: code: \'Client specified an invalid argument\', message: "contract not found error: contract not found when querying from value with contract info"'

/** A wasm-sdk error as it reaches JS: a plain object, not an Error. */
const REFUSAL = { name: 'DapiClientError', kind: 7, code: -1, isRetriable: false, message: REFUSAL_MESSAGE }
const refuse = async (): Promise<unknown> => { throw REFUSAL }
const RETRY_BUDGET = CONTRACT_REFUSAL_WAITS_MS.reduce((sum, ms) => sum + ms, 0)

const services: EvoSdkService[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  services.splice(0).forEach((service) => service.cleanup())
  vi.useRealTimers()
})

describe('isContractMissingError', () => {
  it('recognizes Drive refusals and SDK not-found reports without establishing proved absence', () => {
    for (const error of [new Error(REFUSAL_MESSAGE), REFUSAL, REFUSAL_MESSAGE, 'contract not found error: contract not found for a document query', 'Data contract not found']) {
      expect(isContractMissingError(error)).toBe(true)
    }
  })

  it('does not match other failures', () => {
    for (const error of ['transport error: grpc error: code: Unavailable', 'Document type not found: issue', 'Identity not found', 'Required document not found: abc', null]) {
      expect(isContractMissingError(error)).toBe(false)
    }
  })

  it('keeps refusals distinct from outages, including the retryable error shown to users', () => {
    expect(isUnreachableError(REFUSAL)).toBe(false)
    expect(isUnreachableError(new ContractReadRefusedError(REFUSAL))).toBe(false)
    expect(isUnreachableError(new Error('transport error: tcp connect error'))).toBe(true)
  })
})

describe('EvoSdkService: missing-contract read retries and proved absence', () => {
  const forge = NETWORKS.devnet.v2!
  const OTHER = 'CErHv5FHjnXJ1Zv6TNmtWirzELYbz8H7rinvn4UtQFZQ'

  async function connected({ proof = async () => undefined, seeded = false }: { proof?: () => Promise<unknown>; seeded?: boolean } = {}) {
    const query = vi.fn(refuse)
    const fetch = vi.fn(proof)
    const create = vi.fn(refuse)
    const free = vi.fn()
    const raw = {
      documents: { query, queryWithProof: query, create },
      contracts: { getLatestVersions: vi.fn(async () => new Map()), fetch },
      wasm: { free },
      version: () => 14,
    } as unknown as EvoSDK
    const connector = vi.fn(async (): Promise<Connection> => ({ sdk: raw, seeded: new Map(seeded ? [[forge.core, 1]] : []) }))
    const service = new EvoSdkService(connector)
    services.push(service)
    await service.initialize({ network: 'devnet', contractIds: [] })
    const notified = vi.fn()
    service.subscribe(notified)
    return { service, sdk: service.getSdk(), query, fetch, connector, notified, create, free }
  }

  const readCore = (sdk: EvoSDK) => sdk.documents.query({ dataContractId: forge.core, documentTypeName: 'repo' } as never)

  async function readError(sdk: EvoSDK): Promise<unknown> {
    const result = readCore(sdk).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    return result
  }

  function expectRetryable(error: unknown): void {
    expect(error).toBeInstanceOf(ContractReadRefusedError)
    expect(error).toMatchObject({ message: 'A node is behind; try again.', isRetriable: true, cause: REFUSAL })
    expect((error as Error).message).not.toMatch(/reset|update|reload|newer build/i)
  }

  it('one refusal followed by success returns data on the same SDK without an absence check', async () => {
    const { service, sdk, query, fetch, connector } = await connected()
    const data = new Map([['repo', { name: 'recovered' }]])
    query.mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce(data)
    const result = readCore(sdk)
    await vi.advanceTimersByTimeAsync(CONTRACT_REFUSAL_WAITS_MS[0]!)
    expect(await result).toBe(data)
    expect(query).toHaveBeenCalledTimes(2)
    expect(fetch).not.toHaveBeenCalled()
    expect(connector).toHaveBeenCalledOnce()
    expect(service.generation).toBe(1)
    expect(service.contractsMissing).toBeNull()
  })

  it('exhausted refusals followed by proved presence stay retryable', async () => {
    const { service, sdk, query, fetch, connector } = await connected({ proof: async () => ({ id: forge.core }), seeded: true })
    expectRetryable(await readError(sdk))
    expect(query).toHaveBeenCalledTimes(1 + CONTRACT_REFUSAL_WAITS_MS.length)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(forge.core)
    expect(connector).toHaveBeenCalledOnce()
    expect(service.contractsMissing).toBeNull()
  })

  it.each([
    { label: 'another unproved refusal', error: REFUSAL },
    { label: 'a transport failure', error: new Error('transport error: tcp connect error') },
    { label: 'a rejected proof', error: new Error('invalid proof: root hash mismatch') },
  ])('a confirmation with $label never establishes absence', async ({ error }) => {
    const { service, sdk, fetch } = await connected({ proof: async () => { throw error } })
    expectRetryable(await readError(sdk))
    expect(fetch).toHaveBeenCalledOnce()
    expect(service.contractsMissing).toBeNull()
  })

  it('only proved None after bounded retries enters contracts-missing, once', async () => {
    const { service, sdk, query, fetch, notified } = await connected({ seeded: true })
    const error = await readError(sdk)
    expect(error).not.toBeInstanceOf(ContractReadRefusedError)
    expect((error as Error).message).toContain('Platform proved')
    expect(query).toHaveBeenCalledTimes(4)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(forge.core)
    expect(service.contractsMissing).toBe(`Platform proved contract ${forge.core} absent: ${REFUSAL_MESSAGE}`)
    expect(notified).toHaveBeenCalledOnce()
    // Later reads reject after their first refusal without spending the retry backoff.
    await expect(readCore(sdk)).rejects.toThrow(service.contractsMissing!)
    expect(query).toHaveBeenCalledTimes(5)
    expect(fetch).toHaveBeenCalledOnce()
    expect(notified).toHaveBeenCalledOnce()
    service.cleanup()
    expect(service.contractsMissing).toBeNull()
  })

  it('a read already in backoff stops before its next SDK call when another read proves absence', async () => {
    let finish: (value: unknown) => void = () => undefined
    const proof = new Promise((resolve) => { finish = resolve })
    const { service, sdk, query, fetch } = await connected({ proof: () => proof })
    const first = readCore(sdk).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    expect(fetch).toHaveBeenCalledOnce()
    const second = readCore(sdk).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(5)
    finish(undefined)
    await first
    await vi.advanceTimersByTimeAsync(CONTRACT_REFUSAL_WAITS_MS[0]!)
    expect(await second).toMatchObject({ message: service.contractsMissing, cause: REFUSAL })
    expect(query).toHaveBeenCalledTimes(5)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('parallel exhausted reads share one in-flight proof check', async () => {
    let finish: (value: unknown) => void = () => undefined
    const proof = new Promise((resolve) => { finish = resolve })
    const { service, sdk, fetch, notified } = await connected({ proof: () => proof })
    const results = Promise.allSettled([readCore(sdk), readCore(sdk), readCore(sdk)])
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    expect(fetch).toHaveBeenCalledOnce()
    expect(service.contractsMissing).toBeNull()
    finish(undefined)
    await results
    expect(service.contractsMissing).toContain('Platform proved')
    expect(notified).toHaveBeenCalledOnce()
  })

  it('inconclusive proof checks have a cooldown, without preventing manual read retries', async () => {
    const { sdk, fetch, query } = await connected({ proof: async () => ({ id: forge.core }) })
    expectRetryable(await readError(sdk))
    expectRetryable(await readError(sdk))
    expect(query).toHaveBeenCalledTimes(8)
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RECOVER_GAP_MS)
    await readError(sdk)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cleanup discards a proof result and retains its connection until the fetch finishes', async () => {
    let finish: (value: unknown) => void = () => undefined
    const pending = new Promise((resolve) => { finish = resolve })
    const { service, sdk, fetch, free } = await connected({ proof: () => pending })
    const result = readCore(sdk).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    expect(fetch).toHaveBeenCalledOnce()
    service.cleanup()
    expect(free).not.toHaveBeenCalled()
    finish(undefined)
    await result
    expect(free).toHaveBeenCalledOnce()
    expect(service.contractsMissing).toBeNull()
  })

  it('a network switch during backoff stops the old read before another SDK call', async () => {
    const { service, sdk, query, fetch } = await connected()
    const result = readCore(sdk).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    await service.initialize({ network: 'mainnet', contractIds: [] })
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    await result
    expect(query).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(service.contractsMissing).toBeNull()
  })

  it("another contract's refusal stays retryable without changing the app-wide state", async () => {
    const { service, sdk, query, fetch } = await connected()
    const result = sdk.documents.query({ dataContractId: OTHER, documentTypeName: 'loginKeyResponse' } as never).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET)
    expectRetryable(await result)
    expect(query).toHaveBeenCalledTimes(4)
    expect(fetch).not.toHaveBeenCalled()
    expect(service.contractsMissing).toBeNull()
  })

  it('other read failures are not retried as missing contracts', async () => {
    const { sdk, query, fetch } = await connected()
    const error = new Error('transport error: grpc error: code: Unavailable')
    query.mockRejectedValue(error)
    await expect(readCore(sdk)).rejects.toBe(error)
    expect(query).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('writes keep their existing policy and are never retried by this read path', async () => {
    const { sdk, create, query, fetch } = await connected()
    await expect(sdk.documents.create({} as never)).rejects.toBe(REFUSAL)
    expect(create).toHaveBeenCalledOnce()
    expect(query).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
