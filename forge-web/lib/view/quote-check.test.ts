/** Whether public text repeats members-only text (DESIGN §3.3, §4.1; product H8; stream 1D round 2). */

import { describe, expect, it } from 'vitest'

import { QuoteIndex, canonicalText, quoteIndex, quotesMembersText } from './quote-check'

const MEMBERS = [
  'The staging database password is Tr0ub4dor-staging-42 and rotates on Friday.',
  'This looks like the account that spammed us last month, so keep it closed.',
  '**Do not merge** until [the audit](https://example.com/audit/77) clears `pay_v2` for the EU launch.',
  'pw: hunter2-prod',
  'Thanks, looks good to me!',
  'LGTM',
  'AKIAIOSFODNN7EXAMPLEKEY1234567890ABCD',
  '- step one: rotate the HSM signing key\n- step two: revoke the old one',
  'We can\'t ship the "fast path" until the vendor signs the NDA.',
  'Use cryptographically-randomized nonces everywhere internally',
]

const INDEX = new QuoteIndex(MEMBERS)

describe('the canonical form both sides are compared in', () => {
  it('drops markup, markers, invisible characters and case, keeping the words', () => {
    expect(canonicalText('> - [x] **Do not** merge [the audit](https://x.y/z) `pay_v2`')).toBe('do not merge the audit pay v2')
    expect(canonicalText('We can’t ship the “fast path”')).toBe(canonicalText('We can\'t ship the "fast path"'))
    expect(canonicalText('data​base ｈｕｎｔｅｒ２')).toBe('database hunter2')
    expect(canonicalText('```ts\nconst a = 1\n```')).toBe('const a 1')
    expect(canonicalText('<details>see <https://x.y/a></details>')).toBe('see https x y a')
  })
})

describe('public text that repeats members-only text', () => {
  const asks: readonly (readonly [string, string])[] = [
    ['a prefix before the copy', 'FYI: The staging database password is Tr0ub4dor-staging-42'],
    ['a question after the copy, lower case', 'the staging database password is tr0ub4dor-staging-42. Thoughts?'],
    ['a list item', '- the account that spammed us last month'],
    ['a numbered list item', '1. the account that spammed us last month'],
    ['upper case', 'THE ACCOUNT THAT SPAMMED US LAST MONTH'],
    ['a heading', '## The staging database password is Tr0ub4dor'],
    ['a nested quote', '> > the account that spammed us'],
    ['a short quoted line', '> rotate the HSM signing key'],
    ['the rendered text of bold, a link and code', 'Do not merge until the audit clears pay_v2 for the EU launch.'],
    ['other markup over the same words', 'Do *not* merge until __the audit__ clears'],
    ['a link around the copy', '[the account that spammed us last month](https://x.y)'],
    ['smart quotes', 'We can’t ship the “fast path” until the vendor signs'],
    ['a zero-width character inside a word', 'the staging data​base password is Tr0ub4dor'],
    ['full-width characters (NFKC)', 'pw: ｈｕｎｔｅｒ２-prod'],
    ['a short secret posted inside a sentence', 'my creds were pw: hunter2-prod, sorry'],
    ['a long token after a label', 'key: AKIAIOSFODNN7EXAMPLEKEY1234567890ABCD'],
    ['32 characters of few words', 'x cryptographically-randomized nonces everywhere'],
    ['a copy spread over two lines', 'the account that spammed\nus last month'],
  ]
  it.each(asks)('asks for %s', (_what, draft) => {
    expect(quotesMembersText(draft, INDEX)).toBe(true)
    // Plain texts prepare the same index on the spot.
    expect(quotesMembersText(draft, MEMBERS)).toBe(true)
  })

  const quiet: readonly (readonly [string, string])[] = [
    ['a common reply a members-only comment also says', 'Thanks, looks good to me!'],
    ['LGTM', 'LGTM'],
    ['a longer reply of filler words', 'Thanks for the review, looks good to me now'],
    ['another run of filler', 'thanks, will do. looks good to me, merging now'],
    ['a few shared words', 'The staging server is down again'],
    ['two shared words', 'the account'],
    ['a short quote of filler', '> I agree'],
    ['a short line of filler a members-only text holds', 'so keep it closed'],
    ['a near miss of a short secret', 'pw: hunter3-prod'],
    ['punctuation only', '... --- !!! > -'],
    ['nothing', ''],
  ]
  it.each(quiet)('does not ask for %s', (_what, draft) => {
    expect(quotesMembersText(draft, INDEX)).toBe(false)
  })

  it('never asks without members-only text', () => {
    expect(quotesMembersText('> anything at all, the account that spammed us last month', [])).toBe(false)
    expect(quoteIndex([]).empty).toBe(true)
  })

  it('asks for the address of a link or image in members-only text, not for a bare site', () => {
    const members = ['Draft advisory is [here](https://docs.example.com/d/1AbCdEf/edit "draft") - do not share', '![diagram](https://img.example.com/x/9f8e7d.png)', 'see [our site](https://example.org/)']
    expect(quotesMembersText('Background: https://docs.example.com/d/1AbCdEf/edit', members)).toBe(true)
    expect(quotesMembersText('<https://img.example.com/x/9f8e7d.png>', members)).toBe(true)
    expect(quotesMembersText('More at https://example.org/ and elsewhere', members)).toBe(false)
  })

  it('does not ask for a short ordinary remark repeated inside public text', () => {
    expect(quotesMembersText('Same issue on windows 11 for me', ['Same issue on windows'])).toBe(false)
    expect(quotesMembersText('It works on linux here, thanks', ['works on linux'])).toBe(false)
    // A short secret still asks: two content words, or one that looks like a secret.
    expect(quotesMembersText('creds: pw hunter2-prod', ['pw: hunter2-prod'])).toBe(true)
    expect(quotesMembersText('try Tr0ub4dor3x', ['Tr0ub4dor3x'])).toBe(true)
  })

  it('asks for a token copied out of a longer members-only text into a sentence', () => {
    const members = ['Members-only note for the team.\n\nQAMARKwbx2-orchid-lantern-4471\n\nDo not share outside the repo.']
    // Its own line, copied whole into a longer public line.
    expect(quotesMembersText('Context from the team: QAMARKwbx2-orchid-lantern-4471', members)).toBe(true)
    // One secret-looking word of it is enough.
    expect(quotesMembersText('the code is qamarkwbx2 I think', members)).toBe(true)
    expect(quotesMembersText('Use key Zx9pQ2rT7v for staging', ['Rotate: the staging key is Zx9pQ2rT7v until Monday, then a new one.'])).toBe(true)
  })

  it('does not ask for a commit id both texts name, nor for an ordinary short line', () => {
    expect(quotesMembersText('Rebased onto 4f3c2a9b1e7d', ['Fixed in 4f3c2a9b1e7d, see the review'])).toBe(false)
    expect(quotesMembersText('It works on linux here, thanks', ['works on linux\nsee you'])).toBe(false)
  })

  it('checks extra members-only text too (the writer’s own unposted members-only text)', () => {
    expect(quotesMembersText('the vendor will sign it next week, keep quiet', [], { extra: ['The vendor will sign it next week.'] })).toBe(true)
    expect(quotesMembersText('Changes requested: see the review', INDEX, { extra: ['The vendor will sign it next week.'] })).toBe(false)
  })
})

describe('an edit', () => {
  it('asks only for what it adds, a run inside a line included', () => {
    // A secret added in the middle of an existing line.
    expect(quotesMembersText('Please check the config, pw: hunter2-prod, today', INDEX, { before: 'Please check the config today' })).toBe(true)
    // An earlier quote extended into a longer copy.
    expect(quotesMembersText('the account that spammed us last month', INDEX, { before: 'the account that' })).toBe(true)
    // Text the item already had, with something unrelated added.
    const before = '> the account that spammed us last month\n\nI agree.'
    expect(quotesMembersText(`${before} Closing it.`, INDEX, { before })).toBe(false)
    // A typo fixed outside the quote.
    expect(quotesMembersText('> the account that spammed us last month\n\nI agree!', INDEX, { before })).toBe(false)
  })
})
