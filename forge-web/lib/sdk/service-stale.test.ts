import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

vi.mock('@dashevo/evo-sdk', () => ({ Identifier: { fromBase58: (id: string) => id } }))
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))

import { queryComposite } from './composite'
import { setStaleContractHandler } from './query'
import { STALE_REFRESH_MS, refreshStale, refreshStaleRead, revalidateSeeded, type Connection } from './service'

const ID = 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'

function connection(fetch: () => Promise<unknown>, seeded: Map<string, number> = new Map()): Connection & { removed: string[] } {
  const removed: string[] = []
  const sdk = {
    wasm: { removeCachedContract: (id: string) => removed.push(id) > 0 },
    contracts: { fetch: vi.fn(fetch) },
  } as unknown as EvoSDK
  return { sdk, seeded, removed }
}

afterEach(() => {
  vi.useRealTimers()
  setStaleContractHandler(null)
})

describe('refreshing a contract a read found stale (UPDATE-1)', () => {
  it('reads that fail together share one refetch, and all of them retry', async () => {
    let resolve!: (v: unknown) => void
    const c = connection(() => new Promise((r) => (resolve = r)))
    const reads = [1, 2, 3].map(() => refreshStale(c, ID, 'newerDocument', () => undefined))
    await vi.waitFor(() => expect(c.sdk.contracts.fetch).toHaveBeenCalled())
    resolve({})
    expect(await Promise.all(reads)).toEqual([true, true, true])
    expect(c.sdk.contracts.fetch).toHaveBeenCalledTimes(1)
    expect(c.removed).toEqual([ID])
  })

  it('refetches a fetched (not seeded) contract only for a newer document', async () => {
    const c = connection(async () => ({}))
    expect(await refreshStale(c, ID, 'unknownType', () => undefined)).toBe(false)
    expect(c.sdk.contracts.fetch).not.toHaveBeenCalled()
  })

  it('refreshes a seeded contract for either cause, and reports it replaced', async () => {
    const replaced: string[] = []
    const c = connection(async () => ({}), new Map([[ID, 1]]))
    expect(await refreshStale(c, ID, 'unknownType', (id) => replaced.push(id))).toBe(true)
    expect(replaced).toEqual([ID])
    expect(c.seeded.has(ID)).toBe(false)
  })

  it('forgets a refetch that failed, so the next stale read tries again', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce({})
    const c = connection(fetch)
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined)).toBe(false)
    await Promise.resolve()
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined)).toBe(true)
    expect(c.sdk.contracts.fetch).toHaveBeenCalledTimes(2)
  })

  it('refetches again once the window has passed (a second update)', async () => {
    vi.useFakeTimers()
    const c = connection(async () => ({}))
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined)).toBe(true)
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined)).toBe(true)
    expect(c.sdk.contracts.fetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(STALE_REFRESH_MS)
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined)).toBe(true)
    expect(c.sdk.contracts.fetch).toHaveBeenCalledTimes(2)
  })

  it('refetches within the window when the document is newer than the version it fetched', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ version: 2 }).mockResolvedValueOnce({ version: 3 })
    const c = connection(fetch)
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined, 2)).toBe(true)
    await Promise.resolve()
    // A document of version 2 again: the refresh already holds it
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined, 2)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Version 3: a second update since that refresh
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined, 3)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps a contract seeded when its refetch failed, so the next read of either cause retries', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce({ version: 2 })
    const c = connection(fetch, new Map([[ID, 1]]))
    expect(await refreshStale(c, ID, 'unknownType', () => undefined)).toBe(false)
    expect(c.seeded.get(ID)).toBe(1)
    await Promise.resolve()
    expect(await refreshStale(c, ID, 'unknownType', () => undefined)).toBe(true)
    expect(c.seeded.has(ID)).toBe(false)
  })

  it('a read that fails while the seeded-version check refetches its contract joins that refetch', async () => {
    let resolve!: (v: unknown) => void
    const c = connection(() => new Promise((r) => (resolve = r)), new Map([[ID, 1]]))
    ;(c.sdk.contracts as unknown as { getLatestVersions: unknown }).getLatestVersions = async () => new Map([[ID, { version: 2 }]])
    const check = revalidateSeeded(c, 'devnet-test', () => undefined)
    await vi.waitFor(() => expect(c.sdk.contracts.fetch).toHaveBeenCalled())
    // The check took the contract out of `seeded`: a read finding it stale must not give up
    const read = refreshStale(c, ID, 'unknownType', () => undefined)
    resolve({ version: 2 })
    expect(await read).toBe(true)
    await check
    expect(c.sdk.contracts.fetch).toHaveBeenCalledTimes(1)
  })

  it('leaves a seeded contract alone when it is as new as the document (a composite names every contract)', async () => {
    const c = connection(async () => ({ version: 2 }), new Map([[ID, 2]]))
    expect(await refreshStale(c, ID, 'newerDocument', () => undefined, 2)).toBe(false)
    expect(c.sdk.contracts.fetch).not.toHaveBeenCalled()
    expect(c.seeded.get(ID)).toBe(2)
  })
})

describe('a read over several contracts refreshes only the ones the network moved past (review: refetch storm)', () => {
  const CORE = 'BKt2Lk6RwUchcdytHT8Sn1ZzYvu8vD4JFEh5G9LHFzRo'
  const COLLAB = 'BTEsn5BmsSWF8ahQLJjohy392vnpD2NgPnTjAVEUCWKh'
  const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
  const newer = (v: number): unknown => ({
    __wbg_ptr: 1,
    message: `serialized document has trailing bytes: it was serialized under contract version ${v} with properties this document type does not know; refetch the contract`,
  })

  /** A connection over a network holding `network` (id → version); `fetched` counts getDataContract per id. */
  function net(network: Record<string, number>, seeded: Map<string, number> = new Map()) {
    const fetched: Record<string, number> = {}
    const getLatestVersions = vi.fn(async ({ contractIds }: { contractIds: string[] }) => new Map(contractIds.map((id) => [id, { version: network[id] }])))
    const sdk = {
      wasm: { removeCachedContract: () => true },
      contracts: {
        fetch: vi.fn(async (id: string) => {
          fetched[id] = (fetched[id] ?? 0) + 1
          return { version: network[id] }
        }),
        getLatestVersions,
      },
    } as unknown as EvoSDK
    const c: Connection = { sdk, seeded }
    const replaced: string[] = []
    setStaleContractHandler((ids, cause, v) => refreshStaleRead(c, ids, cause, (id) => replaced.push(id), v))
    return { c, fetched, getLatestVersions, replaced }
  }

  // The repo chrome's shape: a forge-core page with forge-collab and DPNS sub-queries.
  const composite = (fail: () => unknown) => ({
    documents: {
      composite: vi.fn(async () => {
        const e = fail()
        if (e !== null) throw e
        return { pageDocuments: [], subResults: [{ kind: 'documents', documents: [] }, { kind: 'documents', documents: [] }] }
      }),
    },
    version: () => 14,
  })
  const QUERY = {
    dataContractId: CORE,
    documentType: 'repo',
    limit: 1,
    subQueries: [
      { dataContractId: COLLAB, documentType: 'issue', limit: 1, bind: { sourceProperty: '$id', field: 'repoId' } },
      { dataContractId: DPNS, documentType: 'domain', limit: 1, bind: { sourceProperty: '$ownerId', field: 'records.identity' } },
    ],
  }

  it('10 composite reads failing on a v3 document refetch only the contract that moved, once (seeded tab)', async () => {
    // forge-core is current at v2, forge-collab moved from v2 to v3, DPNS is current at v1.
    const { fetched } = net({ [CORE]: 2, [COLLAB]: 3, [DPNS]: 1 }, new Map([[CORE, 2], [COLLAB, 2], [DPNS, 1]]))
    for (let i = 0; i < 10; i++) {
      const sdk = composite(() => newer(3)) as unknown as EvoSDK
      await expect(queryComposite(sdk, QUERY)).rejects.toBeTruthy()
    }
    expect(fetched).toEqual({ [COLLAB]: 1 })
  })

  it('10 failing reads with no snapshot (contracts the SDK fetched) refetch at most the one that can hold the document, once', async () => {
    const { fetched } = net({ [CORE]: 2, [COLLAB]: 3, [DPNS]: 1 })
    for (let i = 0; i < 10; i++) {
      const sdk = composite(() => newer(3)) as unknown as EvoSDK
      await expect(queryComposite(sdk, QUERY)).rejects.toBeTruthy()
    }
    expect(fetched).toEqual({ [COLLAB]: 1 })
  })

  it('a composite failing on a newer document retries after the moved contract was refetched', async () => {
    const { fetched } = net({ [CORE]: 2, [COLLAB]: 2, [DPNS]: 1 }, new Map([[CORE, 2], [COLLAB, 1], [DPNS, 1]]))
    let failures = 1
    const sdk = composite(() => (failures-- > 0 ? newer(2) : null)) as unknown as EvoSDK
    await expect(queryComposite(sdk, QUERY)).resolves.toBeTruthy()
    expect(fetched).toEqual({ [COLLAB]: 1 })
  })

  it('a composite naming a type the held contract lacks refreshes only the seeded contracts that moved', async () => {
    const { c, fetched, replaced } = net({ [CORE]: 2, [COLLAB]: 2, [DPNS]: 1 }, new Map([[CORE, 1], [COLLAB, 2], [DPNS, 1]]))
    let failures = 1
    const sdk = composite(() => (failures-- > 0 ? { message: 'document type not found: packMirror' } : null)) as unknown as EvoSDK
    await expect(queryComposite(sdk, QUERY)).resolves.toBeTruthy()
    expect(fetched).toEqual({ [CORE]: 1 })
    expect(replaced).toEqual([CORE])
    expect([...c.seeded.keys()].sort()).toEqual([COLLAB, DPNS].sort())
  })

  it('one contract costs no version lookup', async () => {
    const { c, getLatestVersions, fetched } = net({ [COLLAB]: 3 }, new Map([[COLLAB, 2]]))
    expect(await refreshStaleRead(c, [COLLAB], 'newerDocument', () => undefined, 3)).toBe(true)
    expect(getLatestVersions).not.toHaveBeenCalled()
    expect(fetched).toEqual({ [COLLAB]: 1 })
  })

  it('a composite that failed while the seeded-version check refreshed its contracts retries, with no new fetch', async () => {
    const { c, fetched } = net({ [CORE]: 2, [COLLAB]: 2, [DPNS]: 1 }, new Map([[CORE, 2], [COLLAB, 1], [DPNS, 1]]))
    await revalidateSeeded(c, 'devnet-test', () => undefined)
    expect(fetched).toEqual({ [COLLAB]: 1 })
    let failures = 1
    const sdk = composite(() => (failures-- > 0 ? newer(2) : null)) as unknown as EvoSDK
    await expect(queryComposite(sdk, QUERY)).resolves.toBeTruthy()
    expect(fetched).toEqual({ [COLLAB]: 1 })
  })
})
