import { describe, expect, it, vi } from 'vitest'

import { fetchAndCompile, type DownloadProgress } from './wasm-fetch'

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
})
