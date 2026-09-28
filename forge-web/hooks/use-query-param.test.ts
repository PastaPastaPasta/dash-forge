/**
 * Every in-app href carries the trailing slash (G19): the static export serves `/repo/issue/`,
 * and a host answers `/repo/issue` with a 301, turning a click into a full page load.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

import { repoHref, withTrailingSlash } from './use-query-param'

describe('repoHref', () => {
  it('adds the trailing slash to every repo route', () => {
    const addr = { owner: 'alice', name: 'project' }
    expect(repoHref('/repo', addr)).toBe('/repo/?owner=alice&name=project')
    expect(repoHref('/repo/issue', addr, { number: '2' })).toBe('/repo/issue/?owner=alice&name=project&number=2')
    // A path that already has it (the ref switcher passes usePathname()) is left alone.
    expect(repoHref('/repo/blob/', { ...addr, repoId: 'R' }, { path: 'a b' })).toBe('/repo/blob/?owner=alice&name=project&repo=R&path=a+b')
  })

  it('withTrailingSlash', () => {
    expect(withTrailingSlash('/settings')).toBe('/settings/')
    expect(withTrailingSlash('/settings/')).toBe('/settings/')
  })
})
