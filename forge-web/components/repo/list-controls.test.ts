import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined }) }))

const { filterCount } = await import('./list-controls')
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
