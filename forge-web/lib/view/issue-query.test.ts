import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_ISSUE_QUERY,
  dpnsAuthorCandidates,
  droppedQualifiersReason,
  emptyIssuesBody,
  commentRange,
  hasFilters,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  pastLastPage,
  searchTerms,
  resolveSearchNames,
  searchSubmitBase,
  searchText,
  unresolvedQualifiers,
  withQuery,
  withResolvedNames,
} from './issue-query'
import { matchesText, rowMatches, rowFiltersOf } from '../repo/issue-index'

const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const params = (s: string) => new URLSearchParams(s)

describe('issue list URL state', () => {
  it('defaults to open, newest, page 1 and writes nothing for the defaults', () => {
    expect(parseIssueQuery(params(''))).toEqual(DEFAULT_ISSUE_QUERY)
    expect(issueQueryParams(DEFAULT_ISSUE_QUERY)).toEqual([])
  })

  it('round-trips every filter through the URL', () => {
    const q = parseIssueQuery(params(`state=closed&label=bug&label=good%20first&author=${ID}&assignee=me&mentions=me&sort=comments&q=crash&page=3`))
    expect(q).toEqual({ ...DEFAULT_ISSUE_QUERY, state: 'closed', labels: ['bug', 'good first'], author: ID, assignee: 'me', mentions: true, sort: 'comments', q: 'crash', page: 3 })
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
    expect(parseIssueQuery(params(`author=${ID}&q=author%3Aalice.dash`))).toMatchObject({ author: ID, q: '' })
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
    const q = parseSearchText('author:alice.dash is:merged foo:bar hello')
    expect(q.author).toBeNull()
    expect(q.state).toBe('open')
    expect(q.q).toBe('foo:bar hello')
    expect(unresolvedQualifiers('author:alice.dash is:merged foo:bar hello')).toEqual(['author:alice.dash', 'is:merged'])
  })

  it('never overrides a filter with an unresolvable qualifier', () => {
    const base = { ...DEFAULT_ISSUE_QUERY, author: ID, assignee: 'me', mentions: true, sort: 'comments' as const }
    const q = parseSearchText('author:alice.dash assignee:bob mentions:you sort:random', base)
    expect(q).toMatchObject({ author: ID, assignee: 'me', mentions: true, sort: 'comments', q: '' })
  })

  // A plain search-box submit's base (searchSubmitBase) must carry forward only the state tab —
  // searchText always writes the *whole* current query back into the box as text when it isn't
  // being edited, so the submitted text is the single source of truth for every other filter.
  // Using the full current query as base (a prior, buggy fix) would let a filter deleted from the
  // box (e.g. label:bug) silently keep applying, since liftQualifiers only overrides a field a
  // qualifier is present for and never clears one that's simply absent from the text.
  describe('searchSubmitBase (a plain #N or word search must not silently jump back to Open, and a deleted qualifier must actually clear)', () => {
    it("keeps the caller's state tab when the submitted text carries no is:/state: qualifier", () => {
      const base = searchSubmitBase({ ...DEFAULT_ISSUE_QUERY, state: 'all' })
      expect(parseSearchText('#3', base).state).toBe('all')
      expect(parseSearchText('crash', base).state).toBe('all')
    })

    it('still lets an explicit is:/state: qualifier in the text win over the base', () => {
      const base = searchSubmitBase({ ...DEFAULT_ISSUE_QUERY, state: 'all' })
      expect(parseSearchText('is:closed #3', base).state).toBe('closed')
    })

    it('removing a label:/mentions: qualifier from the text actually removes that filter', () => {
      const query = { ...DEFAULT_ISSUE_QUERY, labels: ['bug'], mentions: true }
      // Re-submitting the box with label:bug and mentions:@me deleted must clear both, not keep
      // them from the caller's current query.
      const q = parseSearchText('crash', searchSubmitBase(query))
      expect(q.labels).toEqual([])
      expect(q.mentions).toBe(false)
    })
  })

  it('reads -label:, no:label, milestone:, no:milestone, in: and comments: (QW-018, QW-020)', () => {
    const q = parseSearchText('-label:wontfix -label:"needs info" no:label milestone:"v1 0" no:milestone in:title comments:>2 crash')
    expect(q).toMatchObject({ notLabels: ['wontfix', 'needs info'], noLabel: true, milestone: 'v1 0', noMilestone: true, scope: 'title', comments: '>2', q: 'crash' })
    expect(parseSearchText('in:body').scope).toBe('body')
    expect(parseSearchText('in:title,body').scope).toBe('any')
    expect(unresolvedQualifiers('-label:wontfix milestone:v1 in:title comments:1..3')).toEqual([])
  })

  it('reports the GitHub qualifiers it does not apply rather than searching for them (QW-020)', () => {
    const text = 'in:comments comments:lots review:approved review-requested:@me draft:true created:>2024-01-01 -author:bob foo:bar'
    expect(unresolvedQualifiers(text)).toEqual(['in:comments', 'comments:lots', 'review:approved', 'review-requested:@me', 'draft:true', 'created:>2024-01-01', '-author:bob'])
    // An unknown key is not a GitHub qualifier: it stays free text.
    expect(parseSearchText(text).q).toBe('foo:bar')
    const reason = droppedQualifiersReason(unresolvedQualifiers(text))
    expect(reason).toContain('in: takes title or body')
    expect(reason).toContain('comments: takes a count')
    expect(reason).toContain('review: is not a list filter')
    expect(reason).toContain('are pull request filters')
    expect(reason).toContain('created: is not a filter here.')
    expect(reason).toContain('Only -label: can be negated here.')
  })

  it('keeps a GitHub key with no value as the prose it is ("status: broken")', () => {
    expect(unresolvedQualifiers('status: broken type: error')).toEqual([])
    expect(parseSearchText('status: broken type: error').q).toBe('status: broken type: error')
    // An applied key with no value is still reported.
    expect(unresolvedQualifiers('label: milestone:')).toEqual(['label:', 'milestone:'])
  })

  it('reads back a URL whose q carries long qualifiers, uncut', () => {
    const q = parseSearchText(
      '-label:"needs more discussion" -label:"blocked upstream" -label:wontfix-maybe milestone:"Release 2026 Q4 stabilisation and hardening sprint" in:title comments:>=10 a longer free text search for the crash on startup',
    )
    const text = issueQueryParams(q).find(([k]) => k === 'q')?.[1] ?? ''
    expect(text.length).toBeGreaterThan(200)
    const back = parseIssueQuery(new URLSearchParams(issueQueryParams(q)))
    expect(back).toMatchObject({ notLabels: q.notLabels, milestone: q.milestone, scope: 'title', comments: '>=10', q: q.q })
  })

  it('takes an author name with no identity behind it as a mirrored login (QW-062)', () => {
    expect(parseSearchText('author:thephez')).toMatchObject({ author: null, authorLogin: 'thephez', q: '' })
    expect(parseSearchText('author:@thephez')).toMatchObject({ authorLogin: 'thephez' })
    // An id (or a DPNS name rewritten to one) replaces the login, and the reverse.
    expect(parseSearchText(`author:thephez author:${ID}`)).toMatchObject({ author: ID, authorLogin: null })
    expect(parseSearchText('author:thephez', { ...DEFAULT_ISSUE_QUERY, author: ID })).toMatchObject({ author: null, authorLogin: 'thephez' })
    // A DPNS-shaped name is never a login: said as not applied.
    expect(unresolvedQualifiers('author:alice.dash')).toEqual(['author:alice.dash'])
  })

  it('carries the extra qualifiers in ?q= and reads them back (a reload keeps them)', () => {
    const q = { ...DEFAULT_ISSUE_QUERY, notLabels: ['wontfix'], milestone: 'v1 0', authorLogin: 'thephez', scope: 'body' as const, comments: '1..3', q: 'crash' }
    const url = new URLSearchParams(issueQueryParams(q))
    expect(url.get('q')).toBe('-label:wontfix milestone:"v1 0" author:thephez in:body comments:1..3 crash')
    expect(parseIssueQuery(url)).toEqual(q)
    expect(hasFilters({ ...DEFAULT_ISSUE_QUERY, noMilestone: true })).toBe(true)
    expect(hasFilters({ ...DEFAULT_ISSUE_QUERY, scope: 'title' })).toBe(false)
  })

  it('writes the query back as text that parses to the same query', () => {
    const q = { ...DEFAULT_ISSUE_QUERY, state: 'all' as const, labels: ['bug', 'two words'], assignee: 'none', sort: 'oldest' as const, q: 'crash' }
    const text = searchText(q)
    expect(text).toBe('is:all label:bug label:"two words" no:assignee sort:created-asc crash')
    expect(parseSearchText(text)).toEqual(q)
  })
})

describe('rowMatches with the extra filters', () => {
  const MIRROR = 'MirrorIdentity1111111111111111111111111111'
  const base = { labels: [], author: null, assignee: null, mentions: null, text: '' }
  const row = {
    title: 'Update DIP-2 table',
    number: 119,
    body: 'The table is out of date.',
    author: MIRROR,
    origin: { author: 'thephez', createdAt: 0, url: 'https://github.com/dashpay/dips/issues/119', host: 'github.com' },
    comments: 3,
    milestone: 'v1.0',
    state: { labels: ['bug'], assignees: [] },
  }
  const filters = (q: Partial<typeof DEFAULT_ISSUE_QUERY>, trust: ReadonlySet<string> | null = new Set([MIRROR])) =>
    ({ ...base, ...rowFiltersOf({ ...DEFAULT_ISSUE_QUERY, ...q }, trust) })

  it('filters by milestone and no:milestone (QW-018)', () => {
    expect(rowMatches(row, filters({ milestone: 'v1.0' }))).toBe(true)
    expect(rowMatches(row, filters({ milestone: 'v2.0' }))).toBe(false)
    expect(rowMatches(row, filters({ noMilestone: true }))).toBe(false)
    expect(rowMatches({ ...row, milestone: null }, filters({ noMilestone: true }))).toBe(true)
  })

  it('filters by -label: and no:label', () => {
    expect(rowMatches(row, filters({ notLabels: ['bug'] }))).toBe(false)
    expect(rowMatches(row, filters({ notLabels: ['wontfix'] }))).toBe(true)
    expect(rowMatches(row, filters({ noLabel: true }))).toBe(false)
    expect(rowMatches({ ...row, state: { labels: [], assignees: [] } }, filters({ noLabel: true }))).toBe(true)
  })

  it('filters by comment count, never counting an uncounted row', () => {
    expect(rowMatches(row, filters({ comments: '>2' }))).toBe(true)
    expect(rowMatches(row, filters({ comments: '>3' }))).toBe(false)
    expect(rowMatches({ ...row, comments: null }, filters({ comments: '>=0' }))).toBe(false)
  })

  it("matches a mirrored author's login only on a trusted mirror's items (QW-062)", () => {
    expect(rowMatches(row, filters({ authorLogin: 'THEPHEZ' }))).toBe(true)
    expect(rowMatches(row, filters({ authorLogin: 'coolaj86' }))).toBe(false)
    // Anyone can write an `imported` author into their own issue: an untrusted signer's never matches.
    expect(rowMatches(row, filters({ authorLogin: 'thephez' }, new Set()))).toBe(false)
    expect(rowMatches(row, filters({ authorLogin: 'thephez' }, null))).toBe(false)
  })

  it('scopes free text with in:', () => {
    expect(rowMatches(row, { ...filters({ scope: 'title' }), text: 'out' })).toBe(false)
    expect(rowMatches(row, { ...filters({}), text: 'out' })).toBe(true)
  })
})

describe('comment-count ranges (QW-020)', () => {
  it("reads GitHub's comments: forms", () => {
    expect(commentRange('3')).toEqual({ min: 3, max: 3 })
    expect(commentRange('>2')).toEqual({ min: 3, max: Infinity })
    expect(commentRange('>=2')).toEqual({ min: 2, max: Infinity })
    expect(commentRange('<2')).toEqual({ min: 0, max: 1 })
    expect(commentRange('<=2')).toEqual({ min: 0, max: 2 })
    expect(commentRange('1..3')).toEqual({ min: 1, max: 3 })
    expect(commentRange('2..*')).toEqual({ min: 2, max: Infinity })
    expect(commentRange('*..2')).toEqual({ min: 0, max: 2 })
    for (const bad of ['', '<0', '3..1', '*..*', 'lots', '>', '-1']) expect(commentRange(bad)).toBeNull()
  })
})

describe('pastLastPage (QW-068)', () => {
  it('names the last page only when the page lies past it', () => {
    expect(pastLastPage(9, 140, 25)).toBe(6)
    expect(pastLastPage(6, 140, 25)).toBeNull()
    expect(pastLastPage(2, 0, 25)).toBe(1)
    expect(pastLastPage(9, null, 25)).toBeNull()
    expect(pastLastPage(1, 0, 25)).toBeNull()
  })
})

describe('free-text match', () => {
  const row = { title: 'Crash when the Config is empty', number: 12 }
  it('matches a quoted phrase as a whole, without its quotes (QW-021)', () => {
    const dip = { title: 'DIP-15: DashPay', number: 3 }
    expect(matchesText('"DIP-15"', dip)).toBe(true)
    expect(matchesText('DIP-15', dip)).toBe(true)
    expect(matchesText('"the config"', row)).toBe(true)
    expect(matchesText('"config the"', row)).toBe(false)
    expect(searchTerms('"DIP-15" crash "two words"').map((t) => t.text)).toEqual(['dip-15', 'crash', 'two words'])
  })
  it('excludes a negated word or phrase, as GitHub does (QW3-018)', () => {
    const dip = { title: 'DIP-15: DashPay contacts', number: 3 }
    const other = { title: 'DIP-16: Headers first', number: 4, body: 'Two words here.' }
    expect(searchTerms('-"two words" -DIP-15 - "--force"')).toEqual([
      { text: 'two words', not: true },
      { text: 'dip-15', not: true },
      { text: '-', not: false },
      { text: '--force', not: false },
    ])
    // A `-` inside quotes is literal: the way to search for text that starts with one.
    expect(matchesText('"--force"', { title: 'Push with --force', number: 9 })).toBe(true)
    expect(matchesText('"--force"', { title: 'Push', number: 9 })).toBe(false)
    expect(matchesText('-DIP-15', dip)).toBe(false)
    expect(matchesText('-"DIP-15"', dip)).toBe(false)
    expect(matchesText('-DIP-15', other)).toBe(true)
    expect(matchesText('dip -dashpay', other)).toBe(true)
    expect(matchesText('dip -dashpay', dip)).toBe(false)
    expect(matchesText('-"two words"', other)).toBe(false)
    expect(matchesText('-"two words"', dip)).toBe(true)
    expect(matchesText('-#3', dip)).toBe(false)
    expect(matchesText('-#3', other)).toBe(true)
  })
  it('looks in titles and bodies by default, and in one of them with in: (QW-020)', () => {
    const r = { title: 'Crash on start', number: 4, body: 'The HMAC check fails.' }
    expect(matchesText('hmac', r)).toBe(true)
    expect(matchesText('hmac', r, 'title')).toBe(false)
    expect(matchesText('hmac', r, 'body')).toBe(true)
    expect(matchesText('crash', r, 'body')).toBe(false)
  })
  it("never matches a mirrored body's provenance quote", () => {
    const r = { title: 'Update DIP-2', number: 5, body: '> Mirrored from github.com/dashpay/dips#119 by @thephez (issue, 2022-01-01)\n>\n\nThe table is out of date.' }
    expect(matchesText('dashpay', r)).toBe(false)
    expect(matchesText('thephez', r)).toBe(false)
    expect(matchesText('table', r)).toBe(true)
  })
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
  // Review (L-43): unlike a bare number, `#n` is a number-only match — it must not fall through
  // to a title substring check even when the digits happen to appear in a different row's title.
  it('#n never falls back to a title substring match', () => {
    expect(matchesText('#7512', { title: 'issue 7512 duplicate', number: 1 })).toBe(false)
    expect(matchesText('#1', { title: 'issue 7512 duplicate', number: 7512 })).toBe(false)
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

  // Review: `me`/`none` are excluded case-insensitively, `@name` and a quoted single-word name
  // are accepted (an @ or quotes are not part of the name), a mixed-case name is left as typed
  // (DPNS normalization happens at lookup time, not here), and a value that cannot possibly be a
  // DPNS label (e.g. it contains a space) is rejected before it would ever be looked up.
  it('handles @name, a quoted name, mixed case, ME/NONE and a value that cannot be a label', () => {
    expect(
      dpnsAuthorCandidates(
        'author:@alice.dash assignee:"bob" author:CoffsEducation assignee:"two words" author:ME assignee:NONE',
      ),
    ).toEqual(['alice.dash', 'bob', 'CoffsEducation'])
  })

  it('rewrites a resolved name to its id and leaves an unresolved one unresolved', () => {
    const resolved = new Map([['coffseducation', ID]])
    const text = withResolvedNames('author:coffseducation assignee:nobody-knows-this is:open hello', resolved)
    expect(text).toBe(`author:${ID} assignee:nobody-knows-this is:open hello`)
    expect(parseSearchText(text)).toMatchObject({ author: ID, state: 'open', q: 'hello' })
    expect(unresolvedQualifiers(text)).toEqual(['assignee:nobody-knows-this'])
  })

  // Review: `me` (and `@me`) resolves case-insensitively wherever a qualifier value names the
  // viewer, not just in the exact-lowercase `@me` spelling `liftQualifiers` used to special-case.
  it('treats me as the viewer case-insensitively, with or without @', () => {
    expect(parseSearchText('author:ME assignee:@Me')).toMatchObject({ author: 'me', assignee: 'me' })
  })
})

// Review: the DPNS-resolution step (candidates -> lookups -> rewritten text) is a plain
// injected-resolver async function, independent of any component state, specifically so an
// out-of-order submit can be tested as a pure race: two overlapping calls must not interfere
// with each other regardless of which one's lookups happen to settle first.
describe('resolveSearchNames (review: race safety of an out-of-order submit)', () => {
  it('two overlapping calls each resolve correctly even when the first-issued one settles last', async () => {
    let settleAlice!: (id: string | null) => void
    const resolveId = vi.fn((name: string) => {
      if (name === 'alice') return new Promise<string | null>((resolve) => (settleAlice = resolve))
      return Promise.resolve(ID)
    })

    const first = resolveSearchNames('author:alice', resolveId) // issued first, resolves last
    const second = await resolveSearchNames('author:bob', resolveId) // issued second, resolves first
    expect(second).toEqual({ text: `author:${ID}`, notFound: [] })

    settleAlice(null) // alice turns out not to exist, settling only now
    expect(await first).toEqual({ text: 'author:alice', notFound: ['alice'] })
  })

  it('passes through text with no DPNS candidates without calling the resolver', async () => {
    const resolveId = vi.fn()
    expect(await resolveSearchNames('is:open hello', resolveId)).toEqual({ text: 'is:open hello', notFound: [] })
    expect(resolveId).not.toHaveBeenCalled()
  })
})

describe('droppedQualifiersReason (L-43)', () => {
  it('gives is:pr its own reason instead of the generic is:/state: one, naming the tab', () => {
    expect(droppedQualifiersReason(['is:pr'])).toMatch(/Pull requests tab/)
    expect(droppedQualifiersReason(['state:pr'])).toMatch(/Pull requests tab/)
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

  // Review: a name DPNS actually looked up and could not find gets a specific "no such name"
  // message (naming it, normalized to its full `label.dash` form), instead of the generic
  // shape-oriented reason, which would wrongly suggest the value itself was malformed.
  it('names a specific not-found value instead of the generic reason', () => {
    const reason = droppedQualifiersReason(['author:unofficial-dashpay-dash-mirror', 'assignee:bob'], ['unofficial-dashpay-dash-mirror'])
    expect(reason).toMatch(/No DPNS name `unofficial-dashpay-dash-mirror\.dash` was found\./)
    expect(reason).toMatch(/DPNS name, or @me/) // bob's generic reason is still reported
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

  it('keeps the closed-tab line, and a search that matches none in its tab points at the others (QW3-051)', () => {
    expect(emptyIssuesBody(true, 'open', 2)).toBe('None is open; 2 closed issues match.')
    expect(emptyIssuesBody(true, 'open', 1)).toBe('None is open; 1 closed issue matches.')
    expect(emptyIssuesBody(true, 'closed', 0, 1_200)).toBe('None is closed; 1,200 open issues match.')
    expect(emptyIssuesBody(true, 'open', null)).toBe('Try fewer filters, or search every state.')
    expect(emptyIssuesBody(true, 'open', 0)).toBe('Try fewer filters, or search every state.')
    expect(emptyIssuesBody(true, 'all', 3, 2)).toBe('Try fewer filters.')
    expect(emptyIssuesBody(false, 'closed', 0)).toBe('Nothing has been closed yet.')
  })
})
