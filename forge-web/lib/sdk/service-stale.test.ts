import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

vi.mock('@dashevo/evo-sdk', () => ({ Identifier: { fromBase58: (id: string) => id } }))
vi.mock('./wasm-fetch', () => ({ compileWasm: () => Promise.resolve({}), onWasmProgress: () => () => undefined }))

import { STALE_REFRESH_MS, refreshStale, type Connection } from './service'

const ID = 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS'

function connection(fetch: () => Promise<unknown>, seeded: Map<string, number> = new Map()): Connection & { removed: string[] } {
  const removed: string[] = []
  const sdk = {
    wasm: { removeCachedContract: (id: string) => removed.push(id) > 0 },
    contracts: { fetch: vi.fn(fetch) },
  } as unknown as EvoSDK
  return { sdk, seeded, removed }
}

afterEach(() => vi.useRealTimers())

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
})
