/**
 * The inbox and messages to specific people (DESIGN D14, §2.2): counted, never opened. A member's
 * message notifies with how many people it went to and no title or text; a stranger's makes no
 * item, as a stranger's members-only post.
 */

import { describe, expect, it } from 'vitest'

import { bytesToBase64 } from '../sdk'
import { audienceOf, letterRecipients, toItems, type ThreadSub } from './inbox'

const ME = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MEMBER = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const STRANGER = '57d7EsKBtYT3HnFyyhrvURGsvMzMcFDbeQ3o66u8eRju'
const REPO = { id: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ME, name: 'demo', private: false }
const PRIVATE = { ...REPO, private: true }

/** A v0x04 `enc` to `n` people (the framing's length, filler after the head). */
const letter = (n: number): Uint8Array => Uint8Array.from({ length: 66 + 64 * n + 64 }, (_, i) => (i === 0 ? 4 : i === 1 ? n : (i * 37) % 251))

const thread = (over: Partial<ThreadSub> = {}): ThreadSub => ({
  id: 'CR1u2SvFB97NvTF5zoqtYjjP4t2M5PyKEgFqPkKVThZP',
  kind: 'issue',
  number: 12,
  title: 'Public issue one',
  repo: REPO,
  reason: 'author',
  since: 0,
  ...over,
})

let n = 0
const doc = (owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ $id: `d${++n}`, $ownerId: owner, $createdAt: 1000 + n, vis: 'public', epoch: 0, ...extra })

describe('the inbox and messages to specific people', () => {
  it('reads the public recipient count, from bytes or base64', () => {
    expect(letterRecipients(letter(3))).toBe(3)
    expect(letterRecipients(bytesToBase64(letter(1)))).toBe(1)
    expect(letterRecipients(Uint8Array.of(3, 3, 3))).toBeNull()
    expect(letterRecipients(undefined)).toBeNull()
    expect(audienceOf(REPO, { enc: letter(2), asMember: MEMBER, $ownerId: MEMBER })).toBe('letter')
    expect(audienceOf(REPO, { enc: letter(2), $ownerId: STRANGER })).toBe('stranger')
    // a private repo's member writes one too
    expect(audienceOf(PRIVATE, { enc: letter(2), asMember: MEMBER, $ownerId: MEMBER })).toBe('letter')
  })

  it("makes a count-only item of a member's comment, and none of a stranger's", () => {
    const t = thread()
    const items = toItems({ kind: 'comments', thread: t }, [doc(MEMBER, { targetId: t.id, enc: letter(3), asMember: MEMBER }), doc(STRANGER, { targetId: t.id, enc: letter(2) })], ME)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'comment', actor: MEMBER, what: 'sent a comment to 3 people', target: { kind: 'issue', number: 12, title: 'Public issue one' } })
    expect(items[0]?.reason).toBeUndefined()
  })

  it("says a review's public verdict and how many it went to", () => {
    const t = thread({ kind: 'pull', number: 2, title: 'Add sub()' })
    const items = toItems(
      { kind: 'reviews', thread: t },
      [
        doc(MEMBER, { patchId: t.id, verdict: 1, enc: letter(2), asMember: MEMBER }),
        doc(MEMBER, { patchId: t.id, verdict: 3, enc: letter(1), asMember: MEMBER }),
        doc(STRANGER, { patchId: t.id, verdict: 3, enc: letter(2) }),
      ],
      ME,
    )
    expect(items.map((i) => i.what)).toEqual(['approved in a review to 2 people', 'sent a review to 1 person'])
  })

  it("gives a member's issue its numbered row without its title, and a stranger's none", () => {
    const items = toItems(
      { kind: 'new', type: 'issue', repo: REPO },
      [doc(MEMBER, { repoId: REPO.id, number: 3, enc: letter(4), asMember: MEMBER }), doc(STRANGER, { repoId: REPO.id, number: 5, enc: letter(2) })],
      ME,
    )
    expect(items.map((i) => [i.target?.number, i.target?.title, i.what])).toEqual([[3, 'Issue to 4 people', 'opened an issue for 4 people']])
    const [pull] = toItems({ kind: 'new', type: 'patch', repo: PRIVATE }, [doc(MEMBER, { repoId: REPO.id, number: 4, enc: letter(2), asMember: MEMBER, vis: 'private' })], ME)
    expect(pull).toMatchObject({ what: 'opened a pull request for 2 people', target: { title: 'Pull request to 2 people' } })
  })
})
