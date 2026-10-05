import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryComposite, type CompositeQuery } from './composite'
import { setStaleContractHandler } from './query'

const CORE = 'EfLLbzVBngukybqgraA7VXtLZ5PpU54eiaB9Dcxqbkkz'
const COLLAB = '6scu1j9FQkt3EYr9yoAfEL1SUaYX7F7mnaUFYiRLgjgb'

// What a composite read rejected with in Chromium, holding version 1 of forge-collab while a
// sub-query read an issue written under version 2 (UPDATE-1): a wasm-bindgen object, not an Error.
const STALE = {
  __wbg_ptr: 1,
  message:
    'dash drive: protocol: Corrupted Serialization: serialized document has trailing bytes: it was serialized under contract version 2 with properties this document type does not know; refetch the contract',
}

const QUERY: CompositeQuery = {
  dataContractId: CORE,
  documentType: 'repo',
  limit: 1,
  subQueries: [
    { dataContractId: COLLAB, documentType: 'issue', limit: 1, bind: { sourceProperty: '$id', field: 'repoId' } },
    { documentType: 'writer', limit: 1, bind: { sourceProperty: '$id', field: 'repoId' } },
  ],
}

afterEach(() => setStaleContractHandler(null))

describe('a composite read against a contract an in-place update made stale (UPDATE-1)', () => {
  it('refreshes every contract it reads and retries once', async () => {
    const composite = vi
      .fn()
      .mockRejectedValueOnce(STALE)
      .mockResolvedValueOnce({ pageDocuments: [{ toJSON: () => ({ $id: 'r' }) }], subResults: [{ kind: 'documents', documents: [] }, { kind: 'documents', documents: [] }] })
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    const sdk = { documents: { composite }, version: () => 14 } as unknown as EvoSDK
    const res = await queryComposite(sdk, QUERY)
    expect(res.page).toEqual([{ $id: 'r' }])
    expect(handler.mock.calls).toEqual([[[CORE, COLLAB], 'newerDocument', 2]])
    expect(composite).toHaveBeenCalledTimes(2)
  })

  it('surfaces the error when no contract could be refreshed', async () => {
    const composite = vi.fn().mockRejectedValue(STALE)
    setStaleContractHandler(async () => false)
    const sdk = { documents: { composite }, version: () => 14 } as unknown as EvoSDK
    await expect(queryComposite(sdk, QUERY)).rejects.toBe(STALE)
    expect(composite).toHaveBeenCalledTimes(1)
  })
})
