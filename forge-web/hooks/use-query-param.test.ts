/**
 * Every in-app href carries the trailing slash (G19): the static export serves `/repo/issue/`,
 * and a host answers `/repo/issue` with a 301, turning a click into a full page load.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

import { parseItemNumber, repoHref, withTrailingSlash } from './use-query-param'

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

describe('parseItemNumber', () => {
  it('reads the numbers an issue or PR can have', () => {
    expect(parseItemNumber('1')).toBe(1)
    expect(parseItemNumber('42')).toBe(42)
    expect(parseItemNumber('4294967295')).toBe(4294967295)
  })

  it('refuses numbers the contracts cannot hold, so the page says no item is addressed', () => {
    for (const raw of ['', 'abc', '0', '-1', '-0', '4294967296', '99999999999999999999']) expect(parseItemNumber(raw)).toBeNaN()
  })
})
