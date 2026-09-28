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
import { EvoSdkService, isUnreachableError, type Connection } from './service'

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

  /** A service connected to an SDK whose every document read fails with `error`. */
  async function connected(error: unknown): Promise<{ service: EvoSdkService; sdk: EvoSDK; notified: () => number }> {
    const fail = vi.fn(async () => {
      throw error
    })
    const raw = {
      documents: { query: fail, queryWithProof: fail },
      contracts: { getLatestVersions: vi.fn(async () => new Map()), fetch: vi.fn(async () => ({})) },
      wasm: { free: vi.fn() },
      version: () => 14,
    } as unknown as EvoSDK
    const service = new EvoSdkService(async (): Promise<Connection> => ({ sdk: raw, seeded: new Map() }))
    await service.initialize({ network: 'devnet', contractIds: [] })
    let n = 0
    service.subscribe(() => n++)
    return { service, sdk: service.getSdk(), notified: () => n }
  }

  it('one failed read of forge-core reports it app-wide, once, with the raw error kept', async () => {
    const { service, sdk, notified } = await connected(wasmError(RESET_DEVNET_ERROR))
    expect(service.contractsMissing).toBeNull()
    await expect(sdk.documents.query({ dataContractId: forge.core, documentTypeName: 'repo' } as never)).rejects.toBeDefined()
    expect(service.contractsMissing).toBe(RESET_DEVNET_ERROR)
    expect(notified()).toBe(1)
    // Later failures (every other widget's read) do not notify again.
    await expect(sdk.documents.query({ dataContractId: forge.collab, documentTypeName: 'issue' } as never)).rejects.toBeDefined()
    expect(notified()).toBe(1)
    // A network switch or cleanup forgets it.
    service.cleanup()
    expect(service.contractsMissing).toBeNull()
  })

  it("another contract's absence (a repo's, the wallet key exchange) stays that view's error", async () => {
    const { service, sdk } = await connected(wasmError(RESET_DEVNET_ERROR))
    await expect(sdk.documents.query({ dataContractId: OTHER, documentTypeName: 'loginKeyResponse' } as never)).rejects.toBeDefined()
    expect(service.contractsMissing).toBeNull()
  })

  it('an outage on a forge contract is not "contracts missing"', async () => {
    const { service, sdk } = await connected(new Error('transport error: grpc error: code: Unavailable'))
    await expect(sdk.documents.query({ dataContractId: forge.core, documentTypeName: 'repo' } as never)).rejects.toBeDefined()
    expect(service.contractsMissing).toBeNull()
  })
})
