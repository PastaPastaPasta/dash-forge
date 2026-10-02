/**
 * Search parity with GitHub (QA wave 4): state qualifiers intersect (QW4-007), a search without a
 * state covers every state (QW4-023), and `reason:` filters issues by close reason (QW4-028).
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_QUERY,
  STATE_CONFLICT,
  closeReasonValue,
  droppedQualifiersReason,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  searchSubmitBase,
  searchText,
  unresolvedQualifiers,
} from './issue-query'
import { DEFAULT_PULL_QUERY, parsePullQuery, parsePullSearch, pullDroppedReason, pullSubmitBase, unresolvedPullQualifiers } from './pull-query'

const params = (s: string) => new URLSearchParams(s)

describe('PR state qualifiers intersect (QW4-007)', () => {
  it('is:closed is:unmerged is closed without merging, in either order', () => {
    expect(parsePullSearch('is:pr is:closed is:unmerged').state).toBe('closed')
    expect(parsePullSearch('is:unmerged is:closed').state).toBe('closed')
    expect(unresolvedPullQualifiers('is:pr is:closed is:unmerged')).toEqual([])
  })

  it('narrows the other pairs as GitHub does', () => {
    expect(parsePullSearch('is:closed is:merged').state).toBe('merged')
    expect(parsePullSearch('is:open is:unmerged').state).toBe('open')
    expect(parsePullSearch('is:all is:merged').state).toBe('merged')
    expect(parsePullSearch('state:unmerged is:all').state).toBe('unmerged')
    // Alone, each keeps its tab.
    expect(parsePullSearch('is:closed').state).toBe('closed')
    expect(parsePullSearch('is:unmerged').state).toBe('unmerged')
    expect(parsePullSearch('is:open').state).toBe('open')
  })

  it('reports a state no PR can be in together with the earlier one, and keeps the earlier', () => {
    const q = parsePullSearch('is:open is:merged fix')
    expect(q.state).toBe('open')
    expect(q.q).toBe('fix')
    const dropped = unresolvedPullQualifiers('is:open is:merged fix')
    expect(dropped).toEqual(['is:merged'])
    expect(pullDroppedReason(dropped)).toBe(STATE_CONFLICT)
    // A bad value still gets the values' reason, not the conflict one.
    expect(pullDroppedReason(['is:MERGED'])).toBe('is: and state: take open, closed, merged, unmerged, draft or all.')
  })

  it('intersects issue states too: is:open is:closed reports the second', () => {
    expect(parseSearchText('is:open is:closed').state).toBe('open')
    expect(unresolvedQualifiers('is:open is:closed')).toEqual(['is:closed'])
    expect(droppedQualifiersReason(['is:closed'])).toBe(STATE_CONFLICT)
    expect(parseSearchText('is:all is:closed').state).toBe('closed')
    expect(unresolvedQualifiers('is:all is:closed')).toEqual([])
  })
})

describe('a search with no state covers every state (QW4-023)', () => {
  it('a submit whose text took its is:<state> out searches every state', () => {
    const open = { ...DEFAULT_ISSUE_QUERY, state: 'open' as const }
    expect(parseSearchText('is:issue', searchSubmitBase(open, 'is:issue')).state).toBe('all')
    expect(parseSearchText('is:issue in:title DIP', searchSubmitBase(open, 'is:issue in:title DIP')).state).toBe('all')
    expect(parseSearchText('crash', searchSubmitBase(open, 'crash')).state).toBe('all')
    // With a state in the text, the text's state wins; an empty box keeps the tab.
    expect(parseSearchText('is:closed crash', searchSubmitBase(open, 'is:closed crash')).state).toBe('closed')
    expect(searchSubmitBase({ ...DEFAULT_ISSUE_QUERY, state: 'closed' }, '  ').state).toBe('closed')
    // The box always shows the state, so an untouched resubmit stays on the tab.
    const closed = { ...DEFAULT_ISSUE_QUERY, state: 'closed' as const, q: 'crash' }
    const text = searchText(closed)
    expect(parseSearchText(text, searchSubmitBase(closed, text)).state).toBe('closed')
  })

  it('the PR list does the same, with its own states', () => {
    expect(parsePullSearch('is:pr', pullSubmitBase(DEFAULT_PULL_QUERY, 'is:pr')).state).toBe('all')
    expect(parsePullSearch('is:merged', pullSubmitBase(DEFAULT_PULL_QUERY, 'is:merged')).state).toBe('merged')
    expect(pullSubmitBase({ ...DEFAULT_PULL_QUERY, state: 'merged' }, '').state).toBe('merged')
  })

  it('a GitHub link with is:issue / is:pr and no state lists every state; the app\'s own URLs still read as Open', () => {
    expect(parseIssueQuery(params('q=is%3Aissue')).state).toBe('all')
    expect(parseIssueQuery(params('q=is%3Aissue+is%3Aopen')).state).toBe('open')
    expect(parseIssueQuery(params('state=closed&q=is%3Aissue')).state).toBe('closed')
    expect(parsePullQuery(params('q=is%3Apr')).state).toBe('all')
    expect(parsePullQuery(params('q=is%3Apr+is%3Amerged')).state).toBe('merged')
    // An Open query the app wrote (state omitted, a qualifier in q) reads back as Open.
    const own = { ...DEFAULT_ISSUE_QUERY, milestone: 'v1' }
    expect(parseIssueQuery(params(new URLSearchParams(issueQueryParams(own)).toString())).state).toBe('open')
  })
})

describe('reason: (QW4-028)', () => {
  it('reads GitHub\'s spellings', () => {
    expect(closeReasonValue('completed')).toBe('completed')
    expect(closeReasonValue('not planned')).toBe('not_planned')
    expect(closeReasonValue('not_planned')).toBe('not_planned')
    expect(closeReasonValue('Not-Planned')).toBe('not_planned')
    expect(closeReasonValue('duplicate')).toBe('duplicate')
    expect(closeReasonValue('reopened')).toBeNull()
  })

  it('lifts reason: into the query and writes it back, quoted when it has a space', () => {
    const q = parseSearchText('is:closed reason:"not planned" crash')
    expect(q).toMatchObject({ state: 'closed', reason: 'not_planned', q: 'crash' })
    expect(unresolvedQualifiers('is:closed reason:"not planned"')).toEqual([])
    expect(issueQueryParams(q)).toEqual([['state', 'closed'], ['q', 'reason:"not planned" crash']])
    expect(searchText(q)).toBe('is:closed reason:"not planned" crash')
    expect(parseIssueQuery(params('state=closed&q=reason%3Acompleted'))).toMatchObject({ state: 'closed', reason: 'completed', q: '' })
  })

  it('reports a bad value, and reports reason: on the PR list as an Issues filter', () => {
    expect(unresolvedQualifiers('reason:wontfix')).toEqual(['reason:wontfix'])
    expect(droppedQualifiersReason(['reason:wontfix'])).toBe('reason: takes completed, "not planned" or duplicate.')
    const dropped = unresolvedPullQualifiers('is:closed reason:completed fix')
    expect(dropped).toEqual(['reason:completed'])
    expect(parsePullSearch('is:closed reason:completed fix')).toMatchObject({ state: 'closed', reason: null, q: 'fix' })
    expect(pullDroppedReason(dropped)).toContain('reason: is an Issues filter')
  })
})
