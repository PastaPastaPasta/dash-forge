/** The copy of "Make this repo public" (DESIGN §10): dg's facts and order, in the dialog's words. */

import { describe, expect, it } from 'vitest'

import { COPY, MakePublicError, type MakePublicCensus } from '../repo/make-public'
import { MembersUnsettledError, PrivateMembersError } from '../repo/private-members'
import { EVERYTHING_RELEASES, EVERYTHING_TEXT, RUN_ERRORS, everythingCounts, notPublishedLine, othersLabel, refChoices, runErrorText, staysPrivateLine, unreadLine, wordsLine } from './make-repo-public'

const census = (c: Partial<MakePublicCensus> = {}): MakePublicCensus => ({
  issues: 0,
  prs: 0,
  comments: 0,
  reviews: 0,
  revisions: 0,
  hidden: 0,
  botRequests: 0,
  releases: 0,
  letters: 0,
  unread: 0,
  authors: [],
  imported: [],
  ...c,
})
const r = (name: string) => ({ name, oid: '0'.repeat(40) })

describe('everythingCounts', () => {
  it('lists the non-zero counts in dg everything_counts order, imported authors last, and not private-era releases (they stay hidden)', () => {
    const check = {
      census: census({ issues: 180, comments: 1, revisions: 2, releases: 3, botRequests: 1, imported: [{ host: 'github.com', author: 'x' }, { host: 'gitlab.com', author: 'y' }, { host: 'github.com', author: 'z' }] }),
      allRefs: [r('refs/heads/main')],
      deleted: 2,
      forced: 1,
    }
    expect(everythingCounts(check)).toBe(
      '180 issues, 1 comment, 2 earlier edits, 1 live branch or tag, 2 deleted branches, 1 force-push, 1 request sent to bots, imported posts by 3 people from github.com, gitlab.com',
    )
    expect(everythingCounts({ census: null, allRefs: [], deleted: 0, forced: 0 })).toBe('nothing written yet')
  })

  it('says who wrote it and what it could not count', () => {
    expect(wordsLine({ census: census({ authors: ['a'] }), former: [] })).toBe('Words by 1 person become public.')
    expect(wordsLine({ census: census({ authors: ['a', 'b'] }), former: ['b'] })).toBe('Words by 2 people, including 1 former member, become public.')
    expect(wordsLine({ census: census(), former: [] })).toBeNull()
    expect(unreadLine({ census: census({ unread: 2 }) })).toBe("2 posts you can't read yourself aren't counted.")
  })
})

describe('what stays private and the branches offered', () => {
  it('names branches only some members can read only when there are some', () => {
    expect(staysPrivateLine({ census: census({ letters: 1 }), environments: 0, narrowerBranches: 0 })).toBe(
      'Stays private: 1 message to specific people, 0 environments, and everything members write from now on.',
    )
    expect(staysPrivateLine({ census: null, environments: 2, narrowerBranches: 1 })).toBe(
      'Stays private: 0 messages to specific people, 2 environments, 1 branch only some members can read, and everything members write from now on.',
    )
  })

  it('groups the default branch with its tags, then other branches before tags', () => {
    const all = [r('refs/heads/a'), r('refs/heads/main'), r('refs/tags/old'), r('refs/tags/v1')]
    const c = refChoices(all, [r('refs/heads/main'), r('refs/tags/v1')], 'main')
    expect(c.branch?.name).toBe('refs/heads/main')
    expect(c.tags.map((t) => t.name)).toEqual(['refs/tags/v1'])
    expect(c.others.map((t) => t.name)).toEqual(['refs/heads/a', 'refs/tags/old'])
    expect(othersLabel(c.others)).toBe('1 other branch and 1 tag')
    expect(othersLabel([r('refs/heads/a'), r('refs/heads/b')])).toBe('2 other branches')
  })

  it('says which branches were not published, and why', () => {
    expect(notPublishedLine([])).toBeNull()
    expect(notPublishedLine(['refs/heads/x', 'refs/heads/y'])).toBe('Not published: x, y: members-only commits were pushed to them after the repo was made public.')
  })
})

describe('runErrorText (L6)', () => {
  const BANNED = /\b(epochs?|anchors?|sealed|lanes?|named|restricted|reveal|wraps?|key letters?|disclosures?|grants?)\b/i

  it("says the rotation's membership errors in plain words", () => {
    expect(runErrorText(new PrivateMembersError('another maintainer rotated to epoch 5 first', 'E310', 'lost'))).toBe(RUN_ERRORS.keyRace)
    expect(runErrorText(new PrivateMembersError('rotation preempted at epoch 5', 'E310', 'preempted'))).toBe(RUN_ERRORS.keyRace)
    expect(runErrorText(new PrivateMembersError('the anchor of epoch 4 does not carry the key you wrapped', 'E310', 'mismatch'))).toBe(RUN_ERRORS.keyUnfinished)
    expect(runErrorText(new PrivateMembersError('the anchor of epoch 4 is not visible yet', 'E310'))).toBe(RUN_ERRORS.keyUnfinished)
    expect(runErrorText(new PrivateMembersError('your identity has no usable encryption key', 'E306'))).toBe(RUN_ERRORS.noEncryptionKey)
    expect(runErrorText(new PrivateMembersError("you can't read epoch 3", 'E307'))).toBe(COPY.notKeyHolder)
    expect(runErrorText(new MembersUnsettledError('the member list is still changing on Platform'))).toBe(RUN_ERRORS.membersChanging)
  })

  it("keeps the run's own refusals, and a raw reason only without internal words", () => {
    expect(runErrorText(new MakePublicError(COPY.sealOffPassed('everything'), 'E310'))).toBe(COPY.sealOffPassed('everything'))
    expect(runErrorText(new Error('a node timed out\nat stack'))).toBe("That step didn't finish: a node timed out")
    expect(runErrorText(new Error('a node timed out'), "The check didn't finish")).toBe("The check didn't finish: a node timed out")
    for (const raw of ['key epoch 7 needs burning too', 'the anchor is missing', 'sealed artifact: noKey', 'the lane is closed', 'wrap not found', 'E310 something']) {
      const said = runErrorText(new Error(raw))
      expect(said).toBe("That step didn't finish. Try again.")
      expect(said).not.toMatch(BANNED)
    }
    expect(runErrorText(undefined)).toBe("That step didn't finish. Try again.")
    expect(runErrorText(new Error('x'.repeat(400))).length).toBeLessThan(200)
  })

  it('every fixed message is free of internal words', () => {
    for (const m of [...Object.values(RUN_ERRORS), COPY.lagging, COPY.sealOffPassed('everything'), COPY.sealOffPassed('codeOnly'), COPY.startOver(Date.UTC(2026, 9, 1), 'everything'), COPY.startOver(null, 'codeOnly'), COPY.boundaryKept, COPY.sayRefs]) expect(m).not.toMatch(BANNED)
  })
})


describe('Everything and releases (MIXE-12)', () => {
  it('does not list releases among what becomes public, and says private-era ones stay hidden', () => {
    expect(EVERYTHING_TEXT).not.toMatch(/releases/)
    expect(EVERYTHING_RELEASES).toBe('Releases made while the repo was private stay hidden.')
  })
})
