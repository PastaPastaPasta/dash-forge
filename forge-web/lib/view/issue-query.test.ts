import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_QUERY,
  hasFilters,
  issueQueryParams,
  matchesText,
  parseIssueQuery,
  parseSearchText,
  searchText,
  withQuery,
} from './issue-query'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
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

  it('leaves unknown or malformed qualifiers in the free text', () => {
    const q = parseSearchText('author:alice is:merged foo:bar hello')
    expect(q.author).toBeNull()
    expect(q.state).toBe('open')
    expect(q.q).toBe('author:alice is:merged foo:bar hello')
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
})
