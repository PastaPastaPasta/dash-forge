import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined }) }))

const { filterCount, paramsKey, sameParams } = await import('./list-controls')
const { DEFAULT_ISSUE_QUERY } = await import('@/lib/view/issue-query')

describe('filterCount (QW2-071)', () => {
  it('is 0 for the default query', () => {
    expect(filterCount(DEFAULT_ISSUE_QUERY)).toBe(0)
  })

  it('counts each label, the milestone, author, assignee and a non-default sort', () => {
    expect(filterCount({ ...DEFAULT_ISSUE_QUERY, labels: ['bug', 'docs'], milestone: 'v1', author: 'me', assignee: 'none', sort: 'oldest' })).toBe(6)
    expect(filterCount({ ...DEFAULT_ISSUE_QUERY, noMilestone: true })).toBe(1)
  })

  it('counts a mirrored author login, which the Author select does not show', () => {
    expect(filterCount({ ...DEFAULT_ISSUE_QUERY, authorLogin: 'thephez' })).toBe(1)
  })
})

describe('paramsKey: which lists are the same list (Q5)', () => {
  it('ignores order, not encoding', () => {
    expect(sameParams(new URLSearchParams('a=1&b=2'), new URLSearchParams('b=2&a=1'))).toBe(true)
    expect(sameParams(new URLSearchParams('q=a+b'), new URLSearchParams('q=a%20b'))).toBe(true)
    // One query holding `&sort=oldest` in its text is not a query with a sort.
    expect(paramsKey(new URLSearchParams('q=a%26sort%3Doldest'))).not.toBe(paramsKey(new URLSearchParams('q=a&sort=oldest')))
    expect(sameParams(new URLSearchParams('q=a%26sort%3Doldest'), new URLSearchParams('q=a&sort=oldest'))).toBe(false)
  })
})
