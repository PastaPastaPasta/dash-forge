import { describe, expect, it } from 'vitest'

import type { ReleaseList, ReleaseView } from './releases'
import { tagRevisions } from './release-provenance'

const view = (over: Partial<ReleaseView>): ReleaseView => ({
  id: 'r',
  tagName: 'v1',
  name: '',
  notes: '',
  yanked: false,
  delta: 1,
  assets: [],
  badAssets: 0,
  notesBody: '',
  omitted: null,
  published: null,
  publisher: 'alice',
  createdAt: 100,
  ...over,
})

describe('tagRevisions', () => {
  it('takes every revision of the tag, public assets by name and hash', () => {
    const list: ReleaseList = {
      current: [view({ id: 'r2', createdAt: 200, delta: 0, assets: [{ name: 'a.tgz', sha256: 'bb', size: 1, uris: [] }] })],
      previous: [view({ id: 'r1', assets: [{ name: 'a.tgz', sha256: 'aa', size: 1, uris: [] }] }), view({ id: 'x', tagName: 'v2' })],
    }
    const { revisions, pin } = tagRevisions(list, 'v1')
    expect(revisions.map((r) => [r.id, r.delta, r.assets])).toEqual([
      ['r2', 0, [{ name: 'a.tgz', sha256: 'bb' }]],
      ['r1', 1, [{ name: 'a.tgz', sha256: 'aa' }]],
    ])
    expect(pin).toBeNull()
  })

  it("pins a sealed release to its first published revision's target, and claims nothing of its assets", () => {
    const sealed = (id: string, createdAt: number, targetOid: string, unpublished = false): ReleaseView =>
      view({
        id,
        createdAt,
        delta: 0,
        assets: [{ name: 'shown', sha256: 'ff', size: 1, uris: [] }],
        sealed: { epoch: 0, fields: { tag: 'v1', targetOid, ...(unpublished ? { unpublished: true } : {}) } },
      })
    const list: ReleaseList = { current: [sealed('s3', 300, 'c'.repeat(40))], previous: [sealed('s2', 200, 'b'.repeat(40), true), sealed('s1', 100, 'a'.repeat(40))] }
    const { revisions, pin } = tagRevisions(list, 'v1')
    expect(pin).toBe('a'.repeat(40))
    expect(revisions.find((r) => r.id === 's2')?.delta).toBe(-1)
    expect(revisions.every((r) => r.assets.length === 0)).toBe(true)
  })
})
