import { describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

// The build under test targets devnet moutai, whose deployment file names the forge contracts.
vi.hoisted(() => {
  process.env['NEXT_PUBLIC_NETWORK'] = 'devnet'
  process.env['NEXT_PUBLIC_DEVNET_NAME'] = 'moutai'
})
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))

import { NETWORKS } from '../constants'
import { isContractMissingError } from './contract-missing'
import { EvoSdkService, type Connection } from './service'
import { isUnreachableError } from './unreachable'

/**
 * What forge.dashhq.org showed after devnet moutai was reset to beta.6 (2026-09-28): a document
 * read against a bundled forge-core snapshot whose contract the network no longer has.
 */
const RESET_DEVNET_ERROR =
  'transport error: grpc error: code: \'Client specified an invalid argument\', message: "contract not found error: contract not found when querying from value with contract info"'

/** A wasm-sdk `WasmSdkError` as it reaches JS: a plain object, not an `Error`. */
function wasmError(message: string, name = 'DapiClientError'): unknown {
  return { name, kind: 7, code: -1, isRetriable: false, message }
}

describe('isContractMissingError', () => {
  it('matches the error the reset devnet returned', () => {
    expect(isContractMissingError(new Error(RESET_DEVNET_ERROR))).toBe(true)
    expect(isContractMissingError(wasmError(RESET_DEVNET_ERROR))).toBe(true)
    expect(isContractMissingError(RESET_DEVNET_ERROR)).toBe(true)
  })

  it("matches Drive's other wording and wasm-sdk's own not-found", () => {
    expect(isContractMissingError(new Error('grpc error: code: InvalidArgument, message: "contract not found error: contract not found for a document query"'))).toBe(true)
    expect(isContractMissingError(wasmError('Data contract not found', 'NotFound'))).toBe(true)
  })

  it('does not match other failures', () => {
    expect(isContractMissingError(new Error('transport error: grpc error: code: Unavailable'))).toBe(false)
    expect(isContractMissingError(wasmError('Document type not found: issue', 'NotFound'))).toBe(false)
    expect(isContractMissingError(wasmError('Identity not found', 'NotFound'))).toBe(false)
    expect(isContractMissingError(new Error('Required document not found: abc'))).toBe(false)
    expect(isContractMissingError(null)).toBe(false)
  })

  it('is an answer, not an outage: never "Platform unreachable" despite the transport wording', () => {
    expect(isUnreachableError(new Error(RESET_DEVNET_ERROR))).toBe(false)
    expect(isUnreachableError(new Error('transport error: tcp connect error'))).toBe(true)
  })
})

describe('EvoSdkService: the forge contracts are not on the network', () => {
  const forge = NETWORKS.devnet.v2!
  const OTHER = 'CErHv5FHjnXJ1Zv6TNmtWirzELYbz8H7rinvn4UtQFZQ'

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  /**
   * A service connected to an SDK whose every document read fails with `error`, and whose
   * contract fetch (the confirmation) answers `fetched` (undefined: proved absent).
   */
  async function connected(
    error: unknown,
    fetched: () => Promise<unknown> = async () => undefined,
  ): Promise<{ service: EvoSdkService; sdk: EvoSDK; notified: () => number; confirms: () => number }> {
    const fail = vi.fn(async () => {
      throw error
    })
    const fetch = vi.fn(fetched)
    const raw = {
      documents: { query: fail, queryWithProof: fail },
      contracts: { getLatestVersions: vi.fn(async () => new Map()), fetch },
      wasm: { free: vi.fn() },
      version: () => 14,
    } as unknown as EvoSDK
    const service = new EvoSdkService(async (): Promise<Connection> => ({ sdk: raw, seeded: new Map() }))
    await service.initialize({ network: 'devnet', contractIds: [] })
    let n = 0
    service.subscribe(() => n++)
    return { service, sdk: service.getSdk(), notified: () => n, confirms: () => fetch.mock.calls.length }
  }

  const readCore = (sdk: EvoSDK) => sdk.documents.query({ dataContractId: forge.core, documentTypeName: 'repo' } as never)

  it('one failed read of forge-core, confirmed absent, reports it app-wide, once, with the raw error kept', async () => {
    const { service, sdk, notified, confirms } = await connected(wasmError(RESET_DEVNET_ERROR))
    expect(service.contractsMissing).toBeNull()
    await expect(readCore(sdk)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(1)
    expect(service.contractsMissing).toBe(RESET_DEVNET_ERROR)
    expect(notified()).toBe(1)
    // Later failures (every other widget's read) neither check nor notify again.
    await expect(sdk.documents.query({ dataContractId: forge.collab, documentTypeName: 'issue' } as never)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(1)
    expect(notified()).toBe(1)
    // A network switch or cleanup forgets it.
    service.cleanup()
    expect(service.contractsMissing).toBeNull()
  })

  it('a confirmation refused the same way counts; concurrent failures share one confirmation', async () => {
    const { service, sdk, confirms } = await connected(wasmError(RESET_DEVNET_ERROR), async () => {
      throw wasmError(RESET_DEVNET_ERROR)
    })
    await Promise.allSettled([readCore(sdk), readCore(sdk), readCore(sdk)])
    await flush()
    expect(confirms()).toBe(1)
    expect(service.contractsMissing).toBe(RESET_DEVNET_ERROR)
  })

  it('one node that is behind (the contract fetches after all) does not blank the app', async () => {
    const { service, sdk, confirms } = await connected(wasmError(RESET_DEVNET_ERROR), async () => ({ id: forge.core }))
    await expect(readCore(sdk)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(1)
    expect(service.contractsMissing).toBeNull()
    // …and the next failure right after does not check again (no request storm).
    await expect(readCore(sdk)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(1)
    // Nor does a confirmation that could not reach Platform.
    const offline = await connected(wasmError(RESET_DEVNET_ERROR), async () => {
      throw new Error('transport error: tcp connect error')
    })
    await expect(readCore(offline.sdk)).rejects.toBeDefined()
    await flush()
    expect(offline.service.contractsMissing).toBeNull()
  })

  it("another contract's absence (a repo's, the wallet key exchange) stays that view's error", async () => {
    const { service, sdk, confirms } = await connected(wasmError(RESET_DEVNET_ERROR))
    await expect(sdk.documents.query({ dataContractId: OTHER, documentTypeName: 'loginKeyResponse' } as never)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(0)
    expect(service.contractsMissing).toBeNull()
  })

  it('an outage on a forge contract is not "contracts missing"', async () => {
    const { service, sdk, confirms } = await connected(new Error('transport error: grpc error: code: Unavailable'))
    await expect(readCore(sdk)).rejects.toBeDefined()
    await flush()
    expect(confirms()).toBe(0)
    expect(service.contractsMissing).toBeNull()
  })
})
