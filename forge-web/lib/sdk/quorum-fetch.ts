/**
 * The quorum key requests a trusted connect sends (`<quorum service>/quorums`, `/previous`,
 * `/masternodes`), on this app's terms. wasm-sdk aborts each one about 5 s after it starts and
 * the connect then fails, so on a link where every request takes 6 s the keys never arrive and
 * the page never loads, however often it retries. Here a quorum request:
 *
 *   - ignores the SDK's own abort and gets {@link QUORUM_FETCH_TIMEOUT_MS} instead;
 *   - is kept, when it succeeds, so the next connect in this browser has the keys even if the
 *     service is slow or down then ({@link QUORUM_CACHE_MAX_AGE_MS});
 *   - fails over to those kept keys when the service does not answer in time. A kept list that
 *     misses a newer quorum fails the read that needs it with "Quorum not found", which the
 *     service already recovers from by reconnecting (D-024).
 *
 * The keys are public (anyone can fetch them), so keeping them in localStorage leaks nothing.
 * Because the SDK's abort is ignored, a connect that times out or is torn down leaves a quorum
 * request in flight until its own {@link QUORUM_FETCH_TIMEOUT_MS}; its answer is then only kept.
 */

/** How long one quorum key request may take before it fails over to the kept keys. */
export const QUORUM_FETCH_TIMEOUT_MS = 20_000
/** Kept keys older than this are not used: a list that old misses most of the active quorums. */
export const QUORUM_CACHE_MAX_AGE_MS = 24 * 60 * 60_000

/** How far ahead of this clock a kept entry's time may be before it is ignored. */
const QUORUM_CLOCK_SKEW_MS = 5 * 60_000

const KEY_PREFIX = 'forge.quorumKeys.'
const PATHS = new Set(['quorums', 'previous', 'masternodes'])

export interface QuorumStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Kept {
  readonly at: number
  readonly body: string
}

export interface QuorumFetchDeps {
  readonly storage: () => QuorumStorage | null
  readonly now: () => number
  /** Called when a request was answered from the kept keys, with when they were fetched. */
  readonly onCached?: (fetchedAt: number) => void
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Whether `url` is a quorum key request to the service at `base` (no trailing slash). */
export function isQuorumKeyRequest(url: string, base: string): boolean {
  if (base === '' || !url.startsWith(`${base}/`)) return false
  const rest = url.slice(base.length + 1).split(/[?#]/)[0] ?? ''
  return PATHS.has(rest.replace(/\/+$/, ''))
}

function read(storage: QuorumStorage | null, url: string): Kept | null {
  try {
    const raw = storage?.getItem(KEY_PREFIX + url)
    if (!raw) return null
    const kept = JSON.parse(raw) as Partial<Kept>
    return typeof kept.at === 'number' && typeof kept.body === 'string' ? { at: kept.at, body: kept.body } : null
  } catch {
    return null
  }
}

function keep(storage: QuorumStorage | null, url: string, kept: Kept): void {
  try {
    storage?.setItem(KEY_PREFIX + url, JSON.stringify(kept))
  } catch {
    // Storage full or blocked: the next connect fetches again.
  }
}

/** A kept answer as a response for `url`: the SDK parses `response.url`, which a built one leaves empty. */
function json(body: string, url: string): Response {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

/**
 * A well-formed quorum service answer, the only kind kept: `{"success":true,"data":…}` with a
 * non-empty list (`/quorums`, `/masternodes`) or an object (`/previous` is `{height, quorums}`).
 * An empty list from a broken service never replaces keys kept earlier.
 */
function keepable(body: string): boolean {
  try {
    const v = JSON.parse(body) as { success?: unknown; data?: unknown }
    if (v.success !== true || typeof v.data !== 'object' || v.data === null) return false
    return !Array.isArray(v.data) || v.data.length > 0
  } catch {
    return false
  }
}

/**
 * `base` with quorum key requests to `quorumBase()` handled as described above; every other
 * request passes through untouched.
 */
export function quorumFetch(base: typeof fetch, quorumBase: () => string, deps: QuorumFetchDeps): typeof fetch {
  /** The kept answer for `url`, when there is one young enough. */
  const fromKept = (storage: QuorumStorage | null, url: string): Response | null => {
    const kept = read(storage, url)
    // An entry from the future (a clock that was ahead, or a planted value) would never expire.
    const age = kept === null ? 0 : deps.now() - kept.at
    if (kept === null || age > QUORUM_CACHE_MAX_AGE_MS || age < -QUORUM_CLOCK_SKEW_MS) return null
    deps.onCached?.(kept.at)
    return json(kept.body, url)
  }
  return async (input, init) => {
    const url = urlOf(input)
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    if (method !== 'GET' || !isQuorumKeyRequest(url, quorumBase())) return base(input, init)
    const storage = deps.storage()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QUORUM_FETCH_TIMEOUT_MS)
    try {
      // The SDK's signal is left out on purpose: it aborts after ~5 s (see the module doc).
      const response = await base(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
      // The SDK gets the real response (its `url` included); the copy kept is read from a clone.
      if (response.ok) {
        const body = await response.clone().text()
        if (keepable(body)) {
          keep(storage, url, { at: deps.now(), body })
          return response
        }
      }
      return fromKept(storage, url) ?? response
    } catch (e) {
      const kept = fromKept(storage, url)
      if (kept !== null) return kept
      if (controller.signal.aborted) {
        throw new TypeError(`fetching quorum keys timed out after ${Math.round(QUORUM_FETCH_TIMEOUT_MS / 1000)} s`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

const INSTALLED = Symbol.for('forge.quorumFetch')

/** Route this page's quorum key requests through {@link quorumFetch} (browser only, once). */
export function installQuorumFetch(quorumBase: () => string): void {
  if (typeof window === 'undefined') return
  const scope = globalThis as typeof globalThis & { [INSTALLED]?: true }
  if (scope[INSTALLED] || typeof scope.fetch !== 'function') return
  scope[INSTALLED] = true
  scope.fetch = quorumFetch(scope.fetch.bind(scope), quorumBase, {
    storage: () => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage
      } catch {
        return null
      }
    },
    now: () => Date.now(),
  })
}
