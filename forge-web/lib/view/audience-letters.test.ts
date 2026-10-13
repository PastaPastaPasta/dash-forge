/**
 * Messages to specific people as people see them (DESIGN §4.2, §10, D14, D26; stream 2A): the
 * picker's options per context, the "Visible to …" rule, the placeholders' recipient counts, the
 * composer's refusals and notes, and that such text is never kept at rest.
 */

import { describe, expect, it } from 'vitest'

import type { MembersAccess } from './repo-view'
import {
  LETTER_OPTION_TEXT,
  NO_LETTER_ASK,
  SPECIFIC_PEOPLE_SENTENCE,
  audienceChoice,
  audienceWarnings,
  countWithMembersOnly,
  forwardText,
  groupLabel,
  groupSentence,
  inGroupNow,
  letterChipLabel,
  letterLabel,
  letterRefusalText,
  membersOnlyTitle,
  notPublic,
  placeholderTitle,
  publicLineQuestion,
  publicTextOf,
  skippedText,
  tooManyText,
  wideningText,
} from './audience'
import { commentDraftKey } from './draft-text'
import { draftAudienceCounts, draftMembersTexts, draftPublicTexts, setDraftAudience } from './pending-review'
import { countMembersOnly } from '../repo/members-only-counts'
import { draftHasMembersText, type ReviewDraft } from '../repo/review-writes'
import type { Membership } from '../rules/v2'

const names: Record<string, string> = { a: 'alice', b: 'bob', c: 'carol', d: 'dana', me: 'pat', f: 'frank' }
const nameOf = (id: string): string => names[id] ?? id

describe('who an opened message is visible to', () => {
  it('names everyone, the viewer as "you", last', () => {
    expect(letterLabel({ letter: { recipients: ['a', 'me', 'b'], group: null }, viewer: 'me', nameOf })).toBe('alice, bob and you')
    expect(letterLabel({ letter: { recipients: ['me', 'a'], group: null }, viewer: 'me', nameOf })).toBe('alice and you')
    expect(letterLabel({ letter: { recipients: ['a', 'b'], group: null }, viewer: 'b', nameOf })).toBe('alice and you')
  })

  it('names a role group as it was sent, and its writer after it when they are outside the group now', () => {
    const maintainers = { recipients: ['d', 'a', 'b', 'c'], group: 'maintainers' as const }
    expect(letterLabel({ letter: maintainers, viewer: 'x', nameOf, writerInGroup: false })).toBe('alice, bob, carol (maintainers when sent) and dana')
    expect(letterLabel({ letter: maintainers, viewer: 'd', nameOf, writerInGroup: false })).toBe('alice, bob, carol (maintainers when sent) and you')
    expect(letterLabel({ letter: maintainers, viewer: 'b', nameOf, writerInGroup: false })).toBe('alice, carol, you (maintainers when sent) and dana')
    // a writer still in the group is one of its people
    expect(letterLabel({ letter: maintainers, viewer: 'x', nameOf, writerInGroup: true })).toBe('dana, alice, bob, carol (maintainers when sent)')
    expect(letterLabel({ letter: { recipients: ['d', 'a'], group: 'writers' }, viewer: 'x', nameOf, writerInGroup: false })).toBe('alice (writers and maintainers when sent) and dana')
  })

  it('knows who is in a group now: the owner always, then by role', () => {
    const members: Membership[] = [{ identity: 'a', role: 'maintainer', createdAt: 0 }, { identity: 'b', role: 'writer', createdAt: 0 }, { identity: 'c', role: 'reader', createdAt: 0 }]
    expect(inGroupNow('maintainers', 'o', 'o', members)).toBe(true)
    expect(inGroupNow('maintainers', 'a', 'o', members)).toBe(true)
    expect(inGroupNow('maintainers', 'b', 'o', members)).toBe(false)
    expect(inGroupNow('writers', 'b', 'o', members)).toBe(true)
    expect(inGroupNow('writers', 'c', 'o', members)).toBe(false)
  })
})

describe('the chip and the picker', () => {
  it('says the group with its size, or the people', () => {
    expect(letterChipLabel({ group: 'maintainers', people: [], exact: null }, { recipients: null, groupCount: 3, viewer: 'me', nameOf })).toBe('Maintainers (3)')
    expect(letterChipLabel({ group: 'writers', people: [], exact: null }, { recipients: null, groupCount: 7, viewer: 'me', nameOf })).toBe('Writers and maintainers (7)')
    expect(letterChipLabel({ group: null, people: ['a', 'b'], exact: null }, { recipients: ['me', 'a', 'b'], groupCount: null, viewer: 'me', nameOf })).toBe('alice, bob and you')
    expect(letterChipLabel(NO_LETTER_ASK, { recipients: null, groupCount: null, viewer: null, nameOf })).toBe('Specific people')
  })

  it('words each option as DESIGN §10 does', () => {
    expect(groupLabel('maintainers', 3)).toBe('Maintainers (3)')
    expect(groupSentence('maintainers', 3)).toBe('Sent to the 3 current maintainers. People who become maintainers later see it only if someone adds them.')
    expect(groupSentence('writers', 7)).toBe('Sent to the 7 people with Write access or more right now.')
    expect(SPECIFIC_PEOPLE_SENTENCE).toBe("You're always included. Up to 16 people. Replying with someone added lets them read from that reply on, not earlier ones.")
    expect(tooManyText('writers', 23)).toBe('Writers and maintainers is 23 people. A message can go to at most 16. Choose All members or pick people.')
  })

  const choice = (input: Partial<Parameters<typeof audienceChoice>[0]> = {}) =>
    audienceChoice({ visibility: 'public', parent: 'public', lane: { access: 'member' } as MembersAccess, maintainer: false, letters: { offered: true, key: 'open' }, ...input })

  it('on a public thread: everything, Public first', () => {
    expect(choice()).toEqual({ initial: 'public', members: 'ok', publicAllowed: true, letters: 'ok', lettersOnly: false })
    // a stranger may still send to people (D14: strangers' messages exist)
    expect(choice({ lane: undefined })).toMatchObject({ members: null, letters: 'ok', publicAllowed: true })
  })

  it('inside a members-only thread: no Public, Members first, the groups and people', () => {
    expect(choice({ parent: 'members' })).toEqual({ initial: 'members', members: 'ok', publicAllowed: false, letters: 'ok', lettersOnly: false })
  })

  it('inside a thread of messages to specific people: only Specific people, and only for those who read it', () => {
    expect(choice({ parent: 'specificPeople', letters: { offered: true, key: 'open', thread: 'open' } })).toEqual({ initial: 'specificPeople', members: null, publicAllowed: false, letters: 'ok', lettersOnly: true })
    expect(choice({ parent: 'specificPeople', letters: { offered: true, key: 'open', thread: 'unreadable' } })?.letters).toBe('cant-reply')
    expect(LETTER_OPTION_TEXT['cant-reply']).toBe('Only the people this was sent to can reply.')
  })

  it('in a private repo: Members first, the groups and people, never Public', () => {
    expect(choice({ visibility: 'private', parent: 'members', lane: undefined })).toEqual({ initial: 'members', members: 'ok', publicAllowed: false, letters: 'ok', lettersOnly: false })
    // without letters (a new pull request, or signed out) there is no chip, as before
    expect(choice({ visibility: 'private', parent: 'members', letters: { offered: false, key: 'open' } })).toBeNull()
  })

  it('says why the people options cannot be picked yet', () => {
    // no key in this browser: not offered (a member hears about the key under Members)
    expect(choice({ letters: { offered: true, key: 'none' } })?.letters).toBeNull()
    expect(choice({ letters: { offered: true, key: 'locked' } })?.letters).toBe('locked')
    expect(choice({ letters: { offered: true, key: null } })?.letters).toBeNull()
    expect(choice({ letters: { offered: false, key: 'open' } })?.letters).toBeNull()
  })
})

describe("the composer's refusals and notes", () => {
  it('words each refusal', () => {
    expect(letterRefusalText({ error: 'noRecipients' }, nameOf)).toBe('Choose who to send it to.')
    expect(letterRefusalText({ error: 'noEncryptionKey', people: ['f'] }, nameOf)).toBe("@frank can't receive members-only messages yet.")
    expect(letterRefusalText({ error: 'notMembers', people: ['f'] }, nameOf)).toBe("@frank isn't a member of this repo, so they can't be added to a members-only conversation.")
    expect(letterRefusalText({ error: 'notMembers', people: ['f', 'd'] }, nameOf)).toBe("@frank and @dana aren't members of this repo, so they can't be added to a members-only conversation.")
    expect(letterRefusalText({ error: 'narrower', people: ['b'] }, nameOf)).toBe("Replies can't leave out people who could read earlier messages: @bob.")
    expect(letterRefusalText({ error: 'tooMany', count: 23 }, nameOf, 'writers')).toBe(tooManyText('writers', 23))
  })

  it('says who is left out, and who reads from now on', () => {
    expect(skippedText(['d'], nameOf)).toBe("dana has no encryption key and won't receive it.")
    expect(skippedText([], nameOf)).toBeNull()
    expect(wideningText('frank')).toBe('frank will see messages from now on, not earlier ones.')
  })

  it("warns about the thread's author and @mentions who won't read it", () => {
    const warnings = audienceWarnings({ audience: 'specificPeople', text: 'cc @frank and @alice', holders: new Set(['me', 'a']), holderNames: new Set(['alice', 'pat']), thread: { author: 'c', authorName: 'carol', kind: 'issue' } })
    expect(warnings).toEqual(["@carol opened this issue and won't be able to read this.", "@frank won't be able to read this."])
    expect(publicLineQuestion({ verdict: 'requestChanges', audience: 'specificPeople', author: 'c', authorName: 'carol', holders: new Set(['me']) })).toMatch(/@carol can't read it/)
  })

  it('quotes a forwarded message with attribution', () => {
    expect(forwardText('alice', 'line one\n\nline two')).toBe('> @alice wrote:\n>\n> line one\n>\n> line two\n\n')
  })
})

describe('what a reader who cannot open it sees (D14)', () => {
  it('names a placeholder by its recipient count', () => {
    expect(membersOnlyTitle('comment', 'specificPeople', 3)).toBe('Comment to 3 people')
    expect(membersOnlyTitle('issue', 'specificPeople', 1)).toBe('Issue to 1 person')
    expect(membersOnlyTitle('patch', 'specificPeople', 2)).toBe('Pull request to 2 people')
    expect(membersOnlyTitle('review', 'specificPeople', 4)).toBe('Review to 4 people')
    expect(membersOnlyTitle('comment', 'specificPeople')).toBe('Encrypted for specific people')
    expect(placeholderTitle({ type: 'comment', why: 'letter', audience: 'specificPeople', recipientCount: 3 })).toBe('Comment to 3 people')
    expect(placeholderTitle({ type: 'comment', why: 'noKey', audience: 'members' })).toBe('Members-only comment')
  })

  it('counts messages to specific people apart from members-only ones', () => {
    expect(countWithMembersOnly(3, 1, 'issue', 'issues', 1)).toBe('3 issues (1 members-only, 1 to specific people)')
    expect(countWithMembersOnly(3, 0, 'issue', 'issues', 2)).toBe('3 issues (2 to specific people)')
    const open = { open: true }
    expect(countMembersOnly([{ audience: 'members', state: open }, { audience: 'specificPeople', state: open }, { state: { open: false } }, { audience: 'specificPeople', state: { open: false } }])).toEqual({
      open: 1,
      closed: 0,
      lettersOpen: 1,
      lettersClosed: 1,
    })
  })
})

describe('text to specific people is never kept at rest', () => {
  it('has no comment draft, and is not public text', () => {
    expect(commentDraftKey({ repoId: 'r', visibility: 'public' }, 't', 'me', 'specificPeople')).toBeNull()
    expect(publicTextOf('x', 'specificPeople')).toBeNull()
    expect(publicTextOf('x', undefined, 'specificPeople')).toBeNull()
    expect(notPublic('specificPeople')).toBe(true)
    expect(notPublic('public')).toBe(false)
  })

  it('keeps a review to specific people in memory only, every comment of it too', () => {
    const base = { draftId: 'd', network: 'devnet', identity: 'me', repoId: 'r', prId: 'p', headOid: 'ab'.repeat(20), verdict: 'comment', summary: 'sum', comments: [{ localId: 'c', anchor: { path: 'a', line: 1, side: 1 }, body: 'inline' }], startedAt: 0 } as unknown as ReviewDraft
    const letter = setDraftAudience(base, 'specificPeople', { group: 'maintainers', people: [], exact: null })
    expect(letter).toMatchObject({ audience: 'specificPeople', letter: { group: 'maintainers' } })
    expect(draftHasMembersText(letter)).toBe(true)
    expect(draftPublicTexts(letter)).toEqual([])
    expect(draftMembersTexts(letter)).toEqual(['sum', 'inline'])
    expect(draftAudienceCounts(letter, 'public')).toEqual({ members: 0, public: 0 })
    // back to public drops the people
    const back = setDraftAudience(letter, 'public')
    expect(back.audience).toBeUndefined()
    expect(back.letter).toBeUndefined()
  })
})
