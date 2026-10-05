import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { countDocuments, countDocumentsGrouped, noteSdkWrite, queryAllDocuments, queryDocuments, retryOnStaleContract, setPlatformVersion, setStaleContractHandler, staleContractCause, staleDocumentVersion, sumDocumentsGrouped, ungroupedRangeProblem, type DocumentQuery } from './query'

const CONTRACT = 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'

function fakeSdk(query: () => Promise<Map<string, unknown>>): EvoSDK {
  return { documents: { query }, version: () => 14 } as unknown as EvoSDK
}

afterEach(() => setStaleContractHandler(null))

describe('reads against a seeded contract that went stale (M3)', () => {
  it('refreshes the contract and retries once on "document type not found"', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce({ message: 'document type not found: milestone' })
      .mockResolvedValueOnce(new Map([['a', { toJSON: () => ({ $id: 'a' }) }]]))
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    const docs = await queryDocuments(fakeSdk(query), { dataContractId: CONTRACT, documentTypeName: 'milestone' })
    expect(docs).toEqual([{ $id: 'a' }])
    expect(handler).toHaveBeenCalledWith([CONTRACT], 'unknownType', undefined)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('surfaces the error when the contract was not seeded', async () => {
    const query = vi.fn().mockRejectedValue({ message: 'document type not found: milestone' })
    setStaleContractHandler(async () => false)
    await expect(queryDocuments(fakeSdk(query), { dataContractId: CONTRACT, documentTypeName: 'milestone' })).rejects.toEqual({
      message: 'document type not found: milestone',
    })
    expect(query).toHaveBeenCalledTimes(1)
  })

  // What the SDK answered a reader holding version 1 of a contract for a document written under
  // version 2 of an updated type (measured on sakura, forge-contracts/scripts/update1-probe.mjs)
  const NEWER = 'dash drive: protocol: Corrupted Serialization: serialized document has trailing bytes: it was serialized under contract version 2 with properties this document type does not know; refetch the contract'

  it('refreshes the contract and retries once when a document is newer than the held contract (UPDATE-1)', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error(NEWER))
      .mockResolvedValueOnce(new Map([['a', { toJSON: () => ({ $id: 'a' }) }]]))
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    const docs = await queryDocuments(fakeSdk(query), { dataContractId: CONTRACT, documentTypeName: 'release' })
    expect(docs).toEqual([{ $id: 'a' }])
    expect(handler).toHaveBeenCalledWith([CONTRACT], 'newerDocument', 2)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('names the cause of each stale-contract error, and no other', () => {
    expect(staleContractCause({ message: 'document type not found: packMirror' })).toBe('unknownType')
    expect(staleContractCause(new Error(NEWER))).toBe('newerDocument')
    expect(staleContractCause(new Error('Corrupted Serialization: error probing for trailing bytes in serialized document'))).toBeNull()
    expect(staleContractCause(new Error('transport error'))).toBeNull()
    expect(staleDocumentVersion(new Error(NEWER))).toBe(2)
    expect(staleDocumentVersion({ message: 'document type not found: packMirror' })).toBeUndefined()
  })

  it('retries counts and sums the same way: an update can add the type they read', async () => {
    const stale = { message: 'document type not found: milestone' }
    const count = vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(new Map([['k', 3n]]))
    const sum = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(new Map([['k', 5n]]))
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    const sdk = { documents: { count, sum }, version: () => 14 } as unknown as EvoSDK
    const grouped = { dataContractId: CONTRACT, documentTypeName: 'milestone', where: [['state', 'in', [0]]] as const, groupBy: ['state'] }
    expect(await countDocuments(sdk, { dataContractId: CONTRACT, documentTypeName: 'milestone' })).toBe(3)
    expect(await countDocumentsGrouped(sdk, grouped)).toEqual(new Map([['k', 3]]))
    expect(await sumDocumentsGrouped(sdk, grouped, 'weight')).toEqual(new Map([['k', 5]]))
    expect(handler).toHaveBeenCalledTimes(2)
    expect(count).toHaveBeenCalledTimes(3)
    expect(sum).toHaveBeenCalledTimes(2)
  })

  it('a read over several contracts hands them all to one refresh (the error does not name one)', async () => {
    const OTHER = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
    const read = vi.fn().mockRejectedValueOnce({ __wbg_ptr: 1, message: NEWER }).mockResolvedValueOnce('rows')
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    expect(await retryOnStaleContract([CONTRACT, OTHER, CONTRACT], read)).toBe('rows')
    expect(handler.mock.calls).toEqual([[[CONTRACT, OTHER], 'newerDocument', 2]])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not retry other errors', async () => {
    const query = vi.fn().mockRejectedValue(new Error('transport error'))
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    await expect(queryDocuments(fakeSdk(query), { dataContractId: CONTRACT, documentTypeName: 'issue' })).rejects.toThrow('transport error')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('identical reads in flight are joined (S-1)', () => {
  it('two callers of the same query while it is out send one request, and each gets its own array', async () => {
    let resolve!: (m: Map<string, unknown>) => void
    const query = vi.fn(() => new Promise<Map<string, unknown>>((r) => (resolve = r)))
    const sdk = fakeSdk(query)
    const q = { dataContractId: CONTRACT, documentTypeName: 'domain', where: [['records.identity', '==', 'x']] as const, limit: 1 }
    const a = queryDocuments(sdk, q)
    const b = queryDocuments(sdk, { ...q })
    resolve(new Map([['a', { toJSON: () => ({ $id: 'a' }) }]]))
    const [ra, rb] = await Promise.all([a, b])
    expect(query).toHaveBeenCalledTimes(1)
    expect(ra).toEqual([{ $id: 'a' }])
    expect(ra).not.toBe(rb)
  })

  it('a settled answer is never reused: the next read asks again', async () => {
    const query = vi.fn(async () => new Map())
    const sdk = fakeSdk(query)
    const q = { dataContractId: CONTRACT, documentTypeName: 'issue' }
    await queryDocuments(sdk, q)
    await queryDocuments(sdk, q)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('different queries, and the same query on another SDK, are not joined', async () => {
    const query = vi.fn(async () => new Map())
    const one = fakeSdk(query)
    const two = fakeSdk(query)
    await Promise.all([
      queryDocuments(one, { dataContractId: CONTRACT, documentTypeName: 'issue', limit: 1 }),
      queryDocuments(one, { dataContractId: CONTRACT, documentTypeName: 'issue', limit: 2 }),
      queryDocuments(two, { dataContractId: CONTRACT, documentTypeName: 'issue', limit: 1 }),
    ])
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('a failure reaches every joined caller, and the next read tries again', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(new Map())
    const sdk = fakeSdk(query)
    const q = { dataContractId: CONTRACT, documentTypeName: 'issue' }
    const results = await Promise.allSettled([queryDocuments(sdk, q), queryDocuments(sdk, q)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    await expect(queryDocuments(sdk, q)).resolves.toEqual([])
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('a read issued after this tab wrote does not join one issued before (review L2)', async () => {
    let resolve!: (m: Map<string, unknown>) => void
    const query = vi.fn(() => new Promise<Map<string, unknown>>((r) => (resolve = r)))
    const sdk = fakeSdk(query)
    const q = { dataContractId: CONTRACT, documentTypeName: 'issue', limit: 1 }
    const before = queryDocuments(sdk, q)
    const first = resolve
    noteSdkWrite(sdk)
    const after = queryDocuments(sdk, q)
    expect(query).toHaveBeenCalledTimes(2)
    first(new Map())
    resolve(new Map())
    await Promise.all([before, after])
  })

  it('counts are joined the same way', async () => {
    const count = vi.fn(async () => new Map([['', 3n]]))
    const sdk = { documents: { count }, version: () => 14 } as unknown as EvoSDK
    const q = { dataContractId: CONTRACT, documentTypeName: 'star', where: [['repoId', '==', 'r']] as const }
    expect(await Promise.all([countDocuments(sdk, q), countDocuments(sdk, q)])).toEqual([3, 3])
    expect(count).toHaveBeenCalledTimes(1)
  })
})

describe('the page-boundary tie read is for protocol 13 only', () => {
  // Two full pages, then a short one.
  const rows = Array.from({ length: 201 }, (_, i) => ({ $id: `r-${String(i).padStart(4, '0')}`, $createdAt: i }))
  function pagedSdk(version: number, seen: unknown[]): EvoSDK {
    const query = async (q: { where?: unknown[][]; startAfter?: string; limit?: number }) => {
      seen.push(q)
      let out = [...rows]
      for (const [f, op, v] of q.where ?? []) if (op === '==' && f === '$createdAt') out = out.filter((d) => d.$createdAt === v)
      if (q.startAfter !== undefined) out = out.slice(out.findIndex((d) => d.$id === q.startAfter) + 1)
      return new Map(out.slice(0, q.limit ?? 100).map((d) => [d.$id, d]))
    }
    return { documents: { query }, version: () => version } as unknown as EvoSDK
  }
  const q = { dataContractId: CONTRACT, documentTypeName: 'event', where: [['repoId', '==', 'r']] as const, orderBy: [['$createdAt', 'asc']] as const }
  afterEach(() => setPlatformVersion(14))

  it('protocol 14 pages on the cursor alone (Drive pads the tie itself)', async () => {
    const seen: unknown[] = []
    expect(await queryAllDocuments(pagedSdk(14, seen), q)).toHaveLength(201)
    expect(seen).toHaveLength(3)
  })

  it('protocol 13 still reads each boundary timestamp', async () => {
    const seen: unknown[] = []
    expect(await queryAllDocuments(pagedSdk(13, seen), q)).toHaveLength(201)
    expect(seen).toHaveLength(5)
  })
})

describe('ungrouped range aggregates are refused before they are sent (they fail proof on an absent path)', () => {
  const sdk = { documents: { count: async () => new Map(), sum: async () => new Map() } } as unknown as EvoSDK
  const q = (where: DocumentQuery['where'], groupBy: string[] = []) => ({ dataContractId: 'C', documentTypeName: 'repo', where, groupBy })

  it('a point count is sent; a range count without groupBy is refused', async () => {
    await expect(countDocuments(sdk, q([['repoId', '==', 'R']]))).resolves.toBe(0)
    await expect(countDocuments(sdk, q([['visibility', '==', 'public'], ['$createdAt', '>', 5]]))).rejects.toThrow(/carrier/)
    expect(ungroupedRangeProblem(q([['name', 'startsWith', 'a']]))).not.toBeNull()
  })

  it('the carrier form (in [x] plus the range, grouped) is sent', async () => {
    await expect(countDocumentsGrouped(sdk, q([['visibility', 'in', ['public']], ['$createdAt', '>', 5]], ['visibility']))).resolves.toEqual(new Map())
    await expect(sumDocumentsGrouped(sdk, q([['repoId', 'in', ['R']], ['tagName', '>', '']], ['repoId']), 'delta')).resolves.toEqual(new Map())
    await expect(sumDocumentsGrouped(sdk, q([['repoId', '==', 'R'], ['tagName', '>', '']], []), 'delta')).rejects.toThrow(/carrier/)
  })
})
