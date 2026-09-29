import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { DownloadProgress } from './wasm-fetch'

// The wasm download's progress, driven by the tests (the real module fetches a file).
const progress = vi.hoisted(() => ({ listeners: new Set<(p: DownloadProgress) => void>() }))
vi.mock('./wasm-fetch', () => ({
  compileWasm: () => Promise.resolve({}),
  onWasmProgress: (l: (p: DownloadProgress) => void) => {
    progress.listeners.add(l)
    return () => progress.listeners.delete(l)
  },
}))
const emitProgress = (p: DownloadProgress): void => progress.listeners.forEach((l) => l(p))

import { dapiBudget } from './budget'
import {
  CONNECT_BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  EvoSdkService,
  FRESH_WRITE_MS,
  PROGRESS_INTERVAL_MS,
  REFRESH_MS,
  RECOVER_GAP_MS,
  RETRYABLE_READS,
  WRITE_SETTLE_MS,
  withTimeout,
  type Clock,
  type Connection,
  type EvoSdkConfig,
} from './service'
import { serialized } from './write'
import { isStaleConnectionError, isUnreachableError } from './unreachable'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  progress.listeners.clear()
})

/** A manual clock: timers fire only when the test advances time. */
function manualClock(): Clock & { advance(ms: number): Promise<void> } {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id as number)
    },
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const QUORUM_GONE = new Error('context provider error: invalid quorum: Quorum not found in cache for hash: 00ab')

/** A fake SDK whose `documents.query` answers from `reply`. */
function fakeSdk(label: string, reply: (q: unknown) => Promise<unknown>, version = 14) {
  const create = vi.fn(async () => `created by ${label}`)
  const free = vi.fn()
  return {
    label,
    create,
    free,
    sdk: {
      label,
      documents: {
        query: vi.fn(reply),
        queryWithProof: vi.fn(reply),
        create,
        replace: vi.fn(reply),
        delete: vi.fn(reply),
      },
      identities: { update: vi.fn(reply) },
      stateTransitions: { broadcastStateTransition: vi.fn(async () => label) },
      contracts: { getLatestVersions: vi.fn(async () => new Map()), fetch: vi.fn(async () => ({})) },
      wasm: { free, removeCachedContract: vi.fn(() => true) },
      version: () => version,
    } as unknown as EvoSDK & { label: string },
  }
}

/** A promise and its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const CONFIG: EvoSdkConfig = { network: 'devnet', contractIds: [] }

function connection(sdk: EvoSDK): Connection {
  return { sdk, seeded: new Map() }
}

describe('EvoSdkService: quorum refresh (D-024)', () => {
  it('builds a new connection every REFRESH_MS and the handle follows it', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => new Map([['x', 'from a']]))
    const b = fakeSdk('b', async () => new Map([['x', 'from b']]))
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const handle = svc.getSdk()
    expect(await handle.documents.query({} as never)).toEqual(new Map([['x', 'from a']]))
    expect(svc.generation).toBe(1)

    await clock.advance(REFRESH_MS)
    expect(connector).toHaveBeenCalledTimes(2)
    expect(svc.generation).toBe(2)
    // The same handle a writer or a view kept now reads through the new connection.
    expect(await handle.documents.query({} as never)).toEqual(new Map([['x', 'from b']]))
    expect(svc.getStatus().phase).toBe('ready')
  })

  it('a read that fails on a rotated quorum reconnects once and retries on the new connection', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => {
      throw QUORUM_GONE
    })
    const b = fakeSdk('b', async () => new Map([['x', 'fresh']]))
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).resolves.toEqual(new Map([['x', 'fresh']]))
    expect(connector).toHaveBeenCalledTimes(2)
    expect(a.sdk.documents.query).toHaveBeenCalledTimes(1)
    expect(b.sdk.documents.query).toHaveBeenCalledTimes(1)
  })

  it('concurrent failing reads share one reconnect', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => {
      throw QUORUM_GONE
    })
    const b = fakeSdk('b', async () => 'ok')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValue(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const h = svc.getSdk()
    const results = await Promise.all([1, 2, 3].map(() => h.documents.query({} as never)))
    expect(results).toEqual(['ok', 'ok', 'ok'])
    expect(connector).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect for ordinary errors, and never re-sends a write', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => {
      throw new Error('document type not found')
    })
    a.sdk.stateTransitions.broadcastStateTransition = vi.fn(async () => {
      throw QUORUM_GONE
    }) as never
    const connector = vi.fn().mockResolvedValue(connection(a.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toThrow('document type not found')
    await expect(svc.getSdk().stateTransitions.broadcastStateTransition({} as never)).rejects.toBe(QUORUM_GONE)
    expect(a.sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledTimes(1)
    expect(connector).toHaveBeenCalledTimes(1)
  })

  it('a call already running finishes on the connection it started on', async () => {
    const clock = manualClock()
    let release: (v: unknown) => void = () => undefined
    const a = fakeSdk('a', () => new Promise((r) => (release = r)))
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const inFlight = svc.getSdk().documents.query({} as never)
    await svc.refresh()
    release('a finished')
    await expect(inFlight).resolves.toBe('a finished')
    expect(await svc.getSdk().documents.query({} as never)).toBe('b')
  })

  it('a failed refresh keeps the current connection', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockRejectedValueOnce(new Error('Failed to prefetch quorums'))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    expect(await svc.refresh()).toBe(false)
    expect(await svc.getSdk().documents.query({} as never)).toBe('a')
    expect(svc.getStatus().phase).toBe('ready')
  })

  it('rate-limits recovery reconnects', async () => {
    const clock = manualClock()
    const failing = () =>
      fakeSdk('x', async () => {
        throw QUORUM_GONE
      }).sdk
    const connector = vi.fn().mockImplementation(async () => connection(failing()))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(connector).toHaveBeenCalledTimes(2)
    // Within the gap: fail fast without another connect.
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(connector).toHaveBeenCalledTimes(2)
    await clock.advance(RECOVER_GAP_MS)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(connector).toHaveBeenCalledTimes(3)
  })
})

describe('EvoSdkService: unreachable Platform (D-058, D-702)', () => {
  it('a failed connect reports the error, retries with backoff, and recovers', async () => {
    const clock = manualClock()
    const good = fakeSdk('good', async () => 'ok')
    const prefetch = new Error('Failed to prefetch quorums: HTTP 503')
    const connector = vi
      .fn()
      .mockRejectedValueOnce(prefetch)
      .mockRejectedValueOnce(prefetch)
      .mockResolvedValueOnce(connection(good.sdk))
    const svc = new EvoSdkService(connector, clock)
    await expect(svc.initialize(CONFIG)).rejects.toBe(prefetch)
    const status = svc.getStatus()
    expect(status.phase).toBe('error')
    expect(status.phase === 'error' && status.retryAt).toBe(clock.now() + CONNECT_BACKOFF_MS[0]!)
    expect(svc.isReady).toBe(false)

    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    expect(connector).toHaveBeenCalledTimes(2)
    const second = svc.getStatus()
    expect(second.phase === 'error' && second.retryAt).toBe(clock.now() + CONNECT_BACKOFF_MS[1]!)

    await clock.advance(CONNECT_BACKOFF_MS[1]!)
    expect(connector).toHaveBeenCalledTimes(3)
    expect(svc.getStatus().phase).toBe('ready')
    expect(svc.isTrusted).toBe(true)
    expect(await svc.getSdk().documents.query({} as never)).toBe('ok')
  })

  it('"Try again" reconnects at once; page mounts do not hammer', async () => {
    const clock = manualClock()
    const good = fakeSdk('good', async () => 'ok')
    const connector = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(connection(good.sdk))
    const svc = new EvoSdkService(connector, clock)
    await expect(svc.initialize(CONFIG)).rejects.toThrow('down')
    // Another view mounting right away gets the same failure, not a new connect.
    await expect(svc.initialize(CONFIG)).rejects.toThrow('down')
    expect(connector).toHaveBeenCalledTimes(1)
    svc.retryNow()
    await flush()
    expect(connector).toHaveBeenCalledTimes(2)
    expect(svc.getStatus().phase).toBe('ready')
    // The scheduled backoff retry was cancelled.
    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    expect(connector).toHaveBeenCalledTimes(2)
  })

  it('after a full DAPI outage the next read builds a new connection instead of staying dead', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw new Error('no available addresses to use')
    })
    const fresh = fakeSdk('fresh', async () => 'recovered')
    const connector = vi.fn().mockResolvedValueOnce(connection(dead.sdk)).mockResolvedValueOnce(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).resolves.toBe('recovered')
  })

  it('a read that cannot recover moves the service to the unreachable state, and a later connect restores it', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const fresh = fakeSdk('fresh', async () => 'back')
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(dead.sdk))
      .mockRejectedValueOnce(new Error('Failed to prefetch quorums'))
      .mockResolvedValueOnce(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(svc.getStatus().phase).toBe('error')
    // Still connected (views keep what they read), and still trusted: nothing unverified.
    expect(svc.isReady).toBe(true)
    const before = svc.recoveryCount
    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    expect(svc.getStatus().phase).toBe('ready')
    expect(svc.recoveryCount).toBe(before + 1)
    expect(await svc.getSdk().documents.query({} as never)).toBe('back')
  })
})

describe('EvoSdkService.ensureFresh: before a write that never refreshes its quorum keys (L-06)', () => {
  it('reuses a connection at most FRESH_WRITE_MS old, else builds a new one first', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    expect(await svc.ensureFresh()).toBe(true)
    expect(connector).toHaveBeenCalledTimes(1)

    await clock.advance(FRESH_WRITE_MS + 1)
    expect(await svc.ensureFresh()).toBe(true)
    expect(connector).toHaveBeenCalledTimes(2)
    // The handle a writer already holds now sends the create on the new connection.
    await svc.getSdk().documents.create({} as never)
    expect(b.create).toHaveBeenCalledTimes(1)
    expect(a.create).not.toHaveBeenCalled()
  })

  it('a failed rebuild keeps the current connection and says so', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockRejectedValueOnce(new Error('quorum service down'))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await clock.advance(FRESH_WRITE_MS + 1)
    expect(await svc.ensureFresh()).toBe(false)
    await svc.getSdk().documents.create({} as never)
    expect(a.create).toHaveBeenCalledTimes(1)
  })

  it('is false before any connection', async () => {
    expect(await new EvoSdkService(vi.fn(), manualClock()).ensureFresh()).toBe(false)
  })
})

describe('isStaleConnectionError', () => {
  it('matches the rotated-quorum and banned-nodes errors only', () => {
    expect(isStaleConnectionError(QUORUM_GONE)).toBe(true)
    expect(isStaleConnectionError({ message: 'no available addresses to use' })).toBe(true)
    expect(isStaleConnectionError(new Error('document type not found'))).toBe(false)
    expect(isStaleConnectionError(new Error('Invalid proof'))).toBe(false)
  })
})

describe('EvoSdkService: a mount naming new contracts never strands the service (H1)', () => {
  const REPO: EvoSdkConfig = { network: 'devnet', contractIds: ['repo-core', 'repo-collab'] }

  it('a refresh racing a new-repo mount still installs, and the app stays reachable', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const b = fakeSdk('b', async () => 'b')
    const next = deferred<Connection>()
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockReturnValueOnce(next.promise)
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const refreshed = svc.refresh()
    await svc.initialize(REPO)
    next.resolve(connection(b.sdk))
    expect(await refreshed).toBe(true)
    expect(svc.generation).toBe(2)
    expect(svc.getStatus().phase).toBe('ready')
    expect(await svc.getSdk().documents.query({} as never)).toBe('b')
  })

  it('a reconnect after an outage racing a new-repo mount goes ready, not stuck connecting', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const fresh = fakeSdk('fresh', async () => 'back')
    const retry = deferred<Connection>()
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(dead.sdk))
      .mockRejectedValueOnce(new Error('Failed to prefetch quorums'))
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValue(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(svc.getStatus().phase).toBe('error')
    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    expect(connector).toHaveBeenCalledTimes(3)
    await svc.initialize(REPO)
    retry.resolve(connection(fresh.sdk))
    await flush()
    expect(svc.getStatus().phase).toBe('ready')
    expect(await svc.getSdk().documents.query({} as never)).toBe('back')
    // The mount's ids joined the config instead of replacing it.
    await clock.advance(REFRESH_MS)
    expect(connector).toHaveBeenCalledTimes(4)
  })
})

describe('EvoSdkService: a refresh keeps the learned protocol version (M1)', () => {
  it('after a swap the handle reports the version the old connection proved, not the new floor', async () => {
    const clock = manualClock()
    const learned = fakeSdk('learned', async () => 'x', 14)
    const floor = fakeSdk('floor', async () => 'y', 13)
    const connector = vi.fn().mockResolvedValueOnce(connection(learned.sdk)).mockResolvedValueOnce(connection(floor.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    expect(svc.getSdk().version()).toBe(14)
    await svc.refresh()
    // A write derives its document id from `sdk.version()` (write.ts signCreate).
    expect(svc.getSdk().version()).toBe(14)
  })
})

describe('EvoSdkService: concurrent reads share one recovery, including its wait (M2)', () => {
  it('reads failing with "no available addresses" during the rate-limit wait all succeed after one reconnect', async () => {
    const clock = manualClock()
    vi.spyOn(dapiBudget, 'retryAfterMs').mockReturnValue(10_000)
    const dead = fakeSdk('dead', async () => {
      throw new Error('no available addresses to use')
    })
    const fresh = fakeSdk('fresh', async () => 'ok')
    const connector = vi.fn().mockResolvedValueOnce(connection(dead.sdk)).mockResolvedValue(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const h = svc.getSdk()
    const first = h.documents.query({} as never)
    await clock.advance(1_000)
    const later = [h.documents.query({} as never), h.documents.query({} as never)]
    await clock.advance(10_000)
    expect(await Promise.all([first, ...later])).toEqual(['ok', 'ok', 'ok'])
    expect(connector).toHaveBeenCalledTimes(2)
  })
})

describe('EvoSdkService: outage retries (L1)', () => {
  it('a navigation during an outage waits for retryAt; only "Try again" skips it', async () => {
    const clock = manualClock()
    const good = fakeSdk('good', async () => 'ok')
    const connector = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(connection(good.sdk))
    const svc = new EvoSdkService(connector, clock)
    await expect(svc.initialize(CONFIG)).rejects.toThrow('down')
    // Well past any mount gap, still before the scheduled retry.
    await clock.advance(CONNECT_BACKOFF_MS[0]! - 1)
    await expect(svc.initialize(CONFIG)).rejects.toThrow('down')
    expect(connector).toHaveBeenCalledTimes(1)
    svc.retryNow()
    await flush()
    expect(connector).toHaveBeenCalledTimes(2)
    expect(svc.getStatus().phase).toBe('ready')
  })
})

describe('EvoSdkService: what a refresh preloads (L2) and revalidates (S2)', () => {
  it('a refresh preloads only the contracts pages read recently, not every id ever named', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const connector = vi.fn().mockResolvedValue(connection(a.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize({ network: 'devnet', contractIds: ['dpns', 'repo-1', 'repo-2', 'repo-3'] })
    expect(connector.mock.calls[0]![0].contractIds).toEqual(['dpns', 'repo-1', 'repo-2', 'repo-3'])
    await svc.getSdk().documents.query({ dataContractId: 'repo-2' } as never)
    await svc.refresh()
    expect(connector.mock.calls[1]![0].contractIds).toEqual(['repo-2'])
  })

  it('every connection revalidates its seeded snapshots, and an outdated one is not seeded again', async () => {
    const clock = manualClock()
    const first = fakeSdk('first', async () => 'x')
    const second = fakeSdk('second', async () => 'y')
    // The second connection learns the network moved forge-collab on to version 2.
    ;(second.sdk.contracts.getLatestVersions as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['collab', { version: 2 }]]))
    const third = fakeSdk('third', async () => 'z')
    const connector = vi
      .fn()
      .mockResolvedValueOnce({ sdk: first.sdk, seeded: new Map([['collab', 1]]) })
      .mockResolvedValueOnce({ sdk: second.sdk, seeded: new Map([['collab', 1]]) })
      .mockResolvedValueOnce({ sdk: third.sdk, seeded: new Map() })
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await svc.refresh()
    await flush()
    // Before, only the first connection checked: a refresh re-seeded the old snapshot unchecked.
    expect(second.sdk.contracts.getLatestVersions).toHaveBeenCalledWith({ contractIds: ['collab'] })
    await svc.refresh()
    expect([...connector.mock.calls[2]![1].outdated]).toEqual(['collab'])
  })
})

describe('EvoSdkService: download progress (L4, L5)', () => {
  it('a wallet-only wasm load does not move an idle service into "downloading"', () => {
    const svc = new EvoSdkService(vi.fn(), manualClock())
    emitProgress({ loaded: 10, total: 100 })
    expect(svc.getStatus().phase).toBe('idle')
  })

  it('progress reaches the UI at most every PROGRESS_INTERVAL_MS, then "Connecting…" once every byte is in', async () => {
    const clock = manualClock()
    const pending = deferred<Connection>()
    const svc = new EvoSdkService(vi.fn().mockReturnValue(pending.promise), clock)
    const seen: string[] = []
    svc.subscribe(() => seen.push(svc.getStatus().phase))
    void svc.initialize(CONFIG).catch(() => undefined)
    seen.length = 0
    for (let i = 1; i <= 20; i++) {
      emitProgress({ loaded: i, total: 100 })
      await clock.advance(10)
    }
    // 200 ms of events: the first shows at once, the rest coalesce into at most one more.
    expect(seen.filter((p) => p === 'downloading').length).toBeLessThanOrEqual(2)
    await clock.advance(PROGRESS_INTERVAL_MS)
    const shown = svc.getStatus()
    expect(shown.phase === 'downloading' && shown.progress.loaded).toBe(20)
    emitProgress({ loaded: 100, total: 100 })
    expect(svc.getStatus().phase).toBe('connecting')
  })
})

describe('EvoSdkService: superseded connections (L7)', () => {
  it('a swap frees the old connection, and cleanup aborts and drops an attempt still running', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const b = fakeSdk('b', async () => 'b')
    const late = fakeSdk('late', async () => 'late')
    const pending = deferred<Connection>()
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(a.sdk))
      .mockResolvedValueOnce(connection(b.sdk))
      .mockReturnValueOnce(pending.promise)
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await svc.refresh()
    expect(a.free).toHaveBeenCalledTimes(1)
    const refreshing = svc.refresh()
    const signal = connector.mock.calls[2]![2] as AbortSignal
    svc.cleanup()
    expect(signal.aborted).toBe(true)
    expect(b.free).toHaveBeenCalledTimes(1)
    pending.resolve(connection(late.sdk))
    expect(await refreshing).toBe(false)
    expect(late.free).toHaveBeenCalledTimes(1)
    expect(svc.isReady).toBe(false)
  })
})

describe('EvoSdkService: which calls are retried (L8)', () => {
  it('retries the *WithProof reads, keyed by facade and method', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => {
      throw QUORUM_GONE
    })
    const b = fakeSdk('b', async () => 'proved')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect((svc.getSdk().documents as unknown as { queryWithProof(q: unknown): Promise<unknown> }).queryWithProof({})).resolves.toBe('proved')
    expect(RETRYABLE_READS.has('documents.queryWithProof')).toBe(true)
    expect(RETRYABLE_READS.has('identities.fetchWithProof')).toBe(true)
    expect(RETRYABLE_READS.has('documents.replace')).toBe(false)
    expect(RETRYABLE_READS.has('tokens.balances')).toBe(false)
  })

  it('runs documents.create/replace/delete and identity updates once on a stale-quorum error', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => {
      throw QUORUM_GONE
    })
    const connector = vi.fn().mockResolvedValue(connection(a.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const h = svc.getSdk() as unknown as {
      documents: Record<'replace' | 'delete', (o: unknown) => Promise<unknown>>
      identities: { update(o: unknown): Promise<unknown> }
    }
    await expect(h.documents.replace({})).rejects.toBe(QUORUM_GONE)
    await expect(h.documents.delete({})).rejects.toBe(QUORUM_GONE)
    await expect(h.identities.update({})).rejects.toBe(QUORUM_GONE)
    expect(a.sdk.documents.replace).toHaveBeenCalledTimes(1)
    expect(a.sdk.documents.delete).toHaveBeenCalledTimes(1)
    expect((a.sdk as unknown as { identities: { update: ReturnType<typeof vi.fn> } }).identities.update).toHaveBeenCalledTimes(1)
    expect(connector).toHaveBeenCalledTimes(1)
  })
})

describe('EvoSdkService: no swap under a write (S1)', () => {
  it('a refresh that completes during a write installs only after it ends and nodes caught up', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const write = deferred<string>()
    const writing = svc.holdForWrite(() => write.promise)
    const refreshed = svc.refresh()
    await flush()
    // The replacement is connected, but the write's nonces live in connection a.
    expect(connector).toHaveBeenCalledTimes(2)
    expect(svc.generation).toBe(1)
    write.resolve('landed')
    expect(await writing).toBe('landed')
    await clock.advance(WRITE_SETTLE_MS - 1)
    expect(svc.generation).toBe(1)
    await clock.advance(1)
    expect(await refreshed).toBe(true)
    expect(svc.generation).toBe(2)
  })

  it('every serialized write holds the app connection', async () => {
    const { evoSdkService } = await import('./service')
    const hold = vi.spyOn(evoSdkService, 'holdForWrite')
    await serialized('id-hold', async () => 'done')
    expect(hold).toHaveBeenCalledTimes(1)
  })
})

describe('EvoSdkService: a hidden tab', () => {
  it('defers the periodic refresh until the tab is shown', async () => {
    let onVisible: () => void = () => undefined
    const doc = { visibilityState: 'hidden', addEventListener: (_: string, fn: () => void) => (onVisible = fn) }
    vi.stubGlobal('document', doc)
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const connector = vi.fn().mockResolvedValue(connection(a.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await clock.advance(REFRESH_MS)
    expect(connector).toHaveBeenCalledTimes(1)
    doc.visibilityState = 'visible'
    onVisible()
    await flush()
    expect(connector).toHaveBeenCalledTimes(2)
    expect(svc.generation).toBe(2)
  })
})

describe('isUnreachableError (M3)', () => {
  it('covers stale connections and transport failures, never proof or decode failures', () => {
    expect(isUnreachableError(QUORUM_GONE)).toBe(true)
    expect(isUnreachableError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUnreachableError(new Error('Connecting to Platform timed out after 60 s'))).toBe(true)
    expect(isUnreachableError(new Error('dapi client error: status: Unavailable'))).toBe(true)
    expect(isUnreachableError(new Error('proof verification error: invalid signature'))).toBe(false)
    expect(isUnreachableError(new Error('Invalid proof'))).toBe(false)
    expect(isUnreachableError(new Error('failed to decode document: unexpected end of input'))).toBe(false)
  })
})

describe('the connect deadline', () => {
  it('rejects after CONNECT_TIMEOUT_MS and aborts the abandoned connect', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const hung = new Promise<never>(() => undefined)
      const run = withTimeout(hung, CONNECT_TIMEOUT_MS, 'Connecting to Platform', controller)
      const check = expect(run).rejects.toThrow('Connecting to Platform timed out after 60 s')
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      await check
      expect(controller.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('EvoSdkService: a write whose own read hits a rotated quorum', () => {
  it('recovers under the write instead of waiting for it (no deadlock)', async () => {
    const clock = manualClock()
    const stale = fakeSdk('stale', async () => {
      throw QUORUM_GONE
    })
    const fresh = fakeSdk('fresh', async () => 'nonce 7')
    const connector = vi.fn().mockResolvedValueOnce(connection(stale.sdk)).mockResolvedValueOnce(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const h = svc.getSdk()
    // e.g. the contract-nonce read inside createDocument, under the writer lock.
    const write = svc.holdForWrite(() => h.documents.query({} as never))
    await flush()
    await expect(write).resolves.toBe('nonce 7')
    expect(svc.generation).toBe(2)
  })
})

describe('EvoSdkService: an outage after a connect keeps retrying', () => {
  it('a failed retry schedules the next one with a longer backoff', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const fresh = fakeSdk('fresh', async () => 'back')
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(dead.sdk))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    expect(connector).toHaveBeenCalledTimes(3)
    const status = svc.getStatus()
    expect(status.phase === 'error' && status.retryAt).toBe(clock.now() + CONNECT_BACKOFF_MS[1]!)
    await clock.advance(CONNECT_BACKOFF_MS[1]!)
    expect(svc.getStatus().phase).toBe('ready')
  })
})

describe('EvoSdkService: freeing a replaced connection', () => {
  it('waits for a call still running on it (an explicit free of a borrowed wasm object traps)', async () => {
    const clock = manualClock()
    const slow = deferred<unknown>()
    const a = fakeSdk('a', () => slow.promise)
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const running = svc.getSdk().documents.query({} as never)
    await svc.refresh()
    expect(a.free).not.toHaveBeenCalled()
    slow.resolve('a done')
    await expect(running).resolves.toBe('a done')
    await flush()
    expect(a.free).toHaveBeenCalledTimes(1)
  })
})

describe('EvoSdkService: preloads count as calls on their connection', () => {
  it('a swap during a mount-time preload frees the old connection only after the preload ends', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const slow = deferred<unknown>()
    ;(a.sdk.contracts.fetch as ReturnType<typeof vi.fn>).mockReturnValue(slow.promise)
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const mounting = svc.initialize({ network: 'devnet', contractIds: ['new-repo'] })
    await svc.refresh()
    expect(a.free).not.toHaveBeenCalled()
    slow.resolve({})
    await mounting
    await flush()
    expect(a.free).toHaveBeenCalledTimes(1)
  })
})

describe('EvoSdkService: review follow-ups', () => {
  it('reads failing during an outage neither reconnect nor push the scheduled retry back', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const connector = vi.fn().mockResolvedValueOnce(connection(dead.sdk)).mockRejectedValue(new Error('down'))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    // Two scheduled retries fail: the next one is 30 s out, past the read-recovery gap.
    await clock.advance(CONNECT_BACKOFF_MS[0]!)
    await clock.advance(CONNECT_BACKOFF_MS[1]!)
    expect(connector).toHaveBeenCalledTimes(4)
    const scheduled = svc.getStatus()
    const retryAt = scheduled.phase === 'error' ? scheduled.retryAt : null
    expect(retryAt).toBe(clock.now() + CONNECT_BACKOFF_MS[2]!)
    await clock.advance(RECOVER_GAP_MS + 1)
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(connector).toHaveBeenCalledTimes(4)
    const later = svc.getStatus()
    expect(later.phase === 'error' && later.retryAt).toBe(retryAt)
  })

  it('"Try again" swaps at once instead of waiting out the write settle', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const fresh = fakeSdk('fresh', async () => 'back')
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(dead.sdk))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(connection(fresh.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    await svc.holdForWrite(async () => 'a write just ended')
    await expect(svc.getSdk().documents.query({} as never)).rejects.toBe(QUORUM_GONE)
    expect(svc.getStatus().phase).toBe('error')
    svc.retryNow()
    await flush()
    expect(svc.getStatus().phase).toBe('ready')
  })

  it('a refresh held back by writes for a whole period gives up rather than install old keys', async () => {
    const clock = manualClock()
    const a = fakeSdk('a', async () => 'a')
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const stuck = deferred<void>()
    void svc.holdForWrite(() => stuck.promise)
    const refreshed = svc.refresh()
    await flush()
    await clock.advance(REFRESH_MS)
    expect(await refreshed).toBe(false)
    expect(b.free).toHaveBeenCalledTimes(1)
    expect(svc.generation).toBe(1)
    stuck.resolve()
  })

  it('tracks top-level handle methods like facade calls', async () => {
    const clock = manualClock()
    const slow = deferred<unknown>()
    const a = fakeSdk('a', async () => 'a')
    ;(a.sdk as unknown as { getWasmSdkConnected: () => Promise<unknown> }).getWasmSdkConnected = () => slow.promise
    const b = fakeSdk('b', async () => 'b')
    const connector = vi.fn().mockResolvedValueOnce(connection(a.sdk)).mockResolvedValueOnce(connection(b.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    const running = (svc.getSdk() as unknown as { getWasmSdkConnected: () => Promise<unknown> }).getWasmSdkConnected()
    await svc.refresh()
    expect(a.free).not.toHaveBeenCalled()
    slow.resolve('w')
    await running
    await flush()
    expect(a.free).toHaveBeenCalledTimes(1)
  })
})

describe('EvoSdkService: cleanup clears an urgent swap', () => {
  it('a later routine refresh still waits for a running write', async () => {
    const clock = manualClock()
    const dead = fakeSdk('dead', async () => {
      throw QUORUM_GONE
    })
    const pending = deferred<Connection>()
    const c = fakeSdk('c', async () => 'c')
    const d = fakeSdk('d', async () => 'd')
    const connector = vi
      .fn()
      .mockResolvedValueOnce(connection(dead.sdk))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(connection(c.sdk))
      .mockResolvedValueOnce(connection(d.sdk))
    const svc = new EvoSdkService(connector, clock)
    await svc.initialize(CONFIG)
    // A failing read urges its recovery's swap; the network switch cleans up before it lands.
    void svc.getSdk().documents.query({} as never).catch(() => undefined)
    await flush()
    svc.cleanup()
    await svc.initialize(CONFIG)
    const write = deferred<void>()
    void svc.holdForWrite(() => write.promise)
    const refreshed = svc.refresh()
    await flush()
    expect(svc.generation).toBe(2)
    write.resolve()
    await flush()
    await clock.advance(WRITE_SETTLE_MS)
    expect(await refreshed).toBe(true)
    expect(svc.generation).toBe(3)
  })
})
