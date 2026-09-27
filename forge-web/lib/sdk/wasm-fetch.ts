/**
 * The Platform SDK's WebAssembly, fetched on its own (D-025).
 *
 * The published `@dashevo/evo-sdk` bundle inlines the 23 MB wasm as a base64 gzip string, so
 * the whole SDK was one ~8 MB (gzipped) JS chunk: webpack's chunk-load timeout killed it on a
 * slow link, it could not report progress, and a failed load could not be retried.
 * `next.config.js` builds the SDK from its unbundled modules instead, with `wasm-shim.ts` in
 * place of its wasm loader, and this module fetches the `.wasm` as a separate static asset: a
 * plain `fetch` (no chunk timeout), counted as it streams in (progress), compiled while it
 * downloads (`compileStreaming`), content-hashed and cacheable, and fetched again by the next
 * call after a failure.
 */

/** Download progress in bytes of wasm received (after any transfer encoding is undone). */
export interface DownloadProgress {
  readonly loaded: number
  /** The wasm's size, recorded at build time; 0 when unknown. */
  readonly total: number
}

/** A download that receives nothing for this long is abandoned (the next call starts over). */
const STALL_MS = 60_000

/** The wasm's byte size, recorded by `next.config.js` at build time. */
const WASM_BYTES = Number(process.env.FORGE_WASM_SDK_BYTES) || 0

export interface FetchWasmOptions {
  readonly fetchImpl?: typeof fetch
  readonly stallMs?: number
  readonly compile?: (response: Response) => Promise<WebAssembly.Module>
}

/**
 * `fetch`, except that a `file:` URL is read from disk. Outside webpack (vitest in Node, which
 * runs the live tests) `new URL(…, import.meta.url)` stays a `file:` URL, and Node's `fetch`
 * does not implement that scheme. The browser only ever sees the http(s) asset URL.
 */
const defaultFetch: typeof fetch = async (input, init) => {
  // Only an explicit file: URL goes to disk; a relative or http(s) URL is always fetched.
  const href = input instanceof Request ? input.url : String(input)
  if (!href.startsWith('file:')) return fetch(input, init)
  const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises')
  return new Response(await readFile(new URL(href)))
}

async function compileResponse(response: Response): Promise<WebAssembly.Module> {
  if (typeof WebAssembly.compileStreaming === 'function') return WebAssembly.compileStreaming(response)
  return WebAssembly.compile(await response.arrayBuffer())
}

/**
 * Fetch `url` and compile it as it streams in, reporting each chunk to `onProgress`. Rejects on
 * an HTTP error, a network error, or `stallMs` without a byte.
 */
export async function fetchAndCompile(
  url: string | URL,
  total: number,
  onProgress?: (p: DownloadProgress) => void,
  { fetchImpl = defaultFetch, stallMs = STALL_MS, compile = compileResponse }: FetchWasmOptions = {},
): Promise<WebAssembly.Module> {
  const controller = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, stallMs)
  }
  arm()
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok || response.body === null) {
      throw new Error(`the Platform SDK download failed (HTTP ${response.status})`)
    }
    let loaded = 0
    onProgress?.({ loaded, total })
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          loaded += chunk.byteLength
          arm()
          onProgress?.({ loaded, total })
          out.enqueue(chunk)
        },
      }),
    )
    // Set the type here rather than trusting the host: `compileStreaming` needs application/wasm.
    return await compile(new Response(counted, { headers: { 'content-type': 'application/wasm' } }))
  } catch (e) {
    if (stalled) throw new Error(`the Platform SDK download stalled (nothing received for ${Math.round(stallMs / 1000)} s)`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Waits before each automatic retry of a failed download (L-19). */
export const DOWNLOAD_RETRY_MS: readonly number[] = [1_000, 3_000]

/**
 * {@link fetchAndCompile}, retried after a transient failure: a reset connection or a stream
 * that errors mid-body ("Failed to read from a ReadableStream", a QUIC reset on a cold profile)
 * usually succeeds at once on a second try. An HTTP 4xx is not transient and is not retried.
 */
export async function fetchAndCompileWithRetry(
  url: string | URL,
  total: number,
  onProgress?: (p: DownloadProgress) => void,
  options: FetchWasmOptions & { readonly retryMs?: readonly number[] } = {},
): Promise<WebAssembly.Module> {
  const waits = options.retryMs ?? DOWNLOAD_RETRY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchAndCompile(url, total, onProgress, options)
    } catch (e) {
      // Not worth another download: a client error (except timeout / too many requests), or a
      // body that is not wasm (a stale deploy serving HTML), which fails the same way again.
      const permanent =
        (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.CompileError) ||
        (e instanceof Error && /HTTP 4(?!08|29)\d\d/.test(e.message))
      const wait = waits[attempt]
      if (permanent || wait === undefined) throw e
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

const listeners = new Set<(p: DownloadProgress) => void>()

/** Follow the SDK download's progress. Returns the unsubscribe. */
export function onWasmProgress(listener: (p: DownloadProgress) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let compiled: Promise<WebAssembly.Module> | null = null

/**
 * The compiled SDK wasm, downloaded once per page. A failed attempt is forgotten, so the next
 * call downloads again.
 */
export function compileWasm(): Promise<WebAssembly.Module> {
  if (compiled === null) {
    // webpack emits the file as a hashed static asset and rewrites this to its URL (a
    // `new URL` specifier is a URL, so the path is relative, not a package name).
    const url = new URL('../../node_modules/@dashevo/wasm-sdk/dist/raw/wasm_sdk_bg.wasm', import.meta.url)
    const run = fetchAndCompileWithRetry(url, WASM_BYTES, (p) => listeners.forEach((l) => l(p)))
    compiled = run
    run.catch(() => {
      if (compiled === run) compiled = null
    })
  }
  return compiled
}
