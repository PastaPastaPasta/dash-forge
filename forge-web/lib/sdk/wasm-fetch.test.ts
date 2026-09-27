import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { fetchAndCompile, fetchAndCompileWithRetry, type DownloadProgress } from './wasm-fetch'

function streamOf(chunks: Uint8Array[], gapMs = 0): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
      if (i < chunks.length) controller.enqueue(chunks[i++]!)
      else controller.close()
    },
  })
}

/** Reads the whole body as the compiler would, returning its byte length as the "module". */
async function drain(response: Response): Promise<WebAssembly.Module> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { bytes: bytes.length, type: response.headers.get('content-type') } as unknown as WebAssembly.Module
}

describe('fetchAndCompile (D-025)', () => {
  it('reports progress per chunk and hands the compiler an application/wasm stream', async () => {
    const chunks = [new Uint8Array(3), new Uint8Array(4), new Uint8Array(5)]
    const fetchImpl = vi.fn(async () => new Response(streamOf(chunks), { status: 200 }))
    const seen: DownloadProgress[] = []
    const mod = (await fetchAndCompile('/x.wasm', 12, (p) => seen.push(p), { fetchImpl, compile: drain })) as unknown as {
      bytes: number
      type: string
    }
    expect(mod).toEqual({ bytes: 12, type: 'application/wasm' })
    expect(seen.map((p) => p.loaded)).toEqual([0, 3, 7, 12])
    expect(seen.every((p) => p.total === 12)).toBe(true)
  })

  it('fails on an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(fetchAndCompile('/x.wasm', 0, undefined, { fetchImpl, compile: drain })).rejects.toThrow('HTTP 404')
  })

  it('a slow download that keeps receiving bytes is never cut off (no chunk timeout)', async () => {
    const chunks = Array.from({ length: 6 }, () => new Uint8Array(10))
    const fetchImpl = vi.fn(async () => new Response(streamOf(chunks, 30), { status: 200 }))
    // Total time ~180 ms, far past the 50 ms stall limit; each gap is under it.
    const mod = (await fetchAndCompile('/x.wasm', 60, undefined, { fetchImpl, compile: drain, stallMs: 50 })) as unknown as {
      bytes: number
    }
    expect(mod.bytes).toBe(60)
  })

  it('aborts a download that stops receiving bytes', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5))
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { status: 200 })
    })
    await expect(
      fetchAndCompile('/x.wasm', 100, undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, compile: drain, stallMs: 40 }),
    ).rejects.toThrow(/stalled/)
  })

  it('reads a file: URL from disk (Node, where the live tests run outside webpack)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wasm-fetch-'))
    // The smallest valid module: the magic number and version 1.
    await writeFile(join(dir, 'm.wasm'), new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    const seen: number[] = []
    const mod = await fetchAndCompile(pathToFileURL(join(dir, 'm.wasm')), 8, (p) => seen.push(p.loaded))
    expect(mod).toBeInstanceOf(WebAssembly.Module)
    expect(seen.at(-1)).toBe(8)
  })

  it('never reads a relative URL from disk', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }))
    try {
      await expect(fetchAndCompile('/x.wasm', 0)).rejects.toThrow('HTTP 404')
      expect(fetchSpy).toHaveBeenCalledWith('/x.wasm', expect.anything())
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('fetchAndCompileWithRetry (L-19)', () => {
  /** A body that errors after its first chunk, as a reset connection does. */
  const broken = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4))
          controller.error(new TypeError('Failed to read from a ReadableStream'))
        },
      }),
      { status: 200 },
    )

  it('retries a stream that fails mid-body, and succeeds on the next attempt', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => (++calls === 1 ? broken() : new Response(streamOf([new Uint8Array(8)]), { status: 200 })))
    const mod = (await fetchAndCompileWithRetry('/x.wasm', 8, undefined, { fetchImpl, compile: drain, retryMs: [1, 1] })) as unknown as { bytes: number }
    expect(mod.bytes).toBe(8)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after the retries, with the last error', async () => {
    const fetchImpl = vi.fn(async () => broken())
    await expect(fetchAndCompileWithRetry('/x.wasm', 8, undefined, { fetchImpl, compile: drain, retryMs: [1, 1] })).rejects.toThrow(/ReadableStream/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry an HTTP 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404 }))
    await expect(fetchAndCompileWithRetry('/x.wasm', 0, undefined, { fetchImpl, compile: drain, retryMs: [1, 1] })).rejects.toThrow('HTTP 404')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('fetchAndCompile: a server that never answers', () => {
  it('aborts a request that stalls before its response headers arrive', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    await expect(
      fetchAndCompile('/x.wasm', 100, undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, compile: drain, stallMs: 40 }),
    ).rejects.toThrow(/stalled/)
  })
})

describe('compileWasm', () => {
  it('forgets a failed download, so the next call fetches again', async () => {
    vi.resetModules()
    const fetchMock = vi
      .fn()
      // A 4xx is not retried within one download, so the first call fails at once.
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(new Response(streamOf([new Uint8Array(4)]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const compiled = {} as WebAssembly.Module
    vi.spyOn(WebAssembly, 'compile').mockResolvedValue(compiled)
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async (r) => {
      await (await r).arrayBuffer()
      return compiled
    })
    const { compileWasm } = await import('./wasm-fetch')
    await expect(compileWasm()).rejects.toThrow('HTTP 404')
    await Promise.resolve()
    await expect(compileWasm()).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
