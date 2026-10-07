import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closePrivateSessions } from '../repo/private-session'
import { dropPrDraft, loadPrDraft, savePrDraft } from './pr-draft'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

const PUB = { repoId: 'P', visibility: 'public' }
const PRIV = { repoId: 'S', visibility: 'private' }
const d = { title: 'secret title', body: 'secret body', head: 'refs/heads/hidden', base: 'refs/heads/main' }

describe('the new-PR draft', () => {
  it('a public repo keeps it in this tab’s sessionStorage', () => {
    savePrDraft(PUB, d)
    expect(loadPrDraft(PUB)).toEqual(d)
    dropPrDraft(PUB)
    expect(loadPrDraft(PUB)).toBeNull()
  })

  it('a private repo keeps it in page memory only, and drops it when private sessions end (lock, sign-out, identity change)', () => {
    savePrDraft(PRIV, d)
    expect([...store.values()].join()).not.toContain('secret')
    expect(loadPrDraft(PRIV)).toEqual(d)
    closePrivateSessions()
    expect(loadPrDraft(PRIV)).toBeNull()
  })

  it('a public repo draft that quotes members-only text lives in page memory only, its stored copy removed, until it no longer quotes', () => {
    savePrDraft(PUB, d)
    savePrDraft(PUB, { ...d, body: 'quoted members-only text' }, { memoryOnly: true })
    expect([...store.values()].join()).not.toContain('secret')
    expect(loadPrDraft(PUB)?.body).toBe('quoted members-only text')
    closePrivateSessions()
    expect(loadPrDraft(PUB)).toBeNull()
    savePrDraft(PUB, { ...d, body: 'quoted again' }, { memoryOnly: true })
    savePrDraft(PUB, d)
    expect(loadPrDraft(PUB)).toEqual(d)
    expect([...store.values()].join()).toContain('secret body')
  })
})
