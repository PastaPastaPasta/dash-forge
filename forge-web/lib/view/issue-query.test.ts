import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_QUERY,
  dpnsAuthorCandidates,
  droppedQualifiersReason,
  emptyIssuesBody,
  hasFilters,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  searchText,
  unresolvedQualifiers,
  withQuery,
  withResolvedNames,
} from './issue-query'
import { matchesText } from '../repo/issue-index'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const params = (s: string) => new URLSearchParams(s)

describe('issue list URL state', () => {
  it('defaults to open, newest, page 1 and writes nothing for the defaults', () => {
    expect(parseIssueQuery(params(''))).toEqual(DEFAULT_ISSUE_QUERY)
    expect(issueQueryParams(DEFAULT_ISSUE_QUERY)).toEqual([])
  })

  it('round-trips every filter through the URL', () => {
    const q = parseIssueQuery(params(`state=closed&label=bug&label=good%20first&author=${ID}&assignee=me&mentions=me&sort=comments&q=crash&page=3`))
    expect(q).toEqual({ state: 'closed', labels: ['bug', 'good first'], author: ID, assignee: 'me', mentions: true, sort: 'comments', q: 'crash', page: 3 })
    const back = new URLSearchParams(issueQueryParams(q))
    expect(parseIssueQuery(back)).toEqual(q)
    expect(back.toString()).toBe(`state=closed&label=bug&label=good+first&author=${ID}&assignee=me&mentions=me&sort=comments&q=crash&page=3`)
  })

  it('drops invalid values instead of misreading them', () => {
    const q = parseIssueQuery(params('state=merged&sort=random&page=-2&author=alice&assignee=bob&mentions=you&label=' + 'x'.repeat(31)))
    expect(q).toEqual(DEFAULT_ISSUE_QUERY)
    expect(parseIssueQuery(params('page=abc')).page).toBe(1)
    expect(parseIssueQuery(params('assignee=none')).assignee).toBe('none')
    expect(parseIssueQuery(params('author=none')).author).toBeNull()
  })

  it("lifts GitHub's qualifiers out of ?q= (a /issues?q= link, L-27)", () => {
    const q = parseIssueQuery(params('q=is%3Aclosed+label%3Abug+crash'))
    expect(q).toMatchObject({ state: 'closed', labels: ['bug'], q: 'crash' })
    // The app's own URL (free text only) reads back unchanged, page included.
    const own = parseIssueQuery(params('state=closed&q=crash&page=2'))
    expect(own).toMatchObject({ state: 'closed', q: 'crash', page: 2 })
    // An unknown qualifier stays free text.
    expect(parseIssueQuery(params('q=foo%3Abar')).q).toBe('foo:bar')
    // A URL param is never cleared by a qualifier that does not resolve.
    expect(parseIssueQuery(params(`author=${ID}&q=author%3Aalice`))).toMatchObject({ author: ID, q: '' })
  })

  it('dedupes repeated labels', () => {
    expect(parseIssueQuery(params('label=bug&label=bug&label=%20')).labels).toEqual(['bug'])
  })

  it('returns to page 1 on any change except a page move', () => {
    const q = { ...DEFAULT_ISSUE_QUERY, page: 4 }
    expect(withQuery(q, { state: 'closed' }).page).toBe(1)
    expect(withQuery(q, { page: 5 }).page).toBe(5)
  })

  it('knows when a filter narrows the list', () => {
    expect(hasFilters(DEFAULT_ISSUE_QUERY)).toBe(false)
    expect(hasFilters({ ...DEFAULT_ISSUE_QUERY, state: 'closed' })).toBe(false)
    expect(hasFilters({ ...DEFAULT_ISSUE_QUERY, labels: ['bug'] })).toBe(true)
    expect(hasFilters({ ...DEFAULT_ISSUE_QUERY, q: ' x ' })).toBe(true)
  })
})

describe('search-box qualifiers', () => {
  it('lifts GitHub qualifiers and keeps the free text', () => {
    const q = parseSearchText('is:closed label:bug label:"help wanted" author:@me assignee:@me mentions:@me sort:comments-desc crash on start')
    expect(q).toMatchObject({ state: 'closed', labels: ['bug', 'help wanted'], author: 'me', assignee: 'me', mentions: true, sort: 'comments', q: 'crash on start', page: 1 })
  })

  it('reads no:assignee, identity ids and the sort spellings', () => {
    expect(parseSearchText('no:assignee').assignee).toBe('none')
    expect(parseSearchText(`author:${ID}`).author).toBe(ID)
    expect(parseSearchText('sort:created-asc').sort).toBe('oldest')
    expect(parseSearchText('is:issue x').q).toBe('x')
  })

  it('keeps unknown keys as free text, and drops (and reports) known ones it cannot resolve', () => {
    const q = parseSearchText('author:alice is:merged foo:bar hello')
    expect(q.author).toBeNull()
    expect(q.state).toBe('open')
    expect(q.q).toBe('foo:bar hello')
    expect(unresolvedQualifiers('author:alice is:merged foo:bar hello')).toEqual(['author:alice', 'is:merged'])
  })

  it('never overrides a filter with an unresolvable qualifier', () => {
    const base = { ...DEFAULT_ISSUE_QUERY, author: ID, assignee: 'me', mentions: true, sort: 'comments' as const }
    const q = parseSearchText('author:alice assignee:bob mentions:you sort:random', base)
    expect(q).toMatchObject({ author: ID, assignee: 'me', mentions: true, sort: 'comments', q: '' })
  })

  it('writes the query back as text that parses to the same query', () => {
    const q = { ...DEFAULT_ISSUE_QUERY, state: 'all' as const, labels: ['bug', 'two words'], assignee: 'none', sort: 'oldest' as const, q: 'crash' }
    const text = searchText(q)
    expect(text).toBe('is:all label:bug label:"two words" no:assignee sort:created-asc crash')
    expect(parseSearchText(text)).toEqual(q)
  })
})

describe('free-text match', () => {
  const row = { title: 'Crash when the Config is empty', number: 12 }
  it('needs every word, ignoring case', () => {
    expect(matchesText('crash config', row)).toBe(true)
    expect(matchesText('crash network', row)).toBe(false)
    expect(matchesText('', row)).toBe(true)
  })
  it('matches #n against the number', () => {
    expect(matchesText('#12', row)).toBe(true)
    expect(matchesText('#1', row)).toBe(false)
  })
  // L-43: a bare number (no `#`) matches the issue number too, alongside (not instead of) the
  // usual title-substring check.
  it('matches a bare number against the number as well as #n', () => {
    expect(matchesText('12', row)).toBe(true)
    expect(matchesText('7512', row)).toBe(false)
    expect(matchesText('7512', { title: 'Crash when the Config is empty', number: 7512 })).toBe(true)
  })
})

// L-43: author:/assignee: previously only accepted an identity id or @me, so a DPNS name (typed
// or from a shared link) silently matched nothing. dpnsAuthorCandidates finds the names worth
// looking up; withResolvedNames rewrites the ones DPNS actually knows to their id before the
// qualifiers are lifted into the query.
describe('DPNS names in author:/assignee: (L-43)', () => {
  it('finds author/assignee values that are not already an id, me or none', () => {
    expect(dpnsAuthorCandidates('author:unofficial-dashpay-dash-mirror.dash assignee:coffseducation')).toEqual([
      'unofficial-dashpay-dash-mirror.dash',
      'coffseducation',
    ])
    expect(dpnsAuthorCandidates(`author:${ID} author:@me assignee:none is:open`)).toEqual([])
  })

  it('rewrites a resolved name to its id and leaves an unresolved one unresolved', () => {
    const resolved = new Map([['coffseducation', ID]])
    const text = withResolvedNames('author:coffseducation assignee:nobody-knows-this is:open hello', resolved)
    expect(text).toBe(`author:${ID} assignee:nobody-knows-this is:open hello`)
    expect(parseSearchText(text)).toMatchObject({ author: ID, state: 'open', q: 'hello' })
    expect(unresolvedQualifiers(text)).toEqual(['assignee:nobody-knows-this'])
  })
})

describe('droppedQualifiersReason (L-43)', () => {
  it('gives is:pr its own reason instead of the generic is:/state: one', () => {
    expect(droppedQualifiersReason(['is:pr'])).toMatch(/Pull requests/)
    expect(droppedQualifiersReason(['state:pr'])).toMatch(/Pull requests/)
    expect(droppedQualifiersReason(['is:merged'])).not.toMatch(/Pull requests/)
  })

  it('explains an unresolved author/assignee value separately from other keys', () => {
    expect(droppedQualifiersReason(['author:alice'])).toMatch(/DPNS name/)
    expect(droppedQualifiersReason(['sort:bogus'])).toMatch(/sort:/)
  })

  it('reports the author/assignee reason once even when both are dropped', () => {
    const reasons = droppedQualifiersReason(['author:alice', 'assignee:bob'])
    expect(reasons.match(/DPNS name/g)?.length).toBe(1)
  })
})

describe('emptyIssuesBody (L-37)', () => {
  it('invites the first issue only when the repo has none', () => {
    expect(emptyIssuesBody(false, 'open', 0)).toMatch(/Open the first issue/)
    expect(emptyIssuesBody(false, 'all', 0)).toMatch(/Open the first issue/)
  })

  it('says the open list is empty when issues were closed, or the closed count is unknown', () => {
    expect(emptyIssuesBody(false, 'open', 1)).toBe('No issue is open right now; 1 issue is closed.')
    expect(emptyIssuesBody(false, 'open', 3)).toBe('No issue is open right now; 3 issues are closed.')
    expect(emptyIssuesBody(false, 'open', null)).toBe('No issue is open right now.')
  })

  it('keeps the filtered and closed-tab lines', () => {
    expect(emptyIssuesBody(true, 'open', 2)).toBe('Try fewer filters.')
    expect(emptyIssuesBody(false, 'closed', 0)).toBe('Nothing has been closed yet.')
  })
})
