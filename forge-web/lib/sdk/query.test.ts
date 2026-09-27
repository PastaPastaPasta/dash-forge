import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryDocuments, setStaleContractHandler } from './query'

const CONTRACT = 'BMfPmaEiMqDp64NDa4Am79VoRpZ9MPVNnCUy6i3UiyWi'

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
    expect(handler).toHaveBeenCalledWith(CONTRACT)
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

  it('does not retry other errors', async () => {
    const query = vi.fn().mockRejectedValue(new Error('transport error'))
    const handler = vi.fn(async () => true)
    setStaleContractHandler(handler)
    await expect(queryDocuments(fakeSdk(query), { dataContractId: CONTRACT, documentTypeName: 'issue' })).rejects.toThrow('transport error')
    expect(handler).not.toHaveBeenCalled()
  })
})
