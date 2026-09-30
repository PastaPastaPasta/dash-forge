/**
 * {@link withPlatformRead}: a sign-in step's own {@link PLATFORM_READ_MS} deadline must not race
 * a read that is legitimately still pending because `EvoSdkService.withRecovery` is waiting out a
 * quorum rotation its quorum service does not list yet (#212, `lib/sdk/service.ts`
 * `waitForQuorum`) — the read is failing on "Quorum not found in cache" and retrying by itself,
 * and the global "Waiting for the network's new quorum…" pill already shows it
 * (`components/platform-busy.tsx`). A stall with nothing to do with a quorum rotation must still
 * fail at the usual 30 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUORUM_BUDGET_MS, evoSdkService } from '../sdk/service'
import { StepTimeoutError } from '../timeout'
import { PLATFORM_READ_MS, withPlatformRead } from './connect'

/** A promise this test settles by hand, standing in for a read `withPlatformRead` cannot see inside. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Stand in for the SDK service waiting out a quorum rotation since `since` (`null`: it is not). */
function rotationSince(since: number | null): void {
  vi.spyOn(evoSdkService, 'quorumWaitSince', 'get').mockReturnValue(since)
}

describe('withPlatformRead', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("extends past PLATFORM_READ_MS while a quorum rotation is waited out, and resolves once the SDK's own retry lands", async () => {
    rotationSince(Date.now())
    const { promise, resolve } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the identity of these words')
    let settled = false
    void result.then(
      () => (settled = true),
      () => (settled = true),
    )

    // The step's own 30 s cap passes: with a rotation in progress the read is not cut off here.
    await vi.advanceTimersByTimeAsync(PLATFORM_READ_MS)
    expect(settled).toBe(false)

    // Still inside the rotation's 120 s budget: still waiting on the same read.
    await vi.advanceTimersByTimeAsync(QUORUM_BUDGET_MS - PLATFORM_READ_MS - 5_000)
    expect(settled).toBe(false)

    // The next attempt, inside evo-sdk's own reconnect-and-retry, lands.
    resolve('HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr')
    await expect(result).resolves.toBe('HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr')
  })

  it('still fails at PLATFORM_READ_MS when nothing points to a quorum rotation (today\'s timing)', async () => {
    rotationSince(null)
    const { promise } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the wallet login contract')
    const assertion = expect(result).rejects.toBeInstanceOf(StepTimeoutError)
    await vi.advanceTimersByTimeAsync(PLATFORM_READ_MS)
    await assertion
  })

  it("still fails once the rotation it was waiting out has already spent its own budget (no room to extend into)", async () => {
    // A rotation that started well past its own 120 s budget: nothing left to extend into, so the
    // ordinary PLATFORM_READ_MS timeout applies (not a hang, and not a fabricated fail-fast path).
    rotationSince(Date.now() - QUORUM_BUDGET_MS - 1_000)
    const { promise } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the identity of these words')
    const assertion = expect(result).rejects.toBeInstanceOf(StepTimeoutError)
    await vi.advanceTimersByTimeAsync(PLATFORM_READ_MS)
    await assertion
  })

  it('a non-timeout rejection passes straight through immediately, even mid rotation', async () => {
    rotationSince(Date.now())
    const failure = new Error('not proven: bad signature')
    const { promise, reject } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the identity of these words')
    const assertion = expect(result).rejects.toBe(failure)
    reject(failure)
    await assertion
  })

  it("still fails once the rotation's own budget elapses without the read ever settling", async () => {
    rotationSince(Date.now())
    const { promise } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the identity of these words')
    const assertion = expect(result).rejects.toBeInstanceOf(StepTimeoutError)
    await vi.advanceTimersByTimeAsync(QUORUM_BUDGET_MS)
    await assertion
  })

  it("the SDK's own error, hit again during the extended wait, reaches the caller as-is rather than as a timeout", async () => {
    rotationSince(Date.now())
    const quorumGone = new Error('context provider error: invalid quorum: Quorum not found in cache for hash: 00ab')
    const { promise, reject } = deferred<string>()
    const result = withPlatformRead(promise, 'Finding the identity of these words')
    const assertion = expect(result).rejects.toBe(quorumGone)
    // Past the step's own 30 s cap, still inside the rotation budget: the extended wait is racing
    // the same promise, and the underlying read (unseen here) fails once more on the same miss.
    await vi.advanceTimersByTimeAsync(PLATFORM_READ_MS)
    reject(quorumGone)
    await assertion
  })
})
