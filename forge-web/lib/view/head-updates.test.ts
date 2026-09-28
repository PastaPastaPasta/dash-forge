import { describe, expect, it } from 'vitest'

import { Store } from './diff-fixtures'
import { headUpdatePhrases } from './head-updates'

describe('headUpdatePhrases', () => {
  it('counts pushed commits, spots a force-push, and keeps the plain words when unreadable', async () => {
    const s = new Store()
    const h1 = s.commit(s.files({ a: '1' }), [], 'one')
    const h2 = s.commit(s.files({ a: '2' }), [h1], 'two')
    const h3 = s.commit(s.files({ a: '3' }), [h2], 'three')
    const other = s.commit(s.files({ a: 'x' }), [h1], 'rewritten')
    const missing = 'f'.repeat(40)
    const at = (id: string, oid: string, createdAt: number) => ({ id, oid, actor: 'a', createdAt })
    const phrases = await headUpdatePhrases(s.reader(), h1, [at('u1', h3, 1), at('u2', other, 2), at('u3', missing, 3)])
    expect(phrases.get('u1')).toBe(`pushed 2 commits (${h1.slice(0, 7)} → ${h3.slice(0, 7)})`)
    expect(phrases.get('u2')).toBe(`force-pushed (${h3.slice(0, 7)} → ${other.slice(0, 7)})`)
    expect(phrases.get('u3')).toBe(`moved the head to ${missing.slice(0, 7)}`)
  })
})
