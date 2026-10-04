import { describe, expect, it } from 'vitest'
import type { DiscoveredRepo } from '@/lib/view/discovery'
import type { MirrorCheck } from '@/lib/view/mirror-check'
import { rankSuggestions } from './repo-not-found'

function repo(key: string, description: string, stars: number | null, createdAt: number): DiscoveredRepo {
  return { key, ownerId: `owner-${key}`, name: 'dips', slug: 'dips', description, createdAt, visibility: 'public', stars }
}

const CLAIM = 'Mirror of github.com/dashpay/dips'
const listed: MirrorCheck = { backlink: { kind: 'listed' }, head: null, checkedAt: 1 }
const notListed: MirrorCheck = { backlink: { kind: 'not-listed' }, head: null, checkedAt: 1 }

describe('repos named like a missing address (TS-01)', () => {
  it('never ranks a repo higher for claiming to be the mirror', () => {
    const impostor = repo('impostor', CLAIM, 0, 300)
    const starred = repo('starred', 'Dash Improvement Proposals', 5, 200)
    const older = repo('older', '', 0, 100)
    expect(rankSuggestions([impostor, starred, older], new Map()).map((s) => s.repo.key)).toEqual(['starred', 'older', 'impostor'])
  })

  it('puts a mirror its source lists first, once checked', () => {
    const real = repo('real', CLAIM, 0, 300)
    const fake = repo('fake', CLAIM, 9, 100)
    const ranked = rankSuggestions([fake, real], new Map([['real', listed], ['fake', notListed]]))
    expect(ranked.map((s) => [s.repo.key, s.vouched])).toEqual([
      ['real', true],
      ['fake', false],
    ])
    expect(ranked[1]?.source?.label).toBe('github.com/dashpay/dips')
  })

  it('treats an unread star count as none', () => {
    expect(rankSuggestions([repo('unknown', '', null, 1), repo('one', '', 1, 2)], new Map()).map((s) => s.repo.key)).toEqual(['one', 'unknown'])
  })
})
