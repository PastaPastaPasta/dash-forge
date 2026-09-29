import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PULL_QUERY,
  emptyPullsBody,
  parsePullQuery,
  parsePullSearch,
  pullQueryParams,
  pullSearchText,
  unresolvedPullQualifiers,
} from './pull-query'
import { withQuery } from './issue-query'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const params = (q: string) => new URLSearchParams(q)

describe('PR list query (L-44)', () => {
  it('parses the PR states from the URL, defaulting to open', () => {
    expect(parsePullQuery(params('state=merged')).state).toBe('merged')
    expect(parsePullQuery(params('state=closed&page=3')).page).toBe(3)
    expect(parsePullQuery(params('state=bogus')).state).toBe('open')
    expect(parsePullQuery(params(''))).toEqual(DEFAULT_PULL_QUERY)
  })

  it('round-trips a query through the URL', () => {
    const q = { ...DEFAULT_PULL_QUERY, state: 'merged' as const, labels: ['bug'], author: ID, sort: 'oldest' as const, q: 'parser', page: 2 }
    const back = parsePullQuery(new URLSearchParams(pullQueryParams(q)))
    expect(back).toEqual(q)
    expect(pullQueryParams(DEFAULT_PULL_QUERY)).toEqual([])
  })

  it('lifts the Issues qualifiers and is:merged out of the search box; is:pr matches every PR', () => {
    const q = parsePullSearch(`is:pr is:merged label:bug author:${ID} sort:created-asc fix parser`)
    expect(q).toMatchObject({ state: 'merged', labels: ['bug'], author: ID, sort: 'oldest', q: 'fix parser' })
    expect(parsePullSearch('is:closed').state).toBe('closed')
    // Values are exact, as the Issues grammar reads them: `is:Closed` sets no state.
    expect(parsePullSearch('is:Closed', { ...DEFAULT_PULL_QUERY, state: 'merged' }).state).toBe('merged')
    expect(parsePullSearch('parser', { ...DEFAULT_PULL_QUERY, state: 'merged' }).state).toBe('merged')
    expect(unresolvedPullQualifiers('is:merged is:pr label:bug')).toEqual([])
  })

  it('reports what it cannot apply: a DPNS author, and mentions (an Issues filter)', () => {
    expect(unresolvedPullQualifiers('author:alice mentions:@me')).toEqual(['author:alice', 'mentions:@me'])
    expect(parsePullSearch('mentions:@me fix').q).toBe('fix')
  })

  it('writes the query back as search text, the state first', () => {
    expect(pullSearchText({ ...DEFAULT_PULL_QUERY, state: 'merged', labels: ['bug'] })).toBe('is:merged label:bug')
    expect(parsePullSearch(pullSearchText({ ...DEFAULT_PULL_QUERY, state: 'closed', q: 'x' }))).toMatchObject({ state: 'closed', q: 'x' })
  })

  it('a GitHub link with qualifiers in q lifts them, keeping the page', () => {
    const q = parsePullQuery(params('q=is%3Amerged+label%3Abug&page=2'))
    expect(q).toMatchObject({ state: 'merged', labels: ['bug'], q: '', page: 2 })
  })

  it('returns to page 1 on any change but a page move', () => {
    const q = { ...DEFAULT_PULL_QUERY, page: 4 }
    expect(withQuery(q, { state: 'closed' }).page).toBe(1)
    expect(withQuery(q, { page: 5 }).page).toBe(5)
  })

  it('never invites the first PR while some are merged or closed', () => {
    expect(emptyPullsBody(false, 'open', 3)).toMatch(/3 pull requests are merged or closed/)
    expect(emptyPullsBody(false, 'open', 0)).toMatch(/Push a branch/)
    expect(emptyPullsBody(true, 'open', 3)).toBe('Try fewer filters.')
  })
})
