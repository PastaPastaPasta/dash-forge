/**
 * F21: a storage open slower than the budget rejects with IdbSlowError (not a sign-out), and the
 * open that lands later tells onStorageOpened, so the key list and kept session are read again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeRequest {
  result: unknown
  error: DOMException | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onblocked: (() => void) | null
  onupgradeneeded: (() => void) | null
}

let pending: FakeRequest | null = null

function fakeDb(): unknown {
  return {
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    onclose: null,
    transaction: () => {
      const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, error: null }
      const req = { result: 'v' }
      queueMicrotask(() => tx.oncomplete?.())
      return { ...tx, objectStore: () => ({ get: () => req }), set oncomplete(f: () => void) { tx.oncomplete = f } }
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  pending = null
  vi.stubGlobal('indexedDB', {
    open: () => {
      pending = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null }
      return pending
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('slow IndexedDB open', () => {
  it('rejects with IdbSlowError after the budget, and announces the late open', async () => {
    const idb = await import('./idb')
    const opened = vi.fn()
    idb.onStorageOpened(opened)
    const read = idb.idbGet('vault', 'k')
    const caught = read.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(idb.IDB_OPEN_TIMEOUT_MS)
    const e = await caught
    expect(e).toBeInstanceOf(idb.IdbSlowError)
    expect((e as Error).message).toMatch(/still opening/)
    expect(opened).not.toHaveBeenCalled()

    pending!.result = fakeDb()
    pending!.onsuccess!()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when nobody gave up waiting', async () => {
    const idb = await import('./idb')
    const opened = vi.fn()
    idb.onStorageOpened(opened)
    const read = idb.idbGet('vault', 'k')
    pending!.result = fakeDb()
    pending!.onsuccess!()
    await read
    expect(opened).not.toHaveBeenCalled()
  })
})
