import { describe, expect, it } from 'vitest'

import { canonicalJson } from './crypto'
import { baseOf, mergeList, parseDoc, planSlot, NewerSyncFormatError, type LwwDoc, type Tagger } from './lww'

const tag: Tagger = (key, v) => `${key}=${canonicalJson(v ?? null)}`
const id = (e: unknown): string => String(e)
const doc = (entries: LwwDoc['entries']): LwwDoc => ({ format: 'forge-user/prefs', version: 1, entries })

describe('the last-writer-wins slot', () => {
  it('first sync: a value the synced copy holds differently stays local and synced wins; one it lacks is uploaded', () => {
    const plan = planSlot({ slot: 'prefs', local: { a: 1, b: 2 }, base: null, remote: doc({ a: { at: 5, v: 9 } }), now: 10, tag, options: { tombstoneRemoved: true } })
    expect(plan.next.entries).toEqual({ a: { at: 5, v: 9 }, b: { at: 10, v: 2 } })
    expect(plan.collisions).toEqual(['a'])
    expect(plan.upload).toBe(true)
  })

  it('a later local change wins, even over a synced entry dated after this clock', () => {
    const local = { a: 1 }
    const plan = planSlot({ slot: 'prefs', local: { a: 2 }, base: baseOf(local, tag), remote: doc({ a: { at: 50, v: 1 } }), now: 10, tag, options: { tombstoneRemoved: true } })
    expect(plan.next.entries['a']).toEqual({ at: 51, v: 2 })
  })

  it('a local removal is a tombstone only where asked, and a tombstone never asks to remove anything local', () => {
    const base = baseOf({ a: 1 }, tag)
    expect(planSlot({ slot: 's', local: {}, base, remote: doc({ a: { at: 1, v: 1 } }), now: 10, tag, options: { tombstoneRemoved: true } }).next.entries['a']).toEqual({ at: 10, v: null })
    expect(planSlot({ slot: 's', local: {}, base, remote: doc({ a: { at: 1, v: 1 } }), now: 10, tag, options: { tombstoneRemoved: false } }).upload).toBe(false)
    const hidden = planSlot({ slot: 's', local: { a: 1 }, base, remote: doc({ a: { at: 20, v: null } }), now: 30, tag, options: { tombstoneRemoved: true } })
    expect(hidden.view).toEqual({})
    expect(hidden.add).toEqual({})
    expect(hidden.upload).toBe(false)
  })

  it('merges a changed list by element: another device’s additions stay', () => {
    expect(mergeList(['x', 'y', 'z'], ['x', 'w'], { x: tag('l', 'x'), y: tag('l', 'y') }, id, (e) => tag('l', e))).toEqual(['x', 'z', 'w'])
  })

  it('refuses a newer format, and keeps fields it does not know', () => {
    expect(() => parseDoc({ format: 'forge-user/prefs', version: 2, entries: {} }, 'prefs')).toThrow(NewerSyncFormatError)
    expect(parseDoc({ format: 'forge-user/prefs', version: 1, entries: {}, extra: 1 }, 'prefs')['extra']).toBe(1)
  })
})
