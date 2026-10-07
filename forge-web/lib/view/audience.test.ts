/** The audience chip, picker copy and composer warnings (DESIGN §10, product H8, M3; stream 1D). */

import { describe, expect, it } from 'vitest'

import type { Membership } from '../rules/v2'
import {
  ENABLE_ANCHOR_CREDITS,
  ENABLE_WRAP_CREDITS,
  LETTER_TITLE,
  MEMBERS_OPTION_TEXT,
  QUOTE_CONFIRM,
  aboutDash,
  audienceChoice,
  audienceLabel,
  audienceWarnings,
  countWithMembersOnly,
  enableEstimate,
  keyHolders,
  lockedCount,
  membersCount,
  membersOnlyTitle,
  membersSentence,
  publicLineQuestion,
  quotesMembersText,
  removalReads,
  submitSummary,
  turnOnText,
} from './audience'
import { draftAudienceCounts } from './pending-review'
import { NO_KEY_SHARED_TEXT } from '../repo/members-writes'

const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const MEMBERS = [m('alice', 'maintainer'), m('bob', 'writer'), m('bob', 'maintainer'), m('carl', 'reader'), m('dora', 'triage'), m('bot', 'reader')]

describe('who the Members audience is', () => {
  it('counts each key holder once, readers by their only role, and CI bots only when a runner is a member', () => {
    expect(keyHolders(MEMBERS, 'public')).toEqual(new Set(['alice', 'bob', 'carl', 'dora', 'bot']))
    expect(membersCount(MEMBERS, 'public')).toEqual({ total: 5, readers: 2, bots: 0 })
    expect(membersCount(MEMBERS, 'public', ['bot', 'runner-only'])).toEqual({ total: 5, readers: 2, bots: 1 })
  })

  it('says the picker sentence with honest counts (product M3)', () => {
    expect(membersSentence({ total: 12, readers: 2, bots: 1 })).toBe(
      'Current and future members of this repo (12, including 2 readers and 1 CI bot). Members removed later keep what they could already read. Maintainers can make it public later.',
    )
    expect(membersSentence({ total: 3, readers: 0, bots: 0 })).toBe(
      'Current and future members of this repo (3). Members removed later keep what they could already read. Maintainers can make it public later.',
    )
    expect(membersSentence({ total: 4, readers: 1, bots: 0 })).toContain('(4, including 1 reader)')
  })

  it('labels the chip', () => {
    expect(audienceLabel('public', 12)).toBe('Public')
    expect(audienceLabel('members', 12)).toBe('Members (12)')
    expect(audienceLabel('members', null)).toBe('Members')
  })
})

describe('what a composer offers', () => {
  const choice = (lane: Parameters<typeof audienceChoice>[0]['lane'], parent: 'public' | 'members' = 'public', maintainer = false) => audienceChoice({ visibility: 'public', parent, lane, maintainer })

  it('defaults to the context, and hides Public inside a members-only thread', () => {
    expect(choice({ access: 'none' })).toMatchObject({ initial: 'public', publicAllowed: true })
    expect(choice(undefined, 'members')).toMatchObject({ initial: 'members', publicAllowed: false })
  })

  it('offers Members to members only, with why it cannot be picked yet', () => {
    expect(choice(undefined)).toEqual({ initial: 'public', members: null, publicAllowed: true })
    expect(choice({ access: 'none' }, 'public', true)?.members).toBe('turn-on')
    expect(choice({ access: 'none' }, 'public', false)?.members).toBe('ask-maintainer')
    expect(choice({ access: 'no-key' })?.members).toBe('no-key')
    expect(choice({ access: 'locked' })?.members).toBe('locked')
    expect(choice({ access: 'no-key-shared' })?.members).toBe('no-key-shared')
  })

  it('never offers Members to a member removed since, who reads only what was written before', () => {
    const session = {} as never
    expect(choice({ access: 'former', session })).toEqual({ initial: 'public', members: 'former', publicAllowed: true })
    expect(choice({ access: 'former', session }, 'members')).toEqual({ initial: 'members', members: 'former', publicAllowed: false })
    expect(MEMBERS_OPTION_TEXT.former).toBe("You're no longer a member of this repo, so you can't write members-only content.")
  })

  it('has no chip in a private repo (everything there is members-only)', () => {
    expect(audienceChoice({ visibility: 'private', parent: 'members', lane: undefined, maintainer: true })).toBeNull()
  })
})

describe('turning members-only content on', () => {
  it('estimates as dg does: one anchor and a wrap per member (about 0.00185 DASH for two)', () => {
    expect(enableEstimate(2)).toBe(ENABLE_ANCHOR_CREDITS + 2 * ENABLE_WRAP_CREDITS)
    expect(enableEstimate(2)).toBe(185_000_000)
    expect(aboutDash(enableEstimate(2))).toBe('0.0019 DASH')
    // the maintainer turning it on always gets a wrap
    expect(enableEstimate(0)).toBe(enableEstimate(1))
  })

  it('says the sheet in short sentences, with the older-builds note and no semicolons', () => {
    const text = turnOnText(5)
    expect(text[1]).toBe(`Setting up keys for 5 members costs about ${aboutDash(enableEstimate(5))}. Each later removal costs about the same again.`)
    expect(text[2]).toBe('People using older Forge builds will see fewer things until they update.')
    for (const p of text) expect(p).not.toMatch(/;|sealed|lane/)
  })

  it('says so honestly when the maintainer is the only member', () => {
    for (const n of [0, 1]) expect(turnOnText(n)[1]).toBe(`You're the only member so far. Setting up your key costs about ${aboutDash(enableEstimate(1))}.`)
  })
})

describe('what an edit adds, for the quote check', () => {
  it('counts only what the edit adds, so a typo fix in quoted text never asks', () => {
    const before = 'Fix the login bug\nSteps: open the page'
    expect(quotesMembersText('Fix the login bug\nSteps: open the page.', ['Steps: open the page'], { before })).toBe(false)
    expect(quotesMembersText(`${before}\n> a quoted members-only line`, ['a quoted members-only line here'], { before })).toBe(true)
  })
})

describe('E311 and specific-people wording', () => {
  it("uses the one E311 text, which says how to get the key shared (DESIGN §10)", () => {
    expect(MEMBERS_OPTION_TEXT['no-key-shared']).toBe(NO_KEY_SHARED_TEXT)
    expect(NO_KEY_SHARED_TEXT).toBe("You're a member, but no key has been shared with you yet. Ask a maintainer to share it: Repair on the repo page, or dg repo keys repair.")
  })

  it('names a specific-people document neutrally, never members-only', () => {
    expect(membersOnlyTitle('comment', 'specificPeople')).toBe('Encrypted for specific people')
    expect(LETTER_TITLE).toBe('Encrypted for specific people')
    expect(membersOnlyTitle('patch')).toBe('Members-only pull request')
  })
})

describe('composer warnings (product H8)', () => {
  const holders = new Set(['alice', 'bob'])
  const holderNames = new Set(['alice', 'bob'])

  it("warns that the thread's author and a mentioned non-member can't read members-only text", () => {
    const thread = { author: 'carol', authorName: 'carol', kind: 'pull' as const }
    expect(audienceWarnings({ audience: 'members', text: 'cc @dave and @bob', holders, holderNames, thread })).toEqual([
      "@carol opened this PR and won't be able to read this.",
      "@dave won't be able to read this.",
    ])
    // a mention of the author is said once
    expect(audienceWarnings({ audience: 'members', text: '@carol see this', holders, holderNames, thread })).toHaveLength(1)
  })

  it('has nothing to say about public text, or a member author', () => {
    expect(audienceWarnings({ audience: 'public', text: '@dave', holders, holderNames, thread: null })).toEqual([])
    expect(audienceWarnings({ audience: 'members', text: 'fine', holders, holderNames, thread: { author: 'alice', authorName: 'alice', kind: 'issue' } })).toEqual([])
  })

  it('asks before a public post that quotes or copies members-only text', () => {
    const members = ['This looks like the account that spammed us last month, so keep it closed.']
    expect(quotesMembersText('> the account that spammed us\n\nI agree', members)).toBe(true)
    expect(quotesMembersText('the account that spammed us last month, so', members)).toBe(true)
    expect(quotesMembersText('> I agree', members)).toBe(false)
    expect(quotesMembersText('the account', members)).toBe(false)
    expect(quotesMembersText('> anything', [])).toBe(false)
    expect(QUOTE_CONFIRM).toBe("You're quoting a members-only comment into a public reply. Everyone will be able to read the quoted text.")
  })

  it('summarises a mixed review at submit', () => {
    expect(submitSummary({ members: 1, public: 2 })).toBe('Submitting 1 members-only and 2 public comments')
    expect(submitSummary({ members: 3, public: 0 })).toBe('Submitting 3 members-only comments')
    expect(submitSummary({ members: 0, public: 3 })).toBeNull()
    const draft = { summary: '', comments: [{ audience: 'members' as const }, {}, {}] }
    expect(draftAudienceCounts(draft as never, 'public')).toEqual({ members: 1, public: 2 })
    expect(draftAudienceCounts(draft as never, 'members')).toEqual({ members: 3, public: 0 })
    // the review's own text counts when it has some, by its own audience
    expect(draftAudienceCounts({ ...draft, summary: 'looks off', audience: 'members' } as never, 'public')).toEqual({ members: 2, public: 2 })
  })

  it("asks for one public line when a members-only review blocks an author who can't read it", () => {
    const ask = (verdict: 'approve' | 'requestChanges' | 'comment', audience: 'public' | 'members', author = 'carol') =>
      publicLineQuestion({ verdict, audience, author, authorName: author, holders: new Set(['bob']) })
    expect(ask('requestChanges', 'members')).toBe("This review blocks the PR, but its text is members-only and @carol can't read it. Add one public line?")
    expect(ask('approve', 'members')).toBeNull()
    expect(ask('requestChanges', 'public')).toBeNull()
    expect(ask('requestChanges', 'members', 'bob')).toBeNull()
  })

  it('does not ask on a members-only PR, nor before the members are known', () => {
    const base = { verdict: 'requestChanges' as const, audience: 'members' as const, author: 'carol', authorName: 'carol' }
    expect(publicLineQuestion({ ...base, holders: new Set(['bob']), prMembersOnly: true })).toBeNull()
    // members not read yet (or none): nobody is known to be unable to read it
    expect(publicLineQuestion({ ...base, holders: new Set() })).toBeNull()
    expect(publicLineQuestion({ ...base, holders: new Set(['bob']), prMembersOnly: false })).not.toBeNull()
  })
})

describe('counts and lines', () => {
  it('labels counts that include members-only items', () => {
    expect(countWithMembersOnly(5, 4, 'comment')).toBe('5 comments (4 members-only)')
    expect(countWithMembersOnly(3, 0, 'issue')).toBe('3 issues')
    expect(lockedCount([{ type: 'comment' }, { type: 'review' }, { type: 'comment' }])).toBe('3 members-only comments')
  })

  it('lists what a removed member could read, with room for other features', () => {
    expect(removalReads(true)).toEqual(['Members-only issues, comments and reviews posted so far'])
    expect(removalReads(false, ['7 production secrets'])).toEqual(['7 production secrets'])
  })
})
