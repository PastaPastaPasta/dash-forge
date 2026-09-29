import { describe, expect, it } from 'vitest'

import { isLoadFailure, takeAutoReload } from './auto-reload'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

describe('error-boundary auto reload (H3)', () => {
  it('allows two automatic reloads per five minutes, then waits for the viewer', () => {
    const s = memory()
    const t = 1_000_000
    expect(takeAutoReload(s, t)).toBe(true)
    expect(takeAutoReload(s, t + 1_000)).toBe(true)
    expect(takeAutoReload(s, t + 2_000)).toBe(false)
    expect(takeAutoReload(s, t + 60_000)).toBe(false)
    // The first one ages out of the window.
    expect(takeAutoReload(s, t + 5 * 60_000 + 1)).toBe(true)
  })

  it('never reloads when storage is blocked or holds junk', () => {
    const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => undefined }
    expect(takeAutoReload(blocked, 1)).toBe(false)
    const junk = memory()
    junk.setItem('forge.autoReloads', '{')
    expect(takeAutoReload(junk, 1)).toBe(false)
  })

  it('recognises a chunk that failed to load, and nothing else', () => {
    expect(isLoadFailure(Object.assign(new Error('Loading chunk 2147 failed.'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isLoadFailure(new Error('Loading chunk 12 failed. (error: /x.js)'))).toBe(true)
    expect(isLoadFailure(new TypeError('Cannot read properties of undefined'))).toBe(false)
  })
})
