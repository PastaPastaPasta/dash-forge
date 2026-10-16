// @vitest-environment jsdom
/**
 * New-build detection (INC-14): the site's own manifest says which commit it serves now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHECK_EVERY_MS, MIN_GAP_MS, checkForNewBuild, isImmutableCopy, watchForNewBuild } from './new-build'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const ROOT = 'https://forge.example.org/'

function serving(manifest: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(typeof manifest === 'string' ? manifest : JSON.stringify(manifest), { status })) as unknown as typeof fetch
}

describe('checkForNewBuild', () => {
  it('same commit: nothing new', async () => {
    expect(await checkForNewBuild(ROOT, A, serving({ commit: A, variant: 'host' }))).toBe('same')
  })

  it('a different commit: newer, asked with no-store at the site root', async () => {
    const f = serving({ commit: B, variant: 'host' })
    expect(await checkForNewBuild(ROOT, A, f)).toBe('newer')
    expect(f).toHaveBeenCalledWith('https://forge.example.org/forge-manifest.json', { cache: 'no-store' })
  })

  it('resolves the manifest under a base path', async () => {
    const f = serving({ commit: A })
    await checkForNewBuild('https://x.github.io/dash-forge/', A, f)
    expect(f).toHaveBeenCalledWith('https://x.github.io/dash-forge/forge-manifest.json', { cache: 'no-store' })
  })

  it('learns nothing without a commit baked in (dev, git-less builds)', async () => {
    const f = serving({ commit: B })
    expect(await checkForNewBuild(ROOT, '', f)).toBe('unknown')
    expect(f).not.toHaveBeenCalled()
  })

  it('learns nothing from a missing, broken or non-host manifest', async () => {
    expect(await checkForNewBuild(ROOT, A, serving('', 404))).toBe('unknown')
    expect(await checkForNewBuild(ROOT, A, serving('<html>', 200))).toBe('unknown')
    expect(await checkForNewBuild(ROOT, A, serving({ commit: null }))).toBe('unknown')
    expect(await checkForNewBuild(ROOT, A, serving({ commit: 'not-a-sha' }))).toBe('unknown')
    expect(await checkForNewBuild(ROOT, A, serving({ commit: B, variant: 'ipfs' }))).toBe('unknown')
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await checkForNewBuild(ROOT, A, offline)).toBe('unknown')
  })
})

describe('isImmutableCopy', () => {
  it('a gateway serving the app by CID never nags', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    expect(isImmutableCopy({ protocol: 'https:', hostname: `${cid}.ipfs.dweb.link`, pathname: '/' })).toBe(true)
    expect(isImmutableCopy({ protocol: 'https:', hostname: 'gateway.example', pathname: `/ipfs/${cid}/` })).toBe(true)
    expect(isImmutableCopy({ protocol: 'https:', hostname: 'forge.dashhq.org', pathname: '/' })).toBe(false)
  })
})

describe('watchForNewBuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function start(manifest: () => unknown) {
    const onNewer = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(manifest()))) as unknown as typeof fetch
    const stop = watchForNewBuild({ root: ROOT, buildCommit: A, fetchImpl, onNewer, now: () => Date.now() })
    return { onNewer, fetchImpl, stop }
  }

  it('asks every ~12 minutes while visible, and reports a newer build once', async () => {
    let served = A
    const { onNewer, fetchImpl } = start(() => ({ commit: served }))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onNewer).not.toHaveBeenCalled()
    served = B
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(onNewer).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onNewer).toHaveBeenCalledTimes(1)
  })

  it('asks when the tab is focused again, but not more than once a minute', async () => {
    const { onNewer, fetchImpl, stop } = start(() => ({ commit: B }))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onNewer).toHaveBeenCalledTimes(1)
    stop()
  })

  it('a quick second focus waits out the gap; a later one asks again', async () => {
    const { fetchImpl, stop } = start(() => ({ commit: A }))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS - 1)
    window.dispatchEvent(new Event('focus'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    stop()
  })

  it('stop() ends the watching', async () => {
    const { fetchImpl, stop } = start(() => ({ commit: A }))
    stop()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('an unreadable manifest shows nothing and keeps trying', async () => {
    const onNewer = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    const stop = watchForNewBuild({ root: ROOT, buildCommit: A, fetchImpl, onNewer })
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onNewer).not.toHaveBeenCalled()
    stop()
  })
})
