/** Small helpers shared by the live test (`./probe`) and the upload path (`./upload`). */

/** Whether `a` and `b` hold the same bytes. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The message of a thrown value, as a row detail or a failure reason. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A response is expected to begin within this long (a dead or silent host). */
export const CONNECT_MS = 15_000
/** A response body may pause this long between chunks before it is abandoned. */
export const IDLE_MS = 120_000
/**
 * The slowest upload rate assumed when a request carries a body: `fetch` reports no upload
 * progress, so the wait for the response grows with the body instead of being one fixed cap.
 * 16 KiB/s is well below any usable uplink; a stall still ends within `CONNECT_MS + IDLE_MS`
 * plus the body at that rate.
 */
const MIN_UPLOAD_BYTES_PER_S = 16 * 1024

/** The request timed out (no answer, or the body stalled). */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** A response whose body is read with an idle deadline re-armed on every chunk. */
export interface TimedResponse {
  readonly resp: Response
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  /** Done without the body (a HEAD, a status-only answer): clear the deadline, drop the body. */
  discard(): void
}

/**
 * `fetch` with progress deadlines rather than one total cap (forge-core's clients use a 15 s
 * connect and a 120 s read timeout): the response must begin within {@link CONNECT_MS} (plus
 * the upload time of `uploadBytes` at a conservative rate), then the body may stream for as
 * long as it keeps moving, pausing at most {@link IDLE_MS}.
 */
export async function timedFetch(
  url: string | URL,
  init: RequestInit,
  opts: { readonly uploadBytes?: number; readonly signal?: AbortSignal; readonly idleMs?: number } = {},
): Promise<TimedResponse> {
  const controller = new AbortController()
  const idleMs = opts.idleMs ?? IDLE_MS
  let timedOut: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, why: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = why
      controller.abort()
    }, ms)
  }
  const onCancel = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onCancel)
  const uploadMs = Math.ceil(((opts.uploadBytes ?? 0) / MIN_UPLOAD_BYTES_PER_S) * 1000)
  arm(CONNECT_MS + uploadMs, `no answer within ${Math.round((CONNECT_MS + uploadMs) / 1000)}s`)
  const done = (): void => {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onCancel)
  }
  let resp: Response
  try {
    resp = await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    done()
    if (timedOut !== null) throw new TimeoutError(timedOut)
    throw e
  }
  const bytes = async (): Promise<Uint8Array> => {
    try {
      if (resp.body === null) return new Uint8Array(await resp.arrayBuffer())
      const reader = resp.body.getReader()
      const parts: Uint8Array[] = []
      let total = 0
      for (;;) {
        arm(idleMs, `the answer stalled for ${idleMs / 1000}s`)
        const { done: end, value } = await reader.read()
        if (end) break
        parts.push(value)
        total += value.length
      }
      const out = new Uint8Array(total)
      let at = 0
      for (const p of parts) {
        out.set(p, at)
        at += p.length
      }
      return out
    } catch (e) {
      if (timedOut !== null) throw new TimeoutError(timedOut)
      throw e
    } finally {
      done()
    }
  }
  const discard = (): void => {
    done()
    resp.body?.cancel().catch(() => undefined)
  }
  return { resp, bytes, text: async () => new TextDecoder().decode(await bytes()), discard }
}

/** Printable ASCII only: header values (`fetch` throws on anything else, quoting the value). */
export function isHeaderSafe(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value)
}
