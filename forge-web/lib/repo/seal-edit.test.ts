import { describe, expect, it } from 'vitest'

import { editFields } from './private-writes'

describe('a private edit re-seals the whole content (editFields)', () => {
  it('keeps what the edit does not change, and an imported document keeps its provenance', () => {
    const current = { title: 'Old', body: 'body', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/x' }
    const imported = { author: 'octocat', url: 'https://github.com/o/r/pull/1', createdAt: 5 }
    const out = editFields('patch', { number: 3 }, current, { title: 'New' }, imported)
    expect(out).toEqual({ number: 3, title: 'New', body: 'body', baseRefName: 'refs/heads/main', sourceRefName: 'refs/heads/x', imported })
  })

  it('an emptied body is dropped; a non-imported document gets no imported field', () => {
    const out = editFields('issue', { number: 1 }, { title: 'T', body: 'b' }, { body: '' })
    expect(out).toEqual({ number: 1, title: 'T' })
  })
})
