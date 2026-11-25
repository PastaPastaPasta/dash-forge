import { afterEach, describe, expect, it, vi } from 'vitest'

import { PREFS_KEY } from '../view/prefs'
import { canonicalJson } from './crypto'
import { baseOf, planSlot, type Tagger } from './lww'
import { memoryStorage } from './fake-port'
import { readRecord, recordKey } from './overlay'
import { PREFS_PLAN, orgsKey, prefsEntries } from './prefs-slot'

const tag: Tagger = (key, v) => `${key}=${canonicalJson(v ?? null)}`

describe('the prefs slot', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('syncs a cleared merge author, and leaves out one never set', () => {
    const cleared = prefsEntries({ [PREFS_KEY]: JSON.stringify({ diffLayout: 'split', mergeName: '', mergeEmail: '' }) }, 'testnet')
    expect(cleared['mergeIdentity']).toEqual({ name: '', email: '' })
    expect(prefsEntries({ [PREFS_KEY]: JSON.stringify({ diffLayout: 'split' }) }, 'testnet')['mergeIdentity']).toBeUndefined()
  })

  it('syncs nothing from stored preferences that do not parse', () => {
    expect(prefsEntries({ [PREFS_KEY]: '{not json' }, 'testnet')).toEqual({})
  })

  it('merges an organization list whose synced copy holds a stray element', () => {
    const local = { orgs: [{ orgId: 'o1', network: 'testnet' }] }
    const remote = { format: 'forge-user/prefs', version: 1, entries: { orgs: { at: 5, v: [null, { orgId: 'o2', network: 'testnet' }] } } }
    expect(() => planSlot({ slot: 'prefs', local, base: baseOf({ orgs: [] }, tag, PREFS_PLAN.lists), remote, now: 10, tag, options: PREFS_PLAN })).not.toThrow()
    expect(orgsKey('testnet')).toBe('forge:orgs:testnet')
  })

  it('drops parts of a stored sync record that do not read', () => {
    const store = memoryStorage()
    vi.stubGlobal('localStorage', store)
    store.setItem(recordKey('testnet', 'ID'), JSON.stringify({ v: 1, prefs: { keyId: 1, syncedAt: 1, base: { tags: {} }, view: {} }, deletes: { a: 1 } }))
    const r = readRecord('testnet', 'ID')
    expect(r?.prefs).toBeUndefined()
    expect(r?.deletes).toEqual({ a: 1 })
  })
})
