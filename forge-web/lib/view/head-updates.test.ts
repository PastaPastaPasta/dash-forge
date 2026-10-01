import { describe, expect, it } from 'vitest'

import { Store } from './diff-fixtures'
import { firstPushers, headUpdatePhrases } from './head-updates'

describe('headUpdatePhrases', () => {
  const at = (id: string, oid: string, createdAt: number, actor = 'a') => ({ id, oid, actor, createdAt })

  it('counts pushed commits, spots a force-push, and keeps the plain words when unreadable', async () => {
    const s = new Store()
    const h1 = s.commit(s.files({ a: '1' }), [], 'one')
    const h2 = s.commit(s.files({ a: '2' }), [h1], 'two')
    const h3 = s.commit(s.files({ a: '3' }), [h2], 'three')
    const other = s.commit(s.files({ a: 'x' }), [h1], 'rewritten')
    const missing = 'f'.repeat(40)
    const phrases = await headUpdatePhrases(s.reader(), h1, [at('u1', h3, 1), at('u2', other, 2), at('u3', missing, 3)])
    expect(phrases.get('u1')).toEqual({ text: `pushed 2 commits (${h1.slice(0, 7)} → ${h3.slice(0, 7)})` })
    expect(phrases.get('u2')).toEqual({ text: `force-pushed (${h3.slice(0, 7)} → ${other.slice(0, 7)})` })
    expect(phrases.get('u3')).toEqual({ text: `moved the head to ${missing.slice(0, 7)}` })
  })

  it('credits the pusher, not the updater, when someone else pushed the commits (QW3-048)', async () => {
    const s = new Store()
    const h1 = s.commit(s.files({ a: '1' }), [], 'one')
    const h2 = s.commit(s.files({ a: '2' }), [h1], 'two')
    const other = s.commit(s.files({ a: 'x' }), [h1], 'rewritten')
    const missing = 'f'.repeat(40)
    const pushers = new Map([
      [h2, 'member'],
      [other, 'member'],
      [missing, 'member'],
    ])
    const phrases = await headUpdatePhrases(s.reader(), h1, [at('u1', h2, 1, 'owner'), at('u2', other, 2, 'owner'), at('u3', missing, 3, 'owner')], pushers)
    expect(phrases.get('u1')).toEqual({ text: `updated the head with 1 commit (${h1.slice(0, 7)} → ${h2.slice(0, 7)}) pushed by`, who: 'member' })
    expect(phrases.get('u2')).toEqual({ text: `updated the head (${h2.slice(0, 7)} → ${other.slice(0, 7)}), force-pushed by`, who: 'member' })
    expect(phrases.get('u3')).toEqual({ text: `moved the head to ${missing.slice(0, 7)}, pushed by`, who: 'member' })
    // The updater's own push keeps the short words.
    const own = await headUpdatePhrases(s.reader(), h1, [at('u1', h2, 1, 'member')], pushers)
    expect(own.get('u1')).toEqual({ text: `pushed 1 commit (${h1.slice(0, 7)} → ${h2.slice(0, 7)})` })
  })

  it('does not count the base commits an "Update branch" merge brought in', async () => {
    const s = new Store()
    const root = s.commit(s.files({ a: '1' }), [], 'root')
    const head = s.commit(s.files({ a: '1', p: 'x' }), [root], 'pr')
    const b1 = s.commit(s.files({ a: '2' }), [root], 'base 1')
    const b2 = s.commit(s.files({ a: '3' }), [b1], 'base 2')
    const merged = s.commit(s.files({ a: '3', p: 'x' }), [head, b2], 'merge main')
    const plain = await headUpdatePhrases(s.reader(), head, [at('u1', merged, 1)])
    expect(plain.get('u1')?.text).toMatch(/^pushed 3 commits/)
    const based = await headUpdatePhrases(s.reader(), head, [at('u1', merged, 1)], new Map(), b2)
    expect(based.get('u1')).toEqual({ text: `pushed 1 commit (${head.slice(0, 7)} → ${merged.slice(0, 7)})` })
  })
})

describe('firstPushers', () => {
  it('maps each commit to whoever first set the branch to it, skipping deletions', () => {
    const [a, b] = ['A'.repeat(40), 'b'.repeat(40)]
    const zero = '0'.repeat(40)
    const m = firstPushers([
      { id: '2', newOid: a, author: 'late', createdAt: 5 },
      { id: '1', newOid: a, author: 'first', createdAt: 5 },
      { id: '3', newOid: b, author: 'other', createdAt: 1 },
      { id: '4', newOid: zero, author: 'deleter', createdAt: 9 },
    ])
    expect(m.get(a.toLowerCase())).toBe('first')
    expect(m.get(b)).toBe('other')
    expect(m.has(zero)).toBe(false)
  })
})
