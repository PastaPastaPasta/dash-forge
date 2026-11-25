import { describe, expect, it } from 'vitest'

import { canonicalJson } from './crypto'
import { baseOf, mergeList, parseDoc, planSlot, NewerSyncFormatError, type LwwDoc, type Tagger } from './lww'
import { carryProfileExtras } from './storage-slot'

const tag: Tagger = (key, v) => `${key}=${canonicalJson(v ?? null)}`
const id = (e: unknown): string => String(e)
const doc = (entries: LwwDoc['entries']): LwwDoc => ({ format: 'forge-user/prefs', version: 1, entries })

describe('the last-writer-wins slot', () => {
  it('first sync: a value the synced copy holds differently stays local and synced wins; one it lacks is uploaded', () => {
    const plan = planSlot({ slot: 'prefs', local: { a: 1, b: 2 }, base: null, remote: doc({ a: { at: 5, v: 9 } }), now: 10, tag, options: {} })
    expect(plan.next.entries).toEqual({ a: { at: 5, v: 9 }, b: { at: 10, v: 2 } })
    expect(plan.collisions).toEqual(['a'])
    expect(plan.upload).toBe(true)
  })

  it('a later local change wins, even over a synced entry dated after this clock', () => {
    const local = { a: 1 }
    const plan = planSlot({ slot: 'prefs', local: { a: 2 }, base: baseOf(local, tag), remote: doc({ a: { at: 50, v: 1 } }), now: 10, tag, options: {} })
    expect(plan.next.entries['a']).toEqual({ at: 51, v: 2 })
  })

  it('a key missing here is never a deletion: only one the user deleted here, after the synced value, is', () => {
    const base = baseOf({ a: 1 }, tag)
    const remote = doc({ a: { at: 5, v: 1 } })
    const missing = planSlot({ slot: 's', local: {}, base, remote, now: 10, tag, options: {} })
    expect(missing.upload).toBe(false)
    expect(missing.add).toEqual({ a: 1 })
    expect(planSlot({ slot: 's', local: {}, base, remote, now: 10, tag, options: {}, deletions: { a: 8 } }).next.entries['a']).toEqual({ at: 8, v: null })
    expect(planSlot({ slot: 's', local: {}, base, remote, now: 10, tag, options: {}, deletions: { a: 3 } }).upload).toBe(false)
    // Forgotten here (a fresh blob, the old base kept): nothing is deleted anywhere.
    expect(planSlot({ slot: 's', local: {}, base: baseOf({ a: 1, b: 2 }, tag), remote: doc({ a: { at: 5, v: 1 }, b: { at: 5, v: 2 } }), now: 10, tag, options: {} }).upload).toBe(false)
    const hidden = planSlot({ slot: 's', local: { a: 1 }, base, remote: doc({ a: { at: 20, v: null } }), now: 30, tag, options: {} })
    expect(hidden.view).toEqual({})
    expect(hidden.add).toEqual({})
    expect(hidden.upload).toBe(false)
  })

  it('first sync joins a list with the synced one instead of hiding this device’s (H1)', () => {
    const plan = planSlot({ slot: 'prefs', local: { orgs: ['b', 'c'] }, base: null, remote: doc({ orgs: { at: 5, v: ['a', 'b'] } }), now: 10, tag, options: { lists: { orgs: id } } })
    expect(plan.next.entries['orgs']).toEqual({ at: 10, v: ['a', 'b', 'c'] })
  })

  it('uploads nothing local on a first sync that is not this identity’s', () => {
    const plan = planSlot({ slot: 'prefs', local: { a: 1 }, base: null, remote: null, now: 10, tag, options: {}, uploadLocal: false })
    expect(plan.upload).toBe(false)
  })

  it('keeps an entry it cannot read exactly as it was', () => {
    const odd = { at: 'yesterday', v: 3 } as unknown as LwwDoc['entries'][string]
    const parsed = parseDoc({ format: 'forge-user/prefs', version: 1, entries: { a: odd } }, 'prefs')
    const plan = planSlot({ slot: 'prefs', local: { a: 1, b: 2 }, base: null, remote: parsed, now: 10, tag, options: {} })
    expect(plan.next.entries['a']).toEqual(odd)
    expect(plan.view).toEqual({ b: 2 })
  })

  it('merges a changed list by element: another device’s additions stay', () => {
    expect(mergeList(['x', 'y', 'z'], ['x', 'w'], { x: tag('l', 'x'), y: tag('l', 'y') }, id, (e) => tag('l', e))).toEqual(['x', 'z', 'w'])
  })

  it('refuses a newer format, and keeps fields it does not know', () => {
    expect(() => parseDoc({ format: 'forge-user/prefs', version: 2, entries: {} }, 'prefs')).toThrow(NewerSyncFormatError)
    expect(parseDoc({ format: 'forge-user/prefs', version: 1, entries: {}, extra: 1 }, 'prefs')['extra']).toBe(1)
  })

  describe('dg-only parts of a synced profile', () => {
    const settings = { kind: 'ipfs-kubo', api: 'http://nas.lan:5001' }
    const synced = { settings, secrets: {}, dg: { allowPrivateUri: true } }
    const options = { carry: carryProfileExtras }

    it('an unchanged profile is not a collision and is not rewritten', () => {
      const local = { 'profile:nas': { settings, secrets: {} } }
      const plan = planSlot({ slot: 'storage', local, base: baseOf(local, tag), remote: doc({ 'profile:nas': { at: 5, v: synced } }), now: 10, tag, options })
      expect(plan.collisions).toEqual([])
      expect(plan.upload).toBe(false)
    })

    it('an edit made here keeps the dg object', () => {
      const before = { 'profile:nas': { settings, secrets: {} } }
      const edited = { settings: { ...settings, api: 'http://nas.lan:5002' }, secrets: {} }
      const plan = planSlot({ slot: 'storage', local: { 'profile:nas': edited }, base: baseOf(before, tag), remote: doc({ 'profile:nas': { at: 5, v: synced } }), now: 10, tag, options })
      expect(plan.next.entries['profile:nas']!.v).toEqual({ ...edited, dg: { allowPrivateUri: true } })
    })

    it('a newer synced edit is not overwritten by an unchanged local copy', () => {
      const local = { 'profile:nas': { settings, secrets: {} } }
      const newer = { ...synced, settings: { ...settings, api: 'http://nas.lan:6001' } }
      const plan = planSlot({ slot: 'storage', local, base: baseOf(local, tag), remote: doc({ 'profile:nas': { at: 50, v: newer } }), now: 10, tag, options })
      expect(plan.next.entries['profile:nas']!.v).toEqual(newer)
    })
  })

  it('a first sync never brings back a profile deleted elsewhere (its tombstone)', () => {
    const plan = planSlot({ slot: 'storage', local: { 'profile:a': 1 }, base: null, remote: doc({ 'profile:a': { at: 5, v: null } }), now: 10, tag, options: {} })
    expect(plan.upload).toBe(false)
    expect(plan.view).toEqual({})
  })

  it('keeps fields an entry carries beyond at and v, also when its value changes', () => {
    const parsed = parseDoc({ format: 'forge-user/prefs', version: 1, entries: { a: { at: 1, v: 1, by: 'dg' } } }, 'prefs')
    const plan = planSlot({ slot: 'prefs', local: { a: 2 }, base: baseOf({ a: 1 }, tag), remote: parsed, now: 10, tag, options: {} })
    expect(plan.next.entries['a']).toEqual({ at: 10, v: 2, by: 'dg' })
  })

  it('an edit made here counts even when it goes back to the value this device held', () => {
    const local = { 'repo:r': { targets: ['a'] } }
    const remote = doc({ 'repo:r': { at: 5, v: { targets: ['b'] } } })
    expect(planSlot({ slot: 'storage', local, base: baseOf(local, tag), remote, now: 10, tag, options: {} }).upload).toBe(false)
    const plan = planSlot({ slot: 'storage', local, base: baseOf(local, tag), remote, now: 10, tag, options: {}, edits: { 'repo:r': 9 } })
    expect(plan.next.entries['repo:r']).toEqual({ at: 10, v: { targets: ['a'] } })
  })
})
