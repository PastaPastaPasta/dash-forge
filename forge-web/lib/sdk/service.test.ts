import { describe, expect, it, vi } from 'vitest'
import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  CONNECT_BACKOFF_MS,
  EvoSdkService,
  REFRESH_MS,
  RECOVER_GAP_MS,
  isStaleConnectionError,
  type Clock,
  type Connection,
  type EvoSdkConfig,
} from './service'

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
function fakeSdk(label: string, reply: (q: unknown) => Promise<unknown>) {
  const create = vi.fn(async () => `created by ${label}`)
  return {
    label,
    create,
    sdk: {
      label,
      documents: { query: vi.fn(reply), create },
      stateTransitions: { broadcastStateTransition: vi.fn(async () => label) },
      version: () => 14,
    } as unknown as EvoSDK & { label: string },
  }
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

describe('isStaleConnectionError', () => {
  it('matches the rotated-quorum and banned-nodes errors only', () => {
    expect(isStaleConnectionError(QUORUM_GONE)).toBe(true)
    expect(isStaleConnectionError({ message: 'no available addresses to use' })).toBe(true)
    expect(isStaleConnectionError(new Error('document type not found'))).toBe(false)
    expect(isStaleConnectionError(new Error('Invalid proof'))).toBe(false)
  })
})
